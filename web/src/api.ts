import type {
  Activity,
  Backup,
  BackupAssetsResponse,
  Bookmark,
  BookmarkDetailResponse,
  BookmarkListResponse,
  Health,
  PluginListResponse,
  Settings,
  SettingsResponse,
  Stats,
} from "../../shared/types";

export class ApiRequestError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = "request_failed") {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.method && init.method !== "GET") headers.set("X-LinkBag", "1");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    let message = "服务暂时没有响应";
    let code = "request_failed";
    try {
      const body = (await response.json()) as { error?: { message?: string; code?: string } };
      message = body.error?.message ?? message;
      code = body.error?.code ?? code;
    } catch {
      // keep the default message
    }
    throw new ApiRequestError(message, response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  listBookmarks(search = ""): Promise<BookmarkListResponse> {
    const query = search ? `?q=${encodeURIComponent(search)}` : "";
    return request(`/api/bookmarks${query}`);
  },
  detail(id: number): Promise<BookmarkDetailResponse> {
    return request(`/api/bookmarks/${id}`);
  },
  createBookmark(input: {
    url: string;
    title?: string;
    intervalMinutes?: number | null;
    source?: "manual" | "extension";
  }): Promise<{ bookmark: Bookmark; backup: Backup | null; created: boolean }> {
    return request("/api/bookmarks", { method: "POST", body: JSON.stringify(input) });
  },
  updateBookmark(
    id: number,
    patch: { title?: string; intervalMinutes?: number | null; enabled?: boolean },
  ): Promise<{ bookmark: Bookmark }> {
    return request(`/api/bookmarks/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  deleteBookmark(id: number): Promise<{ ok: boolean }> {
    return request(`/api/bookmarks/${id}`, { method: "DELETE" });
  },
  backupNow(id: number): Promise<{ backup: Backup }> {
    return request(`/api/bookmarks/${id}/backup`, { method: "POST", body: "{}" });
  },
  deleteBackup(id: number): Promise<{ ok: boolean }> {
    return request(`/api/backups/${id}`, { method: "DELETE" });
  },
  backupAssets(id: number): Promise<BackupAssetsResponse> {
    return request(`/api/backups/${id}/assets`);
  },
  plugins(): Promise<PluginListResponse> {
    return request("/api/plugins");
  },
  updatePlugin(id: string, enabled: boolean): Promise<PluginListResponse> {
    return request(`/api/plugins/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
  },
  reloadPlugins(): Promise<PluginListResponse> {
    return request("/api/plugins/reload", { method: "POST", body: "{}" });
  },
  activity(): Promise<Activity & { stats: Stats }> {
    return request("/api/activity");
  },
  health(): Promise<Health> {
    return request("/api/health");
  },
  settings(): Promise<SettingsResponse> {
    return request("/api/settings");
  },
  updateSettings(patch: Partial<Settings>): Promise<SettingsResponse> {
    return request("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
  },
  backupAll(): Promise<{ queued: number }> {
    return request("/api/actions/backup-all", { method: "POST", body: "{}" });
  },
  releaseBrowser(): Promise<{ health: Health }> {
    return request("/api/actions/release-browser", { method: "POST", body: "{}" });
  },
};
