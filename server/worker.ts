/**
 * Isolated capture worker.
 *
 * SingleFile's CLI API keeps a task list at module scope and skips a URL that
 * was already captured once in the same process. We drive its CDP backend
 * directly instead: the browser stays warm, every capture is independent, and
 * the parent can let the whole process die when the queue goes idle.
 *
 * Protocol: newline-delimited JSON on stdout. All library logs go to stderr.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { detectChallenge } from "./challenge.ts";
import { extractPageMeta } from "./util.ts";
import { extractWechatVideos, isWechatArticleUrl, type WechatVideo } from "./wechat.ts";

console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

type CaptureOptions = {
  browserExecutablePath: string;
  browserHeadless: boolean;
  browserWidth: number;
  browserHeight: number;
  browserWaitUntil: string;
  browserWaitUntilDelay: number;
  browserLoadMaxTime: number;
  browserCaptureMaxTime: number;
  loadDeferredContent: boolean;
  loadDeferredContentMaxIdleTime: number;
  blockVideos: boolean;
  compressHTML: boolean;
  removeHiddenElements: boolean;
  browserBypassCSP: boolean;
  userAgent: string;
  platform: string;
  acceptLanguage: string;
  httpHeaders: Record<string, string>;
};

// Headless Chromium advertises "HeadlessChrome" in Client Hints even when the
// User-Agent is overridden. Sites such as WeChat use that to serve a captcha
// page. Keep all browser hints consistent and recent enough to look ordinary.
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";
const DEFAULT_HTTP_HEADERS: Record<string, string> = {
  "sec-ch-ua": '"Chromium";v="156", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

type Request = {
  type: "capture";
  id: number;
  url: string;
  output: string;
};

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function parseOptions(): CaptureOptions {
  const raw = process.env.LINKBAG_CAPTURE_OPTIONS;
  if (!raw) throw new Error("Missing LINKBAG_CAPTURE_OPTIONS");
  const parsed = JSON.parse(raw) as Partial<CaptureOptions>;
  if (!parsed.browserExecutablePath) throw new Error("Chrome executable was not found");
  return {
    browserExecutablePath: parsed.browserExecutablePath,
    browserHeadless: true,
    browserWidth: parsed.browserWidth ?? 1440,
    browserHeight: parsed.browserHeight ?? 960,
    browserWaitUntil: parsed.browserWaitUntil ?? "networkIdle",
    browserWaitUntilDelay: parsed.browserWaitUntilDelay ?? 500,
    browserLoadMaxTime: parsed.browserLoadMaxTime ?? 45_000,
    browserCaptureMaxTime: parsed.browserCaptureMaxTime ?? 90_000,
    loadDeferredContent: parsed.loadDeferredContent ?? true,
    loadDeferredContentMaxIdleTime: parsed.loadDeferredContentMaxIdleTime ?? 1_000,
    blockVideos: parsed.blockVideos ?? true,
    compressHTML: parsed.compressHTML ?? true,
    removeHiddenElements: parsed.removeHiddenElements ?? true,
    browserBypassCSP: parsed.browserBypassCSP ?? true,
    userAgent: parsed.userAgent ?? DEFAULT_USER_AGENT,
    platform: parsed.platform ?? "Win32",
    acceptLanguage: parsed.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE,
    httpHeaders: parsed.httpHeaders ?? DEFAULT_HTTP_HEADERS,
  };
}

/**
 * SingleFile replaces the WeChat player iframe with its serialized DOM, which
 * no longer has the signed MP4 URLs. Fetch the article once more to read
 * `video_page_infos` and return the direct media URLs for the parent process.
 * This is best-effort: a video failure must not discard a good page snapshot.
 */
async function findWechatVideos(
  url: string,
  capturedHtml: string,
  options: CaptureOptions,
): Promise<WechatVideo[]> {
  if (!isWechatArticleUrl(url)) return [];
  if (!capturedHtml.includes("data-mpvid") && !capturedHtml.includes("video_iframe")) return [];

  const direct = extractWechatVideos(capturedHtml);
  if (direct.length > 0) return direct;

  try {
    const response = await fetch(url, {
      headers: {
        ...options.httpHeaders,
        "user-agent": options.userAgent,
        "accept-language": options.acceptLanguage,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      console.error(`[capture] video metadata request returned ${response.status}`);
      return [];
    }
    const videos = extractWechatVideos(await response.text());
    if (videos.length === 0) {
      console.error("[capture] WeChat page has video placeholders but no downloadable video metadata");
    }
    return videos;
  } catch (error) {
    console.error("[capture] video metadata request failed", error);
    return [];
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  const [{ initialize, getPageData, closeBrowser }, { getDefaultOptions }] = await Promise.all([
    import("single-file-cli/lib/cdp-client.js"),
    import("single-file-cli/options.js"),
  ]);

  const baseOptions: Record<string, unknown> = {
    ...(getDefaultOptions() as Record<string, unknown>),
    browserExecutablePath: options.browserExecutablePath,
    browserHeadless: true,
    browserWidth: options.browserWidth,
    browserHeight: options.browserHeight,
    browserWaitUntil: options.browserWaitUntil,
    browserWaitUntilDelay: options.browserWaitUntilDelay,
    browserLoadMaxTime: options.browserLoadMaxTime,
    browserCaptureMaxTime: options.browserCaptureMaxTime,
    loadDeferredContent: options.loadDeferredContent,
    loadDeferredContentMaxIdleTime: options.loadDeferredContentMaxIdleTime,
    blockVideos: options.blockVideos,
    compressHTML: options.compressHTML,
    removeHiddenElements: options.removeHiddenElements,
    browserBypassCSP: options.browserBypassCSP,
    userAgent: options.userAgent,
    platform: options.platform,
    acceptLanguage: options.acceptLanguage,
    httpHeaders: options.httpHeaders,
    removeSavedDate: true,
  };
  await initialize(baseOptions);
  send({ type: "ready" });
  console.error("[capture] browser ready");

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await Promise.race([
        closeBrowser(),
        new Promise((resolve) => setTimeout(resolve, 6_000)),
      ]);
    } catch (error) {
      console.error("[capture] shutdown error", error);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("uncaughtException", (error) => {
    console.error("[capture] uncaught", error);
    send({ type: "fatal", error: String(error?.stack ?? error) });
    void shutdown();
  });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Request | { type: "shutdown" };
    try {
      message = JSON.parse(line) as Request | { type: "shutdown" };
    } catch {
      send({ type: "fatal", error: "Invalid worker message" });
      continue;
    }
    if (message.type === "shutdown") {
      await shutdown();
      return;
    }
    if (message.type !== "capture") continue;

    const startedAt = Date.now();
    try {
      const pageData = (await getPageData({ ...baseOptions, url: message.url })) as {
        content?: string | Uint8Array;
        title?: string;
      } | null;
      if (!pageData?.content || pageData.content.length === 0) {
        throw new Error("SingleFile 没有生成快照，页面可能拒绝加载或超出了大小限制。");
      }

      let sha256: string;
      let size: number;
      let head: string;
      let capturedHtml: string;
      const needsVideoCheck = isWechatArticleUrl(message.url);
      if (typeof pageData.content === "string") {
        sha256 = createHash("sha256").update(pageData.content, "utf8").digest("hex");
        size = Buffer.byteLength(pageData.content, "utf8");
        head = pageData.content.slice(0, 512 * 1024);
        capturedHtml = needsVideoCheck ? pageData.content : head;
        writeFileSync(message.output, pageData.content, "utf8");
      } else {
        const bytes = Buffer.from(pageData.content);
        sha256 = createHash("sha256").update(bytes).digest("hex");
        size = bytes.length;
        head = bytes.subarray(0, 512 * 1024).toString("utf8");
        capturedHtml = needsVideoCheck ? bytes.toString("utf8") : head;
        writeFileSync(message.output, bytes);
      }
      const meta = extractPageMeta(head);
      const title = (pageData.title || meta.title || "").replace(/\s+/g, " ").trim().slice(0, 500);
      const challenge = detectChallenge(head, title || meta.title);
      if (challenge) {
        throw new Error(
          `目标站点返回了${challenge}页面，本次快照未保存。请确认页面能在浏览器中正常打开后重试。`,
        );
      }
      const videos = await findWechatVideos(message.url, capturedHtml, options);
      if (videos.length > 0) console.error(`[capture] found ${videos.length} WeChat videos`);
      send({
        type: "result",
        id: message.id,
        ok: true,
        title,
        excerpt: meta.excerpt,
        size,
        sha256,
        videos,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      send({
        type: "result",
        id: message.id,
        ok: false,
        error: String((error as Error)?.message ?? error),
        durationMs: Date.now() - startedAt,
      });
    }
  }

  await shutdown();
}

main().catch((error) => {
  send({ type: "fatal", error: String(error?.stack ?? error) });
  console.error("[capture] fatal", error);
  process.exit(1);
});
