import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { config } from "./config";
import { Store } from "./db";
import { CaptureEngine } from "./engine";
import { BackupQueue } from "./queue";
import { createApi } from "./api";
import { sanitizeFilename } from "./util";

const store = new Store(config.dbPath);
store.markInterrupted();

const engine = new CaptureEngine(store);
const queue = new BackupQueue(store, engine);
const api = createApi({ store, engine, queue });

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
  try {
    frameSources.add(new URL(config.archiveBaseUrl).origin);
  } catch {
    // ignore malformed origin
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
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
  if (!existsSync(distDir)) return developmentPage();
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
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
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return api.fetch(request);
    }
    return serveUi(request);
  },
});

const archiveServer = Bun.serve({
  hostname: config.archiveHost,
  port: config.archivePort,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
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
console.log(`  界面与接口   http://${config.publicHost}:${config.port}`);
console.log(`  备份站点     ${config.archiveBaseUrl}`);
console.log(`  数据目录     ${config.dataDir}`);
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
