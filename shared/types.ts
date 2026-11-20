export type BackupStatus = "queued" | "running" | "success" | "failed";
export type BrowserState = "cold" | "starting" | "warm" | "error";
export type RequestedBy = "initial" | "manual" | "extension" | "scheduler" | "retry";

export interface Backup {
  id: number;
  bookmarkId: number;
  status: BackupStatus;
  title: string | null;
  size: number | null;
  sha256: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  requestedBy: RequestedBy;
  sameAsPrevious: boolean;
  archiveUrl: string | null;
  downloadUrl: string | null;
  bookmarkTitle: string;
  bookmarkUrl: string;
}

export interface BackupAssetInput {
  pluginId: string;
  pluginName: string;
  role: string;
  label: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface BackupAsset extends BackupAssetInput {
  id: number;
  backupId: number;
  url: string;
  downloadUrl: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  builtin: boolean;
  enabled: boolean;
  hosts: string[];
  error: string | null;
}

export interface PluginListResponse {
  plugins: PluginInfo[];
}

export interface BackupAssetsResponse {
  assets: BackupAsset[];
}

export interface Bookmark {
  id: number;
  url: string;
  title: string;
  excerpt: string;
  domain: string;
  accession: string;
  createdAt: number;
  updatedAt: number;
  intervalMinutes: number | null;
  effectiveIntervalMinutes: number;
  enabled: boolean;
  lastBackupAt: number | null;
  nextBackupAt: number | null;
  lastStatus: BackupStatus | null;
  lastError: string | null;
  titleSource: "auto" | "user";
  backupCount: number;
  failureCount: number;
  activeCount: number;
  latestBackup: Backup | null;
  recentBackups: Backup[];
}

export interface Settings {
  autoBackupEnabled: boolean;
  defaultIntervalMinutes: number;
  retentionCount: number;
  browserIdleMinutes: number;
}

export interface Stats {
  bookmarks: number;
  backedUp: number;
  failing: number;
  successBackups: number;
  backups7d: number;
  storedBytes: number;
  queue: number;
  running: number;
  browserState: BrowserState;
  nextDueAt: number | null;
  autoBackupEnabled: boolean;
}

export interface Health {
  ok: boolean;
  version: string;
  startedAt: number;
  uptimeMs: number;
  archiveBaseUrl: string;
  apiBaseUrl: string;
  dataDir: string;
  envFile: string;
  envFileLoaded: boolean;
  chromePath: string | null;
  browserState: BrowserState;
  browserLastError: string | null;
  queueLength: number;
  running: boolean;
  port: number;
  archivePort: number;
}

export interface Activity {
  running: Backup[];
  queued: Backup[];
  recent: Backup[];
  upcoming: Bookmark[];
}

export interface AppEvent {
  type: "backup" | "bookmark" | "browser" | "stats" | "settings";
  bookmarkId?: number;
  backupId?: number;
  at: number;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface BookmarkListResponse {
  bookmarks: Bookmark[];
  stats: Stats;
}

export interface BookmarkDetailResponse {
  bookmark: Bookmark;
  backups: Backup[];
}

export interface SettingsResponse {
  settings: Settings;
  health: Health;
}
