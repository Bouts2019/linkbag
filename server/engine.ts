import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrowserState } from "../shared/types";
import { config } from "./config";
import { publish } from "./events";
import type { Store } from "./db";
import type { WechatVideo } from "./wechat";

export type CaptureResult = {
  size: number;
  sha256: string;
  title: string;
  excerpt: string;
  durationMs: number;
  videos: WechatVideo[];
};

type WorkerMessage =
  | { type: "ready" }
  | {
      type: "result";
      id: number;
      ok: true;
      size: number;
      sha256: string;
      title: string;
      excerpt: string;
      durationMs: number;
      videos?: WechatVideo[];
    }
  | { type: "result"; id: number; ok: false; error: string; durationMs: number }
  | { type: "fatal"; error: string };

const READY_TIMEOUT_MS = 35_000;
const CAPTURE_TIMEOUT_MS = Number(process.env.LINKBAG_CAPTURE_TIMEOUT_MS) || 150_000;
const SHUTDOWN_GRACE_MS = 6_000;

type PipeIn = { write(data: string): unknown; flush?: () => unknown };
type PipeOut = ReadableStream<Uint8Array>;

export class CaptureEngine {
  state: BrowserState = "cold";
  lastError: string | null = null;

  private store: Store;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private pending: {
    id: number;
    resolve: (result: CaptureResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private stderrRing = "";
  private stopped = false;

  constructor(store: Store) {
    this.store = store;
  }

  async capture(url: string, output: string): Promise<CaptureResult> {
    if (this.stopped) throw new Error("Capture engine is shut down");
    await this.ensureReady();
    if (!this.proc) throw new Error("Capture browser is not available");
    if (this.pending) throw new Error("Capture engine is busy");
    this.clearIdle();

    const id = this.nextId++;
    return await new Promise<CaptureResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.state = "error";
        this.lastError = "备份超时，已结束本次任务";
        publish({ type: "browser" });
        this.kill();
        reject(new Error("备份超时，页面可能无法完成加载。"));
      }, CAPTURE_TIMEOUT_MS);
      this.pending = { id, resolve, reject, timer };
      const payload = JSON.stringify({ type: "capture", id, url, output });
      try {
        const stdin = this.proc?.stdin as unknown as PipeIn | null;
        stdin?.write(payload + "\n");
        stdin?.flush?.();
      } catch (error) {
        clearTimeout(timer);
        this.pending = null;
        reject(new Error(String((error as Error)?.message ?? error)));
      }
    }).finally(() => {
      if (this.proc && !this.stopped) this.scheduleIdle();
    });
  }

  scheduleIdle(): void {
    this.clearIdle();
    if (!this.proc || this.pending) return;
    const minutes = Math.max(1, this.store.settings().browserIdleMinutes);
    this.idleTimer = setTimeout(() => {
      void this.release("idle");
    }, minutes * 60_000);
  }

  async release(reason: "idle" | "manual" = "manual"): Promise<void> {
    this.clearIdle();
    if (!this.proc) {
      this.state = "cold";
      return;
    }
    this.state = "cold";
    this.closing = true;
    const proc = this.proc;
    this.proc = null;
    this.readyPromise = null;
    this.rejectPending(new Error("浏览器已释放"));
    try {
      const stdin = proc.stdin as unknown as PipeIn | null;
      stdin?.write(JSON.stringify({ type: "shutdown" }) + "\n");
      stdin?.flush?.();
    } catch {
      // pipe already gone
    }
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)),
    ]);
    if (!exited) {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }
    this.closing = false;
    if (reason === "manual") console.error("[capture] browser released");
    publish({ type: "browser" });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearIdle();
    await this.release("manual");
  }

  private async ensureReady(): Promise<void> {
    if (this.proc && this.readyPromise) {
      if (this.state === "error") {
        this.kill();
      } else {
        await this.readyPromise;
        return;
      }
    }
    if (this.stopped) throw new Error("Capture engine is shut down");
    if (!config.chromePath) {
      this.state = "error";
      this.lastError = "未找到 Chrome 或 Edge。安装浏览器，或设置 LINKBAG_CHROME_PATH。";
      publish({ type: "browser" });
      throw new Error(this.lastError);
    }
    this.spawn();
    if (this.readyPromise) await this.readyPromise;
  }

  private spawn(): void {
    this.state = "starting";
    this.lastError = null;
    this.stderrRing = "";
    publish({ type: "browser" });
    const workerPath = join(import.meta.dir, "worker.ts");
    if (!existsSync(workerPath)) {
      this.state = "error";
      this.lastError = "找不到抓取进程脚本";
      throw new Error(this.lastError);
    }
    const options = {
      browserExecutablePath: config.chromePath,
      browserHeadless: true,
      browserWidth: 1440,
      browserHeight: 960,
      browserWaitUntil: "networkIdle",
      browserWaitUntilDelay: 500,
      browserLoadMaxTime: 45_000,
      browserCaptureMaxTime: 90_000,
      loadDeferredContent: true,
      loadDeferredContentMaxIdleTime: 1_000,
      blockVideos: true,
      compressHTML: true,
      removeHiddenElements: true,
      browserBypassCSP: true,
      maxParallelWorkers: 1,
    };
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn({
        cmd: [process.execPath, workerPath],
        cwd: config.root,
        env: {
          ...process.env,
          LINKBAG_CAPTURE_OPTIONS: JSON.stringify(options),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      this.state = "error";
      this.lastError = `无法启动抓取进程：${String((error as Error)?.message ?? error)}`;
      publish({ type: "browser" });
      throw new Error(this.lastError);
    }
    this.proc = proc;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      const timeout = setTimeout(() => {
        this.lastError = "浏览器启动超时";
        this.state = "error";
        publish({ type: "browser" });
        reject(new Error(this.lastError));
        this.kill();
      }, READY_TIMEOUT_MS);
      const done = () => clearTimeout(timeout);
      const wrapResolve = () => {
        done();
        resolve();
      };
      const wrapReject = (error: Error) => {
        done();
        reject(error);
      };
      this.resolveReady = wrapResolve;
      this.rejectReady = wrapReject;
    });

    void this.pumpStdout(proc);
    void this.pumpStderr(proc);
    void proc.exited.then((code) => {
      const wasCurrent = this.proc === proc;
      if (wasCurrent) {
        this.proc = null;
        this.readyPromise = null;
      }
      this.rejectPending(new Error(this.lastError || `抓取进程退出（code ${code}）`));
      if (wasCurrent && !this.closing) {
        this.state = "error";
        if (!this.lastError) this.lastError = `抓取进程异常退出（code ${code}）`;
        publish({ type: "browser" });
      }
    });
  }

  private async pumpStdout(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stdout = proc.stdout as unknown as PipeOut | null;
    if (!stdout) return;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.handleMessage(line);
          newline = buffer.indexOf("\n");
        }
      }
    } catch {
      // stream closed with the process
    }
  }

  private async pumpStderr(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stderr = proc.stderr as unknown as PipeOut | null;
    if (!stderr) return;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.stderrRing = (this.stderrRing + text).slice(-8000);
        if (process.env.LINKBAG_DEBUG === "1") process.stderr.write(text);
      }
    } catch {
      // stream closed
    }
  }

  private handleMessage(line: string): void {
    let message: WorkerMessage;
    try {
      message = JSON.parse(line) as WorkerMessage;
    } catch {
      return;
    }
    if (message.type === "ready") {
      this.state = "warm";
      this.lastError = null;
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      publish({ type: "browser" });
      return;
    }
    if (message.type === "fatal") {
      this.lastError = message.error.slice(0, 1200);
      this.state = "error";
      this.rejectReady?.(new Error(this.lastError));
      this.resolveReady = null;
      this.rejectReady = null;
      this.rejectPending(new Error(this.lastError));
      publish({ type: "browser" });
      this.kill();
      return;
    }
    if (message.type === "result") {
      const pending = this.pending;
      if (!pending || pending.id !== message.id) return;
      clearTimeout(pending.timer);
      this.pending = null;
      if (message.ok) {
        pending.resolve({
          size: message.size,
          sha256: message.sha256,
          title: message.title,
          excerpt: message.excerpt,
          durationMs: message.durationMs,
          videos: message.videos ?? [],
        });
      } else {
        const stderr = this.stderrRing.trim();
        if (stderr) console.error(`[capture] worker log\n${stderr.slice(-2000)}`);
        pending.reject(new Error(message.error));
      }
    }
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const pending = this.pending;
    this.pending = null;
    pending.reject(error);
  }

  private kill(): void {
    const proc = this.proc;
    this.proc = null;
    this.readyPromise = null;
    this.rejectPending(new Error(this.lastError || "抓取进程已结束"));
    if (proc) {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }
    for (const suffix of [".err"]) {
      try {
        rmSync(join(config.tmpDir, `worker${suffix}`), { force: true });
      } catch {
        // ignore
      }
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
