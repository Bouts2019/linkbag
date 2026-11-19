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
import { extractPageMeta } from "./util.ts";

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
  };
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
      if (typeof pageData.content === "string") {
        sha256 = createHash("sha256").update(pageData.content, "utf8").digest("hex");
        size = Buffer.byteLength(pageData.content, "utf8");
        head = pageData.content.slice(0, 512 * 1024);
        writeFileSync(message.output, pageData.content, "utf8");
      } else {
        const bytes = Buffer.from(pageData.content);
        sha256 = createHash("sha256").update(bytes).digest("hex");
        size = bytes.length;
        head = bytes.subarray(0, 512 * 1024).toString("utf8");
        writeFileSync(message.output, bytes);
      }
      const meta = extractPageMeta(head);
      const title = (pageData.title || meta.title || "").replace(/\s+/g, " ").trim().slice(0, 500);
      send({
        type: "result",
        id: message.id,
        ok: true,
        title,
        excerpt: meta.excerpt,
        size,
        sha256,
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
