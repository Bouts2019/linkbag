import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  Activity,
  Backup,
  Health,
  Settings,
  Stats,
} from "../shared/types";
import { config } from "./config";
import type { Store } from "./db";
import type { BackupQueue } from "./queue";
import type { CaptureEngine } from "./engine";
import type { PluginManager } from "./plugins";
import { subscribe } from "./events";
import { clampText, normalizeUrl, parseInterval } from "./util";

type Deps = {
  store: Store;
  engine: CaptureEngine;
  queue: BackupQueue;
  plugins: PluginManager;
};

function isAllowedOrigin(origin: string | undefined, selfOrigin: string | null): boolean {
  if (!origin) return true;
  if (origin === selfOrigin) return true;
  // The configured public API origin is trusted even when a reverse proxy
  // makes the request URL look like an internal http://host:port address.
  try {
    if (origin === new URL(config.apiBaseUrl).origin) return true;
  } catch {
    // ignore malformed API origin
  }
  if (/^chrome-extension:\/\/[a-z0-9]+$/i.test(origin)) return true;
  if (/^moz-extension:\/\/[a-z0-9-]+$/i.test(origin)) return true;
  // Only the Vite dev server is trusted in addition to the UI origin. The
  // archive port is deliberately not allowed: archived pages execute their
  // own scripts and must not be able to mutate the library.
  const extra = (process.env.LINKBAG_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.port === "5173"
    );
  } catch {
    return false;
  }
}

function healthOf({ store, engine, queue }: Deps): Health {
  const stats = store.stats(engine.state);
  return {
    ok: true,
    version: config.version,
    startedAt: config.startedAt,
    uptimeMs: Date.now() - config.startedAt,
    archiveBaseUrl: config.archiveBaseUrl,
    apiBaseUrl: config.apiBaseUrl,
    dataDir: config.dataDir,
    envFile: config.envFile,
    envFileLoaded: config.envFileLoaded,
    chromePath: config.chromePath,
    browserState: config.chromePath ? engine.state : "error",
    browserLastError: config.chromePath ? engine.lastError : "未找到 Chrome 或 Edge",
    queueLength: stats.queue,
    running: queue.activeBackupId !== null,
    port: config.port,
    archivePort: config.archivePort,
  };
}

function statsOf({ store, engine }: Deps): Stats {
  return store.stats(engine.state);
}

function parseSource(value: unknown): "manual" | "extension" {
  return value === "extension" ? "extension" : "manual";
}

async function readBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function createApi(deps: Deps): Hono {
  const { store, engine, queue, plugins } = deps;
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("Origin");
    const self = (() => {
      try {
        return new URL(c.req.url).origin;
      } catch {
        return null;
      }
    })();
    const allowed = isAllowedOrigin(origin, self);
    if (origin && allowed) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "false");
      c.header("Vary", "Origin");
    }
    c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, X-LinkBag, X-LinkBag-Source");
    c.header("Access-Control-Max-Age", "86400");
    c.header("X-Content-Type-Options", "nosniff");

    if (c.req.method === "OPTIONS") {
      if (!allowed) return c.text("Origin not allowed", 403);
      return c.body(null, 204);
    }
    if (!allowed) return c.text("Origin not allowed", 403);
    const writes = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (writes) {
      if (c.req.header("X-LinkBag") !== "1") {
        return c.json({ error: { code: "missing_header", message: "缺少 X-LinkBag 请求头" } }, 403);
      }
    }
    await next();
  });

  app.get("/api/health", (c) => c.json(healthOf(deps)));

  app.get("/api/bookmarks", (c) => {
    const search = c.req.query("q") ?? "";
    return c.json({
      bookmarks: store.listBookmarks(search),
      stats: statsOf(deps),
    });
  });

  app.post("/api/bookmarks", async (c) => {
    const body = await readBody<{ url?: unknown; title?: unknown; intervalMinutes?: unknown; source?: unknown }>(c.req.raw);
    if (!body || typeof body.url !== "string") {
      return c.json({ error: { code: "invalid_url", message: "请提供一个网页地址" } }, 400);
    }
    const url = normalizeUrl(body.url);
    if (!url) {
      return c.json({ error: { code: "invalid_url", message: "这个地址无法识别，请检查后重试" } }, 400);
    }
    const interval = parseInterval(body.intervalMinutes);
    if (body.intervalMinutes !== undefined && interval === undefined) {
      return c.json({ error: { code: "invalid_interval", message: "备份间隔必须为 0 或至少 15 分钟" } }, 400);
    }
    const title = clampText(body.title, 500);
    const { bookmark, created } = store.createBookmark(url, title, interval ?? null);
    const source = parseSource(body.source) === "extension" ? "extension" : "manual";
    const backup = queue.enqueue(bookmark.id, created ? "initial" : source);
    return c.json({ bookmark: store.findById(bookmark.id) ?? bookmark, backup, created }, created ? 201 : 200);
  });

  app.get("/api/bookmarks/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: { code: "not_found", message: "找不到这份收藏" } }, 404);
    }
    const bookmark = store.findById(id);
    if (!bookmark) return c.json({ error: { code: "not_found", message: "找不到这份收藏" } }, 404);
    return c.json({ bookmark, backups: store.listBackups(id) });
  });

  app.patch("/api/bookmarks/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: { code: "not_found", message: "找不到这份收藏" } }, 404);
    }
    const body = await readBody<{ title?: unknown; intervalMinutes?: unknown; enabled?: unknown }>(c.req.raw);
    if (!body) return c.json({ error: { code: "invalid_body", message: "请求内容无效" } }, 400);
    const patch: { title?: string; intervalMinutes?: number | null; enabled?: boolean } = {};
    if (typeof body.title === "string") patch.title = clampText(body.title, 500);
    if (body.intervalMinutes !== undefined) {
      const interval = parseInterval(body.intervalMinutes);
      if (interval === undefined) {
        return c.json({ error: { code: "invalid_interval", message: "备份间隔必须为 0 或至少 15 分钟" } }, 400);
      }
      patch.intervalMinutes = interval;
    }
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (Object.keys(patch).length === 0) {
      return c.json({ error: { code: "empty_patch", message: "没有要修改的内容" } }, 400);
    }
    const bookmark = store.updateBookmark(id, patch);
    if (!bookmark) return c.json({ error: { code: "not_found", message: "找不到这份收藏" } }, 404);
    queue.wake();
    return c.json({ bookmark });
  });

  app.delete("/api/bookmarks/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: { code: "not_found", message: "找不到这份收藏" } }, 404);
    }
    if (!store.findById(id)) return c.json({ error: { code: "not_found", message: "找不到这份收藏" } }, 404);
    if (!store.deleteBookmark(id)) {
      return c.json({ error: { code: "busy", message: "这份收藏正在备份，请稍后再删除" } }, 409);
    }
    return c.json({ ok: true });
  });

  app.post("/api/bookmarks/:id/backup", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: { code: "not_found", message: "找不到这份收藏" } }, 404);
    }
    if (!store.findById(id)) return c.json({ error: { code: "not_found", message: "找不到这份收藏" } }, 404);
    const body = (await readBody<{ source?: unknown }>(c.req.raw)) ?? {};
    const backup = queue.enqueue(id, parseSource(body.source) === "extension" ? "extension" : "manual");
    return c.json({ backup }, 202);
  });

  app.get("/api/bookmarks/:id/backups", (c) => {
    const id = Number(c.req.param("id"));
    if (!store.findById(id)) return c.json({ error: { code: "not_found", message: "找不到这份收藏" } }, 404);
    return c.json({ backups: store.listBackups(id) });
  });

  app.delete("/api/backups/:id", (c) => {
    const id = Number(c.req.param("id"));
    const backup = store.getBackup(id);
    if (!backup) return c.json({ error: { code: "not_found", message: "找不到这份快照" } }, 404);
    if (backup.status === "running") {
      return c.json({ error: { code: "busy", message: "这份快照正在生成，暂时不能删除" } }, 409);
    }
    if (!store.deleteBackup(id)) {
      return c.json({ error: { code: "failed", message: "删除失败" } }, 500);
    }
    return c.json({ ok: true });
  });

  app.get("/api/backups/:id/assets", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0 || !store.getBackup(id)) {
      return c.json({ error: { code: "not_found", message: "找不到这份快照" } }, 404);
    }
    return c.json({ assets: store.listBackupAssets(id) });
  });

  app.get("/api/plugins", (c) => c.json({ plugins: plugins.list() }));

  app.patch("/api/plugins/:id", async (c) => {
    const id = c.req.param("id");
    const body = await readBody<{ enabled?: unknown }>(c.req.raw);
    if (!body || typeof body.enabled !== "boolean") {
      return c.json({ error: { code: "invalid_body", message: "enabled 必须是布尔值" } }, 400);
    }
    if (!plugins.setEnabled(id, body.enabled)) {
      return c.json({ error: { code: "not_found", message: "找不到这个插件" } }, 404);
    }
    return c.json({ plugins: plugins.list() });
  });

  app.post("/api/plugins/reload", async (c) => {
    return c.json({ plugins: await plugins.reload() });
  });

  app.get("/api/activity", (c) => {
    const activity: Activity = store.activity();
    return c.json({ ...activity, stats: statsOf(deps) });
  });

  app.get("/api/settings", (c) => c.json({ settings: store.settings(), health: healthOf(deps) }));

  app.patch("/api/settings", async (c) => {
    const body = await readBody<Partial<Settings>>(c.req.raw);
    if (!body) return c.json({ error: { code: "invalid_body", message: "请求内容无效" } }, 400);
    const patch: Partial<Settings> = {};
    if (typeof body.autoBackupEnabled === "boolean") patch.autoBackupEnabled = body.autoBackupEnabled;
    if (body.defaultIntervalMinutes !== undefined) {
      const n = Number(body.defaultIntervalMinutes);
      if (!Number.isFinite(n) || n < 15) {
        return c.json({ error: { code: "invalid_interval", message: "默认间隔至少为 15 分钟" } }, 400);
      }
      patch.defaultIntervalMinutes = Math.floor(n);
    }
    if (body.retentionCount !== undefined) {
      const n = Number(body.retentionCount);
      if (!Number.isFinite(n) || n < 0) {
        return c.json({ error: { code: "invalid_retention", message: "保留数量不能小于 0" } }, 400);
      }
      patch.retentionCount = Math.floor(n);
    }
    if (body.browserIdleMinutes !== undefined) {
      const n = Number(body.browserIdleMinutes);
      if (!Number.isFinite(n) || n < 1 || n > 240) {
        return c.json({ error: { code: "invalid_idle", message: "空闲关闭时间需在 1 到 240 分钟之间" } }, 400);
      }
      patch.browserIdleMinutes = Math.floor(n);
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ error: { code: "empty_patch", message: "没有要修改的内容" } }, 400);
    }
    const settings = store.updateSettings(patch);
    queue.wake();
    return c.json({ settings, health: healthOf(deps) });
  });

  app.post("/api/actions/backup-all", (c) => {
    const queued = queue.runAll();
    return c.json({ ok: true, queued }, 202);
  });

  app.post("/api/actions/release-browser", async (c) => {
    if (queue.activeBackupId !== null) {
      return c.json({ error: { code: "busy", message: "正在备份，等这份快照完成后再释放浏览器" } }, 409);
    }
    await engine.release("manual");
    return c.json({ ok: true, health: healthOf(deps) });
  });

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ at: Date.now() }) });
      let closed = false;
      const unsubscribe = subscribe((event) => {
        if (closed) return;
        void stream.writeSSE({ event: "change", data: JSON.stringify(event) }).catch(() => {
          closed = true;
        });
      });
      const heartbeat = setInterval(() => {
        if (closed) return;
        void stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {
          closed = true;
        });
      }, 20_000);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        });
      });
    });
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "接口不存在" } }, 404));
  app.onError((error, c) => {
    console.error("[api]", error);
    return c.json({ error: { code: "internal", message: "服务出了点问题，请查看终端日志" } }, 500);
  });

  return app;
}
