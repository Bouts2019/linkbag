import { existsSync, linkSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Backup, RequestedBy } from "../shared/types";
import { config } from "./config";
import type { Store } from "./db";
import type { CaptureEngine } from "./engine";

function messageOf(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  return message.trim().slice(0, 1200) || "备份失败，原因未知";
}

export class BackupQueue {
  private store: Store;
  private engine: CaptureEngine;
  private stopped = false;
  private waiter: (() => void) | null = null;
  private currentBackupId: number | null = null;

  constructor(store: Store, engine: CaptureEngine) {
    this.store = store;
    this.engine = engine;
  }

  start(): void {
    void this.loop();
  }

  wake(): void {
    this.waiter?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
  }

  get activeBackupId(): number | null {
    return this.currentBackupId;
  }

  enqueue(bookmarkId: number, requestedBy: RequestedBy): Backup | null {
    const backup = this.store.enqueueBackup(bookmarkId, requestedBy);
    this.wake();
    return backup;
  }

  runAll(): number {
    const bookmarks = this.store.listBookmarks();
    let queued = 0;
    for (const bookmark of bookmarks) {
      if (!bookmark.enabled) continue;
      const before = bookmark.activeCount;
      this.store.enqueueBackup(bookmark.id, "manual");
      if (before === 0) queued++;
    }
    this.wake();
    return queued;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const settings = this.store.settings();
        if (settings.autoBackupEnabled) {
          for (const bookmark of this.store.dueBookmarks(8)) {
            this.store.enqueueBackup(bookmark.id, "scheduler");
          }
        }
        const job = this.store.nextQueuedBackup();
        if (!job) {
          await this.wait(8_000);
          continue;
        }
        await this.runJob(job);
      } catch (error) {
        console.error("[queue] unexpected error", error);
        await this.wait(5_000);
      }
    }
  }

  private async runJob(job: Backup): Promise<void> {
    if (this.stopped) return;
    const startedAt = Date.now();
    const running = this.store.startBackup(job.id);
    if (!running) return;
    this.currentBackupId = job.id;
    const tempPath = join(config.tmpDir, `backup-${job.id}.html`);
    try {
      rmSync(tempPath, { force: true });
      console.error(`[queue] capturing ${job.bookmarkUrl} (backup ${job.id})`);
      const result = await this.engine.capture(job.bookmarkUrl, tempPath);
      const previous = this.store.latestSuccessfulBackup(job.bookmarkId);
      const identical = Boolean(previous?.sha256 && previous.sha256 === result.sha256);
      const finalPath = join(config.archiveDir, `${job.id}.html`);

      if (identical && previous?.path && existsSync(previous.path)) {
        try {
          linkSync(previous.path, finalPath);
          rmSync(tempPath, { force: true });
        } catch {
          renameSync(tempPath, finalPath);
        }
      } else {
        renameSync(tempPath, finalPath);
      }

      const finished = this.store.finishSuccess(job.id, {
        title: result.title,
        excerpt: result.excerpt,
        size: result.size,
        sha256: result.sha256,
        path: finalPath,
        durationMs: result.durationMs,
        sameAsPrevious: identical,
      });
      if (!finished.backup) {
        rmSync(finalPath, { force: true });
        console.error(`[queue] bookmark ${job.bookmarkId} disappeared during capture; archive discarded`);
      } else {
        console.error(
          `[queue] saved ${job.bookmarkId} in ${(result.durationMs / 1000).toFixed(1)}s (${(result.size / 1024).toFixed(0)} KB)${identical ? " — unchanged" : ""}`,
        );
      }
    } catch (error) {
      rmSync(tempPath, { force: true });
      const message = messageOf(error);
      this.store.finishFailure(job.id, message, Date.now() - startedAt);
      console.error(`[queue] failed ${job.bookmarkUrl}: ${message.split("\n")[0]}`);
    } finally {
      this.currentBackupId = null;
      if (!this.stopped) this.engine.scheduleIdle();
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        if (this.waiter === wake) this.waiter = null;
        resolve();
      };
      const timer = setTimeout(() => {
        if (this.waiter === wake) this.waiter = null;
        resolve();
      }, ms);
      this.waiter = wake;
    });
  }
}
