import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { Backup, BackupAssetInput, RequestedBy } from "../shared/types";
import { config } from "./config";
import type { Store } from "./db";
import type { CaptureEngine } from "./engine";
import type { PluginManager } from "./plugins";
import { downloadWechatVideos, injectVideoPlayers, type WechatVideo } from "./wechat";

function messageOf(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  return message.trim().slice(0, 1200) || "备份失败，原因未知";
}

function linkDirectory(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      linkDirectory(from, to);
    } else {
      try {
        linkSync(from, to);
      } catch {
        copyFileSync(from, to);
      }
    }
  }
}

function totalVideoBytes(videos: WechatVideo[]): number {
  return videos.reduce((sum, video) => sum + video.size, 0);
}

function moveDirectory(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  try {
    renameSync(source, target);
  } catch {
    linkDirectory(source, target);
    rmSync(source, { recursive: true, force: true });
  }
}

export class BackupQueue {
  private store: Store;
  private engine: CaptureEngine;
  private plugins: PluginManager;
  private stopped = false;
  private waiter: (() => void) | null = null;
  private currentBackupId: number | null = null;

  constructor(store: Store, engine: CaptureEngine, plugins: PluginManager) {
    this.store = store;
    this.engine = engine;
    this.plugins = plugins;
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
    const tempAssetsDir = join(config.tmpDir, `backup-${job.id}-assets`);
    const finalPath = join(config.archiveDir, `${job.id}.html`);
    const finalAssetsDir = join(config.archiveDir, String(job.id));
    try {
      rmSync(tempPath, { force: true });
      rmSync(tempAssetsDir, { recursive: true, force: true });
      rmSync(finalPath, { force: true });
      rmSync(finalAssetsDir, { recursive: true, force: true });
      console.error(`[queue] capturing ${job.bookmarkUrl} (backup ${job.id})`);
      const result = await this.engine.capture(job.bookmarkUrl, tempPath);

      let html: string | null = null;
      const getHtml = (): string => (html ??= readFileSync(tempPath, "utf8"));
      const setHtml = (next: string): void => {
        if (next === getHtml()) return;
        writeFileSync(tempPath, next, "utf8");
        html = next;
        const bytes = Buffer.from(next, "utf8");
        result.sha256 = createHash("sha256").update(bytes).digest("hex");
        result.size = bytes.length;
      };

      // WeChat videos are separate MP4 assets. Download them while the page
      // HTML is still in tmp, then point the archived player at local files.
      let downloadedVideos: WechatVideo[] = [];
      if (result.videos.length > 0) {
        const videoStartedAt = Date.now();
        downloadedVideos = await downloadWechatVideos(
          result.videos,
          join(tempAssetsDir, "videos"),
          (message) => console.error(`[queue] ${message}`),
        );
        const injected = injectVideoPlayers(getHtml(), downloadedVideos);
        if (injected !== getHtml()) {
          setHtml(injected);
        } else if (downloadedVideos.length > 0) {
          // The article advertised videos, but this snapshot has no matching
          // player placeholder. Keep the page; drop the now-unreferenced files.
          downloadedVideos = [];
        }
        if (downloadedVideos.length > 0) {
          const seconds = ((Date.now() - videoStartedAt) / 1000).toFixed(1);
          console.error(
            `[queue] saved ${downloadedVideos.length}/${result.videos.length} videos ` +
              `(${(totalVideoBytes(downloadedVideos) / 1024 / 1024).toFixed(1)} MB, ${seconds}s)`,
          );
        } else {
          rmSync(tempAssetsDir, { recursive: true, force: true });
        }
      }

      let pluginAssets: BackupAssetInput[] = [];
      if (this.plugins.hasFor(job.bookmarkUrl)) {
        const pluginStartedAt = Date.now();
        const pluginRun = await this.plugins.run({
          url: job.bookmarkUrl,
          title: result.title,
          html: getHtml(),
          backupId: job.id,
          assetsDir: join(tempAssetsDir, "plugins"),
          log: (message) => console.error(`[queue] ${message}`),
        });
        setHtml(pluginRun.html);
        pluginAssets = pluginRun.assets;
        if (pluginAssets.length > 0) {
          const seconds = ((Date.now() - pluginStartedAt) / 1000).toFixed(1);
          console.error(`[queue] plugins saved ${pluginAssets.length} files (${seconds}s)`);
        }
      }

      const previous = this.store.latestSuccessfulBackup(job.bookmarkId);
      const identical = Boolean(previous?.sha256 && previous.sha256 === result.sha256);

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

      if (downloadedVideos.length > 0) {
        const previousVideosDir = previous?.id
          ? join(config.archiveDir, String(previous.id), "videos")
          : "";
        const canReuseVideos =
          identical && Boolean(previousVideosDir) && existsSync(previousVideosDir);
        if (canReuseVideos) {
          linkDirectory(previousVideosDir, join(finalAssetsDir, "videos"));
          rmSync(join(tempAssetsDir, "videos"), { recursive: true, force: true });
        } else {
          moveDirectory(join(tempAssetsDir, "videos"), join(finalAssetsDir, "videos"));
        }
      }
      if (pluginAssets.length > 0) {
        moveDirectory(join(tempAssetsDir, "plugins"), join(finalAssetsDir, "plugins"));
      }
      rmSync(tempAssetsDir, { recursive: true, force: true });

      result.durationMs = Date.now() - startedAt;
      const finished = this.store.finishSuccess(job.id, {
        title: result.title,
        excerpt: result.excerpt,
        size: result.size,
        sha256: result.sha256,
        path: finalPath,
        durationMs: result.durationMs,
        sameAsPrevious: identical,
        assets: pluginAssets,
      });
      if (!finished.backup) {
        rmSync(finalPath, { force: true });
        rmSync(finalAssetsDir, { recursive: true, force: true });
        console.error(`[queue] bookmark ${job.bookmarkId} disappeared during capture; archive discarded`);
      } else {
        console.error(
          `[queue] saved ${job.bookmarkId} in ${(result.durationMs / 1000).toFixed(1)}s (${(result.size / 1024).toFixed(0)} KB)${identical ? " — unchanged" : ""}`,
        );
      }
    } catch (error) {
      rmSync(tempPath, { force: true });
      rmSync(tempAssetsDir, { recursive: true, force: true });
      rmSync(finalPath, { force: true });
      rmSync(finalAssetsDir, { recursive: true, force: true });
      const message = messageOf(error);
      this.store.finishFailure(job.id, message, Date.now() - startedAt);
      console.error(`[queue] failed ${job.bookmarkUrl}: ${message.split("\n")[0]}`);
    } finally {
      rmSync(tempAssetsDir, { recursive: true, force: true });
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
