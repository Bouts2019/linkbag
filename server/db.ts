import { Database } from "bun:sqlite";
import { basename, dirname, join } from "node:path";
import { rmSync, unlinkSync } from "node:fs";
import type {
  Activity,
  Backup,
  BackupStatus,
  Bookmark,
  BrowserState,
  RequestedBy,
  Settings,
  Stats,
} from "../shared/types";
import { config } from "./config";
import { publish } from "./events";
import { accession, displayDomain, bookmarkKey } from "./util";

const DEFAULT_SETTINGS: Settings = {
  autoBackupEnabled: true,
  defaultIntervalMinutes: 1440,
  retentionCount: 30,
  browserIdleMinutes: 5,
};

type BookmarkRow = {
  id: number;
  url: string;
  normalized_url: string;
  title: string;
  excerpt: string;
  title_source: "auto" | "user";
  interval_minutes: number | null;
  enabled: number;
  last_backup_at: number | null;
  next_backup_at: number | null;
  last_status: BackupStatus | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  success_count?: number;
  failure_count?: number;
  active_count?: number;
};

type BackupRow = {
  id: number;
  bookmark_id: number;
  status: BackupStatus;
  title: string | null;
  size: number | null;
  sha256: string | null;
  path: string | null;
  duration_ms: number | null;
  error: string | null;
  requested_by: RequestedBy;
  same_as_previous: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  bookmark_title?: string;
  bookmark_url?: string;
  rn?: number;
};

type BookmarkPatch = {
  title?: string;
  intervalMinutes?: number | null;
  enabled?: boolean;
};

function now(): number {
  return Date.now();
}

function removeFile(path: string | null | undefined): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
  // A snapshot may have companion assets (for example WeChat videos) in a
  // sibling directory named after the backup id: archives/<id>/.
  if (/\.html$/i.test(path)) {
    try {
      rmSync(join(dirname(path), basename(path).replace(/\.html$/i, "")), {
        recursive: true,
        force: true,
      });
    } catch {
      // ignore missing or locked assets
    }
  }
}

export class Store {
  readonly db: Database;
  private settingsCache: Settings | null = null;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        normalized_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        excerpt TEXT NOT NULL DEFAULT '',
        title_source TEXT NOT NULL DEFAULT 'auto',
        interval_minutes INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_backup_at INTEGER,
        next_backup_at INTEGER,
        last_status TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bookmarks_next ON bookmarks(next_backup_at);
      CREATE INDEX IF NOT EXISTS idx_bookmarks_enabled ON bookmarks(enabled, next_backup_at);

      CREATE TABLE IF NOT EXISTS backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        title TEXT,
        size INTEGER,
        sha256 TEXT,
        path TEXT,
        duration_ms INTEGER,
        error TEXT,
        requested_by TEXT NOT NULL DEFAULT 'manual',
        same_as_previous INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_backups_bookmark ON backups(bookmark_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_backups_status ON backups(status, id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---------- settings ----------

  settings(): Settings {
    if (this.settingsCache) return this.settingsCache;
    const rows = this.db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const stored: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        stored[row.key] = JSON.parse(row.value);
      } catch {
        // ignore malformed value
      }
    }
    this.settingsCache = {
      autoBackupEnabled:
        typeof stored.autoBackupEnabled === "boolean" ? stored.autoBackupEnabled : DEFAULT_SETTINGS.autoBackupEnabled,
      defaultIntervalMinutes:
        typeof stored.defaultIntervalMinutes === "number" && stored.defaultIntervalMinutes >= 15
          ? stored.defaultIntervalMinutes
          : DEFAULT_SETTINGS.defaultIntervalMinutes,
      retentionCount:
        typeof stored.retentionCount === "number" && stored.retentionCount >= 0
          ? Math.floor(stored.retentionCount)
          : DEFAULT_SETTINGS.retentionCount,
      browserIdleMinutes:
        typeof stored.browserIdleMinutes === "number" && stored.browserIdleMinutes >= 1
          ? Math.floor(stored.browserIdleMinutes)
          : DEFAULT_SETTINGS.browserIdleMinutes,
    };
    return this.settingsCache;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const current = this.settings();
    const next: Settings = { ...current };
    if (typeof patch.autoBackupEnabled === "boolean") next.autoBackupEnabled = patch.autoBackupEnabled;
    if (typeof patch.defaultIntervalMinutes === "number" && patch.defaultIntervalMinutes >= 15) {
      next.defaultIntervalMinutes = Math.floor(patch.defaultIntervalMinutes);
    }
    if (typeof patch.retentionCount === "number" && patch.retentionCount >= 0) {
      next.retentionCount = Math.floor(patch.retentionCount);
    }
    if (typeof patch.browserIdleMinutes === "number" && patch.browserIdleMinutes >= 1) {
      next.browserIdleMinutes = Math.min(240, Math.floor(patch.browserIdleMinutes));
    }

    const insert = this.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const update = this.db.transaction(() => {
      for (const [key, value] of Object.entries(next)) {
        insert.run(key, JSON.stringify(value));
      }
      if (next.defaultIntervalMinutes !== current.defaultIntervalMinutes) {
        const rows = this.db
          .query("SELECT id, last_backup_at FROM bookmarks WHERE interval_minutes IS NULL")
          .all() as { id: number; last_backup_at: number | null }[];
        const updateNext = this.db.query("UPDATE bookmarks SET next_backup_at = ?, updated_at = ? WHERE id = ?");
        const stamp = now();
        for (const row of rows) {
          const base = row.last_backup_at ?? stamp;
          updateNext.run(base + next.defaultIntervalMinutes * 60_000, stamp, row.id);
        }
      }
    });
    update();
    this.settingsCache = next;
    publish({ type: "settings" });
    return next;
  }

  // ---------- bookmarks ----------

  findByKey(key: string): Bookmark | null {
    const row = this.db.query("SELECT * FROM bookmarks WHERE normalized_url = ?").get(key) as BookmarkRow | null;
    return row ? this.hydrateBookmark(row) : null;
  }

  findById(id: number): Bookmark | null {
    const row = this.db.query("SELECT * FROM bookmarks WHERE id = ?").get(id) as BookmarkRow | null;
    return row ? this.hydrateBookmark(row) : null;
  }

  listBookmarks(search = ""): Bookmark[] {
    const query = search.trim();
    const rows = query
      ? (this.db
          .query(
            `SELECT b.*,
              (SELECT COUNT(*) FROM backups x WHERE x.bookmark_id = b.id AND x.status = 'success') AS success_count,
              (SELECT COUNT(*) FROM backups x WHERE x.bookmark_id = b.id AND x.status = 'failed') AS failure_count,
              (SELECT COUNT(*) FROM backups x WHERE x.bookmark_id = b.id AND x.status IN ('queued','running')) AS active_count
            FROM bookmarks b
            WHERE b.title LIKE ? OR b.url LIKE ? OR b.excerpt LIKE ?
            ORDER BY b.id DESC`,
          )
          .all(`%${query}%`, `%${query}%`, `%${query}%`) as BookmarkRow[])
      : (this.db
          .query(
            `SELECT b.*,
              (SELECT COUNT(*) FROM backups x WHERE x.bookmark_id = b.id AND x.status = 'success') AS success_count,
              (SELECT COUNT(*) FROM backups x WHERE x.bookmark_id = b.id AND x.status = 'failed') AS failure_count,
              (SELECT COUNT(*) FROM backups x WHERE x.bookmark_id = b.id AND x.status IN ('queued','running')) AS active_count
            FROM bookmarks b
            ORDER BY b.id DESC`,
          )
          .all() as BookmarkRow[]);

    const recent = this.recentBackupsByBookmark(rows.map((row) => row.id), 12);
    return rows.map((row) => this.hydrateBookmark(row, recent.get(row.id) ?? []));
  }

  createBookmark(url: string, title = "", intervalMinutes: number | null = null): { bookmark: Bookmark; created: boolean } {
    const key = bookmarkKey(url);
    const existing = this.db.query("SELECT * FROM bookmarks WHERE normalized_url = ?").get(key) as BookmarkRow | null;
    if (existing) {
      return { bookmark: this.hydrateBookmark(existing), created: false };
    }
    const settings = this.settings();
    const stamp = now();
    const effective = intervalMinutes ?? settings.defaultIntervalMinutes;
    const nextBackupAt = effective > 0 ? stamp + effective * 60_000 : null;
    const result = this.db
      .query(
        `INSERT INTO bookmarks
          (url, normalized_url, title, excerpt, title_source, interval_minutes, enabled, next_backup_at, created_at, updated_at)
         VALUES (?, ?, ?, '', 'auto', ?, 1, ?, ?, ?)`,
      )
      .run(url, key, title.trim().slice(0, 500), intervalMinutes, nextBackupAt, stamp, stamp);
    const id = Number(result.lastInsertRowid);
    publish({ type: "bookmark", bookmarkId: id });
    const bookmark = this.findById(id);
    if (!bookmark) throw new Error("Failed to create bookmark");
    return { bookmark, created: true };
  }

  updateBookmark(id: number, patch: BookmarkPatch): Bookmark | null {
    const row = this.db.query("SELECT * FROM bookmarks WHERE id = ?").get(id) as BookmarkRow | null;
    if (!row) return null;
    const stamp = now();
    const settings = this.settings();
    const assignments: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [stamp];

    if (typeof patch.title === "string") {
      const title = patch.title.trim().slice(0, 500);
      assignments.push("title = ?", "title_source = ?");
      values.push(title, title ? "user" : "auto");
    }
    if (patch.intervalMinutes !== undefined) {
      const interval = patch.intervalMinutes;
      assignments.push("interval_minutes = ?");
      values.push(interval);
      const effective = interval ?? settings.defaultIntervalMinutes;
      const base = row.last_backup_at ?? stamp;
      assignments.push("next_backup_at = ?");
      values.push(effective > 0 ? base + effective * 60_000 : null);
    }
    if (typeof patch.enabled === "boolean") {
      assignments.push("enabled = ?");
      values.push(patch.enabled ? 1 : 0);
    }
    values.push(id);
    this.db.query(`UPDATE bookmarks SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    publish({ type: "bookmark", bookmarkId: id });
    return this.findById(id);
  }

  deleteBookmark(id: number): boolean {
    const active = this.db
      .query("SELECT COUNT(*) AS count FROM backups WHERE bookmark_id = ? AND status IN ('queued','running')")
      .get(id) as { count: number };
    if (active.count > 0) return false;
    const rows = this.db.query("SELECT path FROM backups WHERE bookmark_id = ?").all(id) as { path: string | null }[];
    this.db.query("DELETE FROM bookmarks WHERE id = ?").run(id);
    for (const row of rows) removeFile(row.path);
    publish({ type: "bookmark", bookmarkId: id });
    return true;
  }

  // ---------- backups ----------

  enqueueBackup(bookmarkId: number, requestedBy: RequestedBy): Backup | null {
    const bookmark = this.db
      .query("SELECT id FROM bookmarks WHERE id = ?")
      .get(bookmarkId) as { id: number } | null;
    if (!bookmark) return null;
    const active = this.db
      .query(
        "SELECT * FROM backups WHERE bookmark_id = ? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1",
      )
      .get(bookmarkId) as BackupRow | null;
    if (active) return this.mapBackup(active);
    const stamp = now();
    const result = this.db
      .query(
        "INSERT INTO backups (bookmark_id, status, requested_by, created_at) VALUES (?, 'queued', ?, ?)",
      )
      .run(bookmarkId, requestedBy, stamp);
    this.db
      .query("UPDATE bookmarks SET last_status = 'queued', last_error = NULL, updated_at = ? WHERE id = ?")
      .run(stamp, bookmarkId);
    const id = Number(result.lastInsertRowid);
    const row = this.db
      .query(
        `SELECT b.*, bm.title AS bookmark_title, bm.url AS bookmark_url
         FROM backups b JOIN bookmarks bm ON bm.id = b.bookmark_id WHERE b.id = ?`,
      )
      .get(id) as BackupRow;
    publish({ type: "backup", backupId: id, bookmarkId });
    return this.mapBackup(row);
  }

  startBackup(id: number): Backup | null {
    const stamp = now();
    const result = this.db
      .query("UPDATE backups SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
      .run(stamp, id);
    if (result.changes === 0) return null;
    const row = this.getBackupRow(id);
    publish({ type: "backup", backupId: id, bookmarkId: row?.bookmark_id });
    return row ? this.mapBackup(row) : null;
  }

  nextQueuedBackup(): Backup | null {
    const row = this.db
      .query(
        `SELECT b.*, bm.title AS bookmark_title, bm.url AS bookmark_url
         FROM backups b JOIN bookmarks bm ON bm.id = b.bookmark_id
         WHERE b.status = 'queued' ORDER BY b.id ASC LIMIT 1`,
      )
      .get() as BackupRow | null;
    return row ? this.mapBackup(row) : null;
  }

  latestSuccessfulBackup(bookmarkId: number): { id: number; sha256: string | null; path: string | null } | null {
    return this.db
      .query(
        "SELECT id, sha256, path FROM backups WHERE bookmark_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1",
      )
      .get(bookmarkId) as { id: number; sha256: string | null; path: string | null } | null;
  }

  finishSuccess(
    id: number,
    data: {
      title: string;
      excerpt: string;
      size: number;
      sha256: string;
      path: string;
      durationMs: number;
      sameAsPrevious: boolean;
    },
  ): { backup: Backup | null; removedPaths: string[] } {
    const stamp = now();
    const row = this.getBackupRow(id);
    if (!row) return { backup: null, removedPaths: [] };
    const settings = this.settings();
    const bookmark = this.db.query("SELECT * FROM bookmarks WHERE id = ?").get(row.bookmark_id) as BookmarkRow | null;
    if (!bookmark) return { backup: null, removedPaths: [] };
    const effective =
      bookmark.interval_minutes === null ? settings.defaultIntervalMinutes : bookmark.interval_minutes;
    const nextBackupAt = effective > 0 ? stamp + effective * 60_000 : null;

    const tx = this.db.transaction(() => {
      this.db
        .query(
          `UPDATE backups SET status = 'success', title = ?, size = ?, sha256 = ?, path = ?, duration_ms = ?,
            same_as_previous = ?, finished_at = ?, error = NULL WHERE id = ?`,
        )
        .run(
          data.title || bookmark.title || null,
          data.size,
          data.sha256,
          data.path,
          data.durationMs,
          data.sameAsPrevious ? 1 : 0,
          stamp,
          id,
        );
      this.db
        .query(
          `UPDATE bookmarks SET
            last_backup_at = ?,
            last_status = 'success',
            last_error = NULL,
            next_backup_at = ?,
            updated_at = ?,
            title = CASE WHEN title_source = 'auto' AND ? <> '' THEN ? ELSE title END,
            excerpt = CASE WHEN ? <> '' THEN ? ELSE excerpt END
          WHERE id = ?`,
        )
        .run(
          stamp,
          nextBackupAt,
          stamp,
          data.title,
          data.title,
          data.excerpt,
          data.excerpt,
          bookmark.id,
        );
    });
    tx();
    const removedPaths = this.applyRetention(bookmark.id);
    publish({ type: "backup", backupId: id, bookmarkId: bookmark.id });
    publish({ type: "bookmark", bookmarkId: bookmark.id });
    return { backup: this.getBackup(id), removedPaths };
  }

  finishFailure(id: number, message: string, durationMs: number): Backup | null {
    const stamp = now();
    const row = this.getBackupRow(id);
    if (!row) return null;
    const settings = this.settings();
    const bookmark = this.db.query("SELECT * FROM bookmarks WHERE id = ?").get(row.bookmark_id) as BookmarkRow | null;
    const effective = bookmark
      ? bookmark.interval_minutes === null
        ? settings.defaultIntervalMinutes
        : bookmark.interval_minutes
      : settings.defaultIntervalMinutes;
    const nextBackupAt = effective > 0 ? stamp + 15 * 60_000 : null;
    const clean = message.slice(0, 1200);
    const tx = this.db.transaction(() => {
      this.db
        .query("UPDATE backups SET status = 'failed', error = ?, duration_ms = ?, finished_at = ? WHERE id = ?")
        .run(clean, durationMs, stamp, id);
      this.db
        .query("UPDATE bookmarks SET last_status = 'failed', last_error = ?, next_backup_at = ?, updated_at = ? WHERE id = ?")
        .run(clean, nextBackupAt, stamp, row.bookmark_id);
    });
    tx();
    publish({ type: "backup", backupId: id, bookmarkId: row.bookmark_id });
    publish({ type: "bookmark", bookmarkId: row.bookmark_id });
    return this.getBackup(id);
  }

  getBackup(id: number): Backup | null {
    const row = this.getBackupRow(id);
    return row ? this.mapBackup(row) : null;
  }

  getArchiveMeta(id: number): { path: string; title: string; bookmarkTitle: string } | null {
    const row = this.db
      .query(
        `SELECT b.path, b.title, bm.title AS bookmark_title
         FROM backups b JOIN bookmarks bm ON bm.id = b.bookmark_id
         WHERE b.id = ? AND b.status = 'success'`,
      )
      .get(id) as { path: string | null; title: string | null; bookmark_title: string } | null;
    if (!row?.path) return null;
    return { path: row.path, title: row.title ?? "", bookmarkTitle: row.bookmark_title };
  }

  private getBackupRow(id: number): BackupRow | null {
    return this.db
      .query(
        `SELECT b.*, bm.title AS bookmark_title, bm.url AS bookmark_url
         FROM backups b JOIN bookmarks bm ON bm.id = b.bookmark_id WHERE b.id = ?`,
      )
      .get(id) as BackupRow | null;
  }

  listBackups(bookmarkId: number): Backup[] {
    const rows = this.db
      .query(
        `SELECT b.*, bm.title AS bookmark_title, bm.url AS bookmark_url
         FROM backups b JOIN bookmarks bm ON bm.id = b.bookmark_id
         WHERE b.bookmark_id = ? ORDER BY b.id DESC`,
      )
      .all(bookmarkId) as BackupRow[];
    return rows.map((row) => this.mapBackup(row));
  }

  deleteBackup(id: number): boolean {
    const row = this.getBackupRow(id);
    if (!row || row.status === "running") return false;
    this.db.query("DELETE FROM backups WHERE id = ?").run(id);
    removeFile(row.path);
    this.refreshBookmarkState(row.bookmark_id);
    publish({ type: "backup", backupId: id, bookmarkId: row.bookmark_id });
    publish({ type: "bookmark", bookmarkId: row.bookmark_id });
    return true;
  }

  private refreshBookmarkState(bookmarkId: number): void {
    const latest = this.db
      .query("SELECT * FROM backups WHERE bookmark_id = ? ORDER BY id DESC LIMIT 1")
      .get(bookmarkId) as BackupRow | null;
    const latestSuccess = this.db
      .query("SELECT * FROM backups WHERE bookmark_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1")
      .get(bookmarkId) as BackupRow | null;
    this.db
      .query("UPDATE bookmarks SET last_backup_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(
        latestSuccess?.finished_at ?? null,
        latest?.status ?? null,
        latest?.status === "failed" ? latest.error : null,
        now(),
        bookmarkId,
      );
  }

  private applyRetention(bookmarkId: number): string[] {
    const settings = this.settings();
    const removedPaths: string[] = [];
    if (settings.retentionCount > 0) {
      const rows = this.db
        .query(
          `SELECT id, path FROM backups WHERE bookmark_id = ? AND status = 'success'
           ORDER BY id DESC LIMIT -1 OFFSET ?`,
        )
        .all(bookmarkId, settings.retentionCount) as { id: number; path: string | null }[];
      const del = this.db.query("DELETE FROM backups WHERE id = ?");
      for (const row of rows) {
        del.run(row.id);
        removeFile(row.path);
        if (row.path) removedPaths.push(row.path);
      }
    }
    const failures = this.db
      .query(
        `SELECT id, path FROM backups WHERE bookmark_id = ? AND status = 'failed'
         ORDER BY id DESC LIMIT -1 OFFSET 20`,
      )
      .all(bookmarkId) as { id: number; path: string | null }[];
    const del = this.db.query("DELETE FROM backups WHERE id = ?");
    for (const row of failures) {
      del.run(row.id);
      removeFile(row.path);
      if (row.path) removedPaths.push(row.path);
    }
    return removedPaths;
  }

  dueBookmarks(limit = 12): Bookmark[] {
    const rows = this.db
      .query(
        `SELECT b.*,
          (SELECT COUNT(*) FROM backups x WHERE x.bookmark_id = b.id AND x.status = 'success') AS success_count,
          (SELECT COUNT(*) FROM backups x WHERE x.bookmark_id = b.id AND x.status = 'failed') AS failure_count,
          (SELECT COUNT(*) FROM backups x WHERE x.bookmark_id = b.id AND x.status IN ('queued','running')) AS active_count
         FROM bookmarks b
         WHERE b.enabled = 1 AND b.next_backup_at IS NOT NULL AND b.next_backup_at <= ?
           AND NOT EXISTS (SELECT 1 FROM backups x WHERE x.bookmark_id = b.id AND x.status IN ('queued','running'))
         ORDER BY b.next_backup_at ASC LIMIT ?`,
      )
      .all(now(), limit) as BookmarkRow[];
    const recent = this.recentBackupsByBookmark(rows.map((row) => row.id), 12);
    return rows.map((row) => this.hydrateBookmark(row, recent.get(row.id) ?? []));
  }

  markInterrupted(): void {
    const stamp = now();
    const rows = this.db
      .query("SELECT * FROM backups WHERE status IN ('queued','running')")
      .all() as BackupRow[];
    const settings = this.settings();
    for (const row of rows) {
      if (row.status === "running") {
        const duration = row.started_at ? stamp - row.started_at : 0;
        this.db
          .query("UPDATE backups SET status = 'failed', error = ?, duration_ms = ?, finished_at = ? WHERE id = ?")
          .run("服务重启，快照中断", duration, stamp, row.id);
        const bookmark = this.db
          .query("SELECT interval_minutes FROM bookmarks WHERE id = ?")
          .get(row.bookmark_id) as { interval_minutes: number | null } | null;
        const effective = bookmark
          ? bookmark.interval_minutes === null
            ? settings.defaultIntervalMinutes
            : bookmark.interval_minutes
          : 0;
        this.db
          .query("UPDATE bookmarks SET last_status = 'failed', last_error = ?, next_backup_at = ? WHERE id = ?")
          .run("服务重启，快照中断", effective > 0 ? stamp + 15 * 60_000 : null, row.bookmark_id);
      }
    }
  }

  // ---------- activity & stats ----------

  activity(): Pick<Activity, "running" | "queued" | "recent" | "upcoming"> {
    const running = this.db
      .query(
        `SELECT b.*, bm.title AS bookmark_title, bm.url AS bookmark_url
         FROM backups b JOIN bookmarks bm ON bm.id = b.bookmark_id
         WHERE b.status = 'running' ORDER BY b.started_at ASC`,
      )
      .all() as BackupRow[];
    const queued = this.db
      .query(
        `SELECT b.*, bm.title AS bookmark_title, bm.url AS bookmark_url
         FROM backups b JOIN bookmarks bm ON bm.id = b.bookmark_id
         WHERE b.status = 'queued' ORDER BY b.id ASC LIMIT 50`,
      )
      .all() as BackupRow[];
    const recent = this.db
      .query(
        `SELECT b.*, bm.title AS bookmark_title, bm.url AS bookmark_url
         FROM backups b JOIN bookmarks bm ON bm.id = b.bookmark_id
         WHERE b.status IN ('success','failed') ORDER BY b.finished_at DESC LIMIT 40`,
      )
      .all() as BackupRow[];
    const upcomingRows = this.db
      .query(
        `SELECT * FROM bookmarks WHERE enabled = 1 AND next_backup_at IS NOT NULL
         ORDER BY next_backup_at ASC LIMIT 6`,
      )
      .all() as BookmarkRow[];
    return {
      running: running.map((row) => this.mapBackup(row)),
      queued: queued.map((row) => this.mapBackup(row)),
      recent: recent.map((row) => this.mapBackup(row)),
      upcoming: upcomingRows.map((row) => this.hydrateBookmark(row, [])),
    };
  }

  stats(browserState: BrowserState): Stats {
    const settings = this.settings();
    const bookmarks = this.db.query("SELECT COUNT(*) AS count FROM bookmarks").get() as { count: number };
    const backedUp = this.db
      .query("SELECT COUNT(DISTINCT bookmark_id) AS count FROM backups WHERE status = 'success'")
      .get() as { count: number };
    const failing = this.db
      .query("SELECT COUNT(*) AS count FROM bookmarks WHERE last_status = 'failed'")
      .get() as { count: number };
    const successBackups = this.db
      .query("SELECT COUNT(*) AS count FROM backups WHERE status = 'success'")
      .get() as { count: number };
    const week = this.db
      .query("SELECT COUNT(*) AS count FROM backups WHERE status = 'success' AND finished_at >= ?")
      .get(now() - 7 * 24 * 60 * 60_000) as { count: number };
    const size = this.db
      .query("SELECT COALESCE(SUM(size), 0) AS bytes FROM backups WHERE status = 'success'")
      .get() as { bytes: number };
    const queue = this.db
      .query("SELECT COUNT(*) AS count FROM backups WHERE status IN ('queued','running')")
      .get() as { count: number };
    const running = this.db
      .query("SELECT COUNT(*) AS count FROM backups WHERE status = 'running'")
      .get() as { count: number };
    const next = this.db
      .query(
        "SELECT MIN(next_backup_at) AS at FROM bookmarks WHERE enabled = 1 AND next_backup_at IS NOT NULL",
      )
      .get() as { at: number | null };
    return {
      bookmarks: bookmarks.count,
      backedUp: backedUp.count,
      failing: failing.count,
      successBackups: successBackups.count,
      backups7d: week.count,
      storedBytes: size.bytes,
      queue: queue.count,
      running: running.count,
      browserState,
      nextDueAt: settings.autoBackupEnabled ? next.at : null,
      autoBackupEnabled: settings.autoBackupEnabled,
    };
  }

  // ---------- mapping ----------

  private recentBackupsByBookmark(ids: number[], perBookmark: number): Map<number, Backup[]> {
    const map = new Map<number, Backup[]>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT * FROM (
           SELECT b.*, bm.title AS bookmark_title, bm.url AS bookmark_url,
             ROW_NUMBER() OVER (PARTITION BY b.bookmark_id ORDER BY b.id DESC) AS rn
           FROM backups b JOIN bookmarks bm ON bm.id = b.bookmark_id
           WHERE b.bookmark_id IN (${placeholders})
         ) WHERE rn <= ? ORDER BY id DESC`,
      )
      .all(...ids, perBookmark) as BackupRow[];
    for (const row of rows) {
      const list = map.get(row.bookmark_id) ?? [];
      list.push(this.mapBackup(row));
      map.set(row.bookmark_id, list);
    }
    return map;
  }

  private hydrateBookmark(row: BookmarkRow, recent?: Backup[]): Bookmark {
    const list = recent ?? this.recentBackupsByBookmark([row.id], 12).get(row.id) ?? [];
    const settings = this.settings();
    return {
      id: row.id,
      url: row.url,
      title: row.title,
      excerpt: row.excerpt,
      domain: displayDomain(row.url),
      accession: accession(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      intervalMinutes: row.interval_minutes,
      effectiveIntervalMinutes: row.interval_minutes ?? settings.defaultIntervalMinutes,
      enabled: row.enabled === 1,
      lastBackupAt: row.last_backup_at,
      nextBackupAt: row.next_backup_at,
      lastStatus: row.last_status,
      lastError: row.last_error,
      titleSource: row.title_source,
      backupCount: row.success_count ?? list.filter((backup) => backup.status === "success").length,
      failureCount: row.failure_count ?? list.filter((backup) => backup.status === "failed").length,
      activeCount: row.active_count ?? list.filter((backup) => backup.status === "queued" || backup.status === "running").length,
      latestBackup: list[0] ?? null,
      recentBackups: list,
    };
  }

  private mapBackup(row: BackupRow): Backup {
    const success = row.status === "success";
    return {
      id: row.id,
      bookmarkId: row.bookmark_id,
      status: row.status,
      title: row.title,
      size: row.size,
      sha256: row.sha256,
      durationMs: row.duration_ms,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      requestedBy: row.requested_by,
      sameAsPrevious: row.same_as_previous === 1,
      archiveUrl: success ? `${config.archiveBaseUrl}/a/${row.id}` : null,
      downloadUrl: success ? `${config.archiveBaseUrl}/a/${row.id}?download=1` : null,
      bookmarkTitle: row.bookmark_title ?? "",
      bookmarkUrl: row.bookmark_url ?? "",
    };
  }
}

export type { BookmarkPatch };
