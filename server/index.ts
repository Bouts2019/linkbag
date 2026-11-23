import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { config } from "./config";
import { Store } from "./db";
import { CaptureEngine } from "./engine";
import { BackupQueue } from "./queue";
import { createApi } from "./api";
import { PluginManager } from "./plugins";
import { sanitizeFilename } from "./util";

const store = new Store(config.dbPath);
store.markInterrupted();

const engine = new CaptureEngine(store);
const plugins = new PluginManager(store);
await plugins.load();
const queue = new BackupQueue(store, engine, plugins);
const api = createApi({ store, engine, queue, plugins });

const distDir = join(config.root, "dist", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function uiCsp(): string {
  const frameSources = new Set(["'self'", "http://127.0.0.1:8788", "http://localhost:8788"]);
  const imageSources = new Set(["'self'", "data:", "blob:"]);
  const connectSources = new Set(["'self'"]);
  try {
    const origin = new URL(config.archiveBaseUrl).origin;
    frameSources.add(origin);
    // Plugin assets (for example WeChat covers) are served from the archive
    // origin, so the UI needs to be allowed to render them as images.
    imageSources.add(origin);
  } catch {
    // ignore malformed origin
  }
  try {
    // The console may be served from a different origin than the API (for
    // example console on linkbag.example.com, API on api.example.com).
    connectSources.add(new URL(config.apiBaseUrl).origin);
  } catch {
    // ignore malformed origin
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${[...imageSources].join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${[...connectSources].join(" ")}`,
    `frame-src ${[...frameSources].join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

const uiHeaders = {
  "Content-Security-Policy": uiCsp(),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

function developmentPage(): Response {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>LinkBag</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#ECEDE6;color:#17201C;font-family:system-ui,"Microsoft YaHei",sans-serif}
main{max-width:520px;padding:40px;border:1px solid #17201C;background:#F7F7F2}h1{font-size:26px;margin:0 0 12px}
p{line-height:1.7;color:#4A524C}code{background:#E2E6D8;padding:2px 6px}a{color:#2D463B}</style></head>
<body><main><h1>LinkBag API 已启动</h1>
<p>前端开发服务器在 <a href="http://localhost:5173">http://localhost:5173</a>。生产界面请先运行 <code>bun run build</code>，再重启服务。</p>
<p>收藏接口：<code>${new URL("/api/health", "http://x").pathname}</code></p></main></body></html>`,
    { headers: { ...uiHeaders, "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function serveUi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  // Runtime UI configuration. The console calls the API at this address, so
  // it can live on a different origin (for example linkbag.* for pages and
  // api.*\/linkbag for JSON requests). The static public/config.js is only a
  // development fallback.
  if (pathname === "/config.js") {
    const body = `window.__LINKBAG_CONFIG__ = ${JSON.stringify({ apiBaseUrl: config.apiBaseUrl })};\n`;
    return new Response(body, {
      headers: {
        ...uiHeaders,
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
  if (!existsSync(distDir)) return developmentPage();
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  const candidate = resolve(distDir, "." + normalize(pathname));
  const distRoot = resolve(distDir);
  if (candidate !== distRoot && !candidate.startsWith(distRoot + "\\") && !candidate.startsWith(distRoot + "/")) {
    return new Response("Bad request", { status: 400 });
  }
  let filePath = candidate;
  if (!existsSync(filePath)) {
    if (extname(pathname)) return new Response("Not found", { status: 404 });
    filePath = join(distDir, "index.html");
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const immutable = pathname.startsWith("/assets/");
  return new Response(file, {
    headers: {
      ...uiHeaders,
      "Content-Type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  // SSE connections are idle between events; keep them alive past Bun's 10s default.
  idleTimeout: 30,
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = url.pathname;
    if (config.basePath) {
      if (pathname === config.basePath) {
        return Response.redirect(`${url.origin}${config.basePath}/${url.search}`, 308);
      }
      if (pathname.startsWith(`${config.basePath}/`)) {
        pathname = pathname.slice(config.basePath.length);
      }
    }
    let routed = request;
    if (pathname !== url.pathname) {
      const target = new URL(url);
      target.pathname = pathname;
      routed = new Request(target, request);
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return api.fetch(routed);
    }
    return serveUi(routed);
  },
});

function parseByteRange(value: string, size: number): { start: number; end: number } | "invalid" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return "invalid";
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  let end = endText === "" ? size - 1 : Number(endText);
  if (!Number.isInteger(start) || !Number.isInteger(end) || size === 0 || start >= size || start > end) {
    return "invalid";
  }
  end = Math.min(end, size - 1);
  return { start, end };
}

const PLUGIN_ASSET_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

async function serveArchiveAsset(
  request: Request,
  path: string,
  contentType: string,
  downloadName?: string,
): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const size = (await file.stat()).size;
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "Accept-Ranges": "bytes",
  });
  if (downloadName) {
    headers.set(
      "Content-Disposition",
      `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    );
  }

  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, size);
    if (range === "invalid") {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
      });
    }
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(request.method === "HEAD" ? null : file.slice(range.start, range.end + 1), {
      status: 206,
      headers,
    });
  }

  headers.set("Content-Length", String(size));
  return new Response(request.method === "HEAD" ? null : file, { headers });
}

const archiveServer = Bun.serve({
  hostname: config.archiveHost,
  port: config.archivePort,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
    const pluginMatch = url.pathname.match(
      /^\/a\/(\d+)\/plugins\/([a-z0-9][a-z0-9_-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._-]{0,120})$/,
    );
    if (pluginMatch?.[1] && pluginMatch[2] && pluginMatch[3]) {
      const id = Number(pluginMatch[1]);
      const meta = store.getArchiveMeta(id);
      if (!meta) return new Response("Not found", { status: 404 });
      const filename = pluginMatch[3];
      const filePath = join(dirname(meta.path), String(id), "plugins", pluginMatch[2], filename);
      const contentType = PLUGIN_ASSET_MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
      const downloadName = url.searchParams.get("download") === "1" ? filename : undefined;
      return serveArchiveAsset(request, filePath, contentType, downloadName);
    }

    const videoMatch = url.pathname.match(/^\/a\/(\d+)\/videos\/([A-Za-z0-9_-]+\.mp4)$/);
    if (videoMatch?.[1] && videoMatch[2]) {
      const id = Number(videoMatch[1]);
      const meta = store.getArchiveMeta(id);
      if (!meta) return new Response("Not found", { status: 404 });
      return serveArchiveAsset(
        request,
        join(dirname(meta.path), String(id), "videos", videoMatch[2]),
        "video/mp4",
      );
    }

    const match = url.pathname.match(/^\/a\/(\d+)$/);
    if (!match?.[1]) return new Response("Not found", { status: 404 });
    const id = Number(match[1]);
    const meta = store.getArchiveMeta(id);
    if (!meta) return new Response("Not found", { status: 404 });
    const file = Bun.file(meta.path);
    if (!(await file.exists())) return new Response("Archive file is missing", { status: 404 });

    const headers = new Headers({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    });
    if (url.searchParams.get("download") === "1") {
      const base = sanitizeFilename(meta.title || meta.bookmarkTitle || `linkbag-${id}`, `linkbag-${id}`);
      const filename = base.toLowerCase().endsWith(".html") ? base : `${base}.html`;
      headers.set(
        "Content-Disposition",
        `attachment; filename="linkbag-${id}.html"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
    }
    return new Response(file, { headers });
  },
});

queue.start();

console.log("");
console.log("  LinkBag  ·  网页备份室");
console.log(`  界面与接口   ${config.apiBaseUrl}`);
console.log(`  备份站点     ${config.archiveBaseUrl}`);
console.log(`  数据目录     ${config.dataDir}`);
console.log(`  配置文件     ${config.envFile}${config.envFileLoaded ? "" : "（未创建，使用环境默认值）"}`);
console.log(
  config.chromePath
    ? `  浏览器       ${config.chromePath}`
    : "  浏览器       未找到 Chrome/Edge，请设置 LINKBAG_CHROME_PATH",
);
console.log("");

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received, closing…`);
  try {
    await queue.stop();
    await engine.stop();
    archiveServer.stop();
    server.stop();
    store.close();
  } catch (error) {
    console.error("[server] shutdown error", error);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
