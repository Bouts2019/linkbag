import { useCallback, useEffect, useRef, useState } from "react";
import type { Activity, Backup, Bookmark, Health, PluginInfo, Settings, Stats } from "../../shared/types";
import { api, ApiRequestError } from "./api";
import { Header } from "./components/Header";
import { Ledger } from "./components/Ledger";
import { DetailPane } from "./components/DetailPane";
import { ActivityView } from "./components/ActivityView";
import { SettingsView } from "./components/SettingsView";
import { ConfirmDialog, Toast, type ToastData } from "./components/Overlays";

type Route = { view: "library" | "activity" | "settings"; id: number | null };
type DetailState = { bookmark: Bookmark; backups: Backup[] };

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "/activity") return { view: "activity", id: null };
  if (hash === "/settings") return { view: "settings", id: null };
  const match = hash.match(/^\/b\/(\d+)$/);
  if (match?.[1]) return { view: "library", id: Number(match[1]) };
  return { view: "library", id: null };
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return "服务暂时没有响应";
}

type ConfirmState = {
  title: string;
  body: string;
  label: string;
  onConfirm: () => Promise<void> | void;
};

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [activity, setActivity] = useState<(Activity & { stats: Stats }) | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [connectionLost, setConnectionLost] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const toastCounter = useRef(0);

  const notify = useCallback((message: string, tone: "default" | "error" = "default", detailText?: string) => {
    toastCounter.current += 1;
    setToast({ id: toastCounter.current, message, tone, detail: detailText });
  }, []);

  const notifyError = useCallback(
    (error: unknown) => notify(errorMessage(error), "error"),
    [notify],
  );

  const bump = useCallback(() => setRefreshTick((value) => value + 1), []);

  const navigate = useCallback((hash: string) => {
    if (window.location.hash === hash) {
      setRoute(parseRoute());
      return;
    }
    window.location.hash = hash;
  }, []);

  const closeDetail = useCallback(() => navigate("#/"), [navigate]);

  // Routing
  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, healthData, settingsData] = await Promise.all([
          api.listBookmarks(),
          api.health(),
          api.settings(),
        ]);
        if (cancelled) return;
        setBookmarks(list.bookmarks);
        setStats(list.stats);
        setHealth(healthData);
        setSettings(settingsData.settings);
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError(errorMessage(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshLibrary = useCallback(async (quiet = false) => {
    try {
      const list = await api.listBookmarks();
      setBookmarks(list.bookmarks);
      setStats(list.stats);
      setLoadError(null);
    } catch (error) {
      if (!quiet) setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.health());
    } catch {
      // keep the last known state; the connection banner covers this
    }
  }, []);

  // Live updates
  useEffect(() => {
    const source = new EventSource("/api/events");
    let timer: number | undefined;
    source.addEventListener("ready", () => setConnectionLost(false));
    source.addEventListener("change", () => {
      setConnectionLost(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => bump(), 260);
    });
    source.onerror = () => setConnectionLost(true);
    return () => {
      window.clearTimeout(timer);
      source.close();
    };
  }, [bump]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshHealth(), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshHealth]);

  useEffect(() => {
    if (refreshTick === 0) return;
    void refreshLibrary(true);
    void refreshHealth();
  }, [refreshTick, refreshLibrary, refreshHealth]);

  // Detail fetching
  useEffect(() => {
    const id = route.id;
    if (!id) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    const known = bookmarks.find((bookmark) => bookmark.id === id);
    if (known) {
      setDetail((current) =>
        current?.bookmark.id === known.id ? current : { bookmark: known, backups: [] },
      );
    }
    setDetailLoading(true);
    api
      .detail(id)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        setDetailError(null);
      })
      .catch((error) => {
        if (!cancelled) setDetailError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // bookmarks is intentionally not a dependency: live bookmark updates are
    // merged below without re-fetching every backup list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.id, refreshTick]);

  useEffect(() => {
    if (!detail) return;
    const fresh = bookmarks.find((bookmark) => bookmark.id === detail.bookmark.id);
    if (fresh && fresh !== detail.bookmark) {
      setDetail((current) => (current && current.bookmark.id === fresh.id ? { ...current, bookmark: fresh } : current));
    }
  }, [bookmarks, detail]);

  // Activity fetching
  useEffect(() => {
    if (route.view !== "activity") return;
    let cancelled = false;
    setActivityLoading(true);
    api
      .activity()
      .then((data) => {
        if (!cancelled) {
          setActivity(data);
          setActivityError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) setActivityError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setActivityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [route.view, refreshTick]);

  // Settings refresh when entering the page
  useEffect(() => {
    if (route.view !== "settings") return;
    let cancelled = false;
    setPluginsLoading(true);
    api
      .settings()
      .then((data) => {
        if (cancelled) return;
        setSettings(data.settings);
        setHealth(data.health);
      })
      .catch(() => {
        // keep the last known settings; the page shows an inline error
      });
    api
      .plugins()
      .then((data) => {
        if (!cancelled) setPlugins(data.plugins);
      })
      .catch(() => {
        // keep the last known plugin list
      })
      .finally(() => {
        if (!cancelled) setPluginsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [route.view]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const editing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (event.key === "/" && !editing) {
        event.preventDefault();
        if (route.view !== "library") navigate("#/");
        window.setTimeout(() => {
          const input = document.getElementById("ledger-search") as HTMLInputElement | null;
          input?.focus();
          input?.select();
        }, 30);
      }
      if ((event.key === "n" || event.key === "N") && !editing) {
        event.preventDefault();
        if (route.view !== "library") navigate("#/");
        window.setTimeout(() => document.getElementById("add-url")?.focus(), 30);
      }
      if (event.key === "Escape") {
        if (confirm) {
          setConfirm(null);
          return;
        }
        if (route.id) closeDetail();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [route.view, route.id, confirm, navigate, closeDetail]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const handleAdd = async (url: string, intervalMinutes: number | null) => {
    const result = await api.createBookmark({ url, intervalMinutes });
    notify(result.created ? "已存入，正在拍快照" : "这份收藏已经存在，已重新加入备份");
    await refreshLibrary(true);
    navigate(`#/b/${result.bookmark.id}`);
  };

  const handleSelect = (bookmark: Bookmark) => {
    navigate(`#/b/${bookmark.id}`);
  };

  const handleBackup = async () => {
    if (!route.id) return;
    try {
      await api.backupNow(route.id);
      notify("已排入备份队列");
      bump();
    } catch (error) {
      notifyError(error);
    }
  };

  const handleToggleAuto = async (enabled: boolean) => {
    const previous = settings;
    if (settings) setSettings({ ...settings, autoBackupEnabled: enabled });
    try {
      const response = await api.updateSettings({ autoBackupEnabled: enabled });
      setSettings(response.settings);
      setHealth(response.health);
      notify(enabled ? "自动备份已开启" : "自动备份已暂停");
      bump();
    } catch (error) {
      if (previous) setSettings(previous);
      notifyError(error);
    }
  };

  const handleChangeInterval = async (minutes: number | null) => {
    if (!route.id) return;
    try {
      const response = await api.updateBookmark(route.id, { intervalMinutes: minutes });
      setDetail((current) =>
        current && current.bookmark.id === response.bookmark.id
          ? { ...current, bookmark: response.bookmark }
          : current,
      );
      bump();
    } catch (error) {
      notifyError(error);
    }
  };

  const handleToggleEnabled = async (enabled: boolean) => {
    if (!route.id) return;
    try {
      const response = await api.updateBookmark(route.id, { enabled });
      setDetail((current) =>
        current && current.bookmark.id === response.bookmark.id
          ? { ...current, bookmark: response.bookmark }
          : current,
      );
      bump();
    } catch (error) {
      notifyError(error);
    }
  };

  const requestDeleteBookmark = () => {
    if (!detail) return;
    const bookmark = detail.bookmark;
    setConfirm({
      title: "删除这份收藏？",
      body: `“${bookmark.title || bookmark.domain}”以及它的 ${bookmark.backupCount} 份快照会从磁盘移除，无法恢复。`,
      label: "删除收藏",
      onConfirm: async () => {
        setConfirm(null);
        try {
          await api.deleteBookmark(bookmark.id);
          setDetail(null);
          navigate("#/");
          await refreshLibrary(true);
          notify("收藏已删除");
        } catch (error) {
          notifyError(error);
        }
      },
    });
  };

  const requestDeleteBackup = (backup: Backup) => {
    setConfirm({
      title: "删除这份快照？",
      body: `备份于 ${new Date(backup.finishedAt ?? backup.createdAt).toLocaleString("zh-CN")} 的快照会从磁盘移除，无法恢复。`,
      label: "删除快照",
      onConfirm: async () => {
        setConfirm(null);
        try {
          await api.deleteBackup(backup.id);
          bump();
          notify("快照已删除");
        } catch (error) {
          notifyError(error);
        }
      },
    });
  };

  const handleCancelQueued = async (backup: Backup) => {
    try {
      await api.deleteBackup(backup.id);
      notify("已取消排队");
      bump();
    } catch (error) {
      notifyError(error);
    }
  };

  const handleBackupAll = async () => {
    try {
      const result = await api.backupAll();
      notify(result.queued > 0 ? `已加入队列 ${result.queued} 份` : "没有新的链接需要备份");
      bump();
    } catch (error) {
      notifyError(error);
    }
  };

  const handleReleaseBrowser = async () => {
    try {
      const result = await api.releaseBrowser();
      setHealth(result.health);
      notify("浏览器已释放");
      bump();
    } catch (error) {
      notifyError(error);
    }
  };

  const handleSaveSettings = async (patch: Partial<Settings>) => {
    setSavingSettings(true);
    try {
      const response = await api.updateSettings(patch);
      setSettings(response.settings);
      setHealth(response.health);
      notify("设置已保存");
      bump();
    } catch (error) {
      notifyError(error);
      throw error;
    } finally {
      setSavingSettings(false);
    }
  };

  const handleTogglePlugin = async (id: string, enabled: boolean) => {
    try {
      const response = await api.updatePlugin(id, enabled);
      setPlugins(response.plugins);
      notify(enabled ? "插件已启用" : "插件已停用");
    } catch (error) {
      notifyError(error);
    }
  };

  const handleReloadPlugins = async () => {
    setPluginsLoading(true);
    try {
      const response = await api.reloadPlugins();
      setPlugins(response.plugins);
      notify("插件已重新扫描");
    } catch (error) {
      notifyError(error);
    } finally {
      setPluginsLoading(false);
    }
  };

  const selectedBookmark =
    route.id === null
      ? null
      : detail?.bookmark.id === route.id
        ? detail.bookmark
        : bookmarks.find((bookmark) => bookmark.id === route.id) ?? null;

  return (
    <div className="app">
      <Header
        health={health}
        stats={stats}
        view={route.view === "library" && route.id ? "bookmark" : route.view}
        onNavigate={navigate}
        onOpenSettings={() => navigate("#/settings")}
      />

      {connectionLost ? (
        <div className="connection-strip" role="status">
          与本地服务的连接中断，正在重连。已经生成的快照仍然可以直接打开。
          <button type="button" className="text-btn compact" onClick={() => void refreshLibrary()}>
            重试
          </button>
        </div>
      ) : null}

      {route.view === "library" ? (
        <div className={`workspace ${route.id ? "has-selection" : ""}`}>
          <Ledger
            bookmarks={bookmarks}
            stats={stats}
            settings={settings}
            selectedId={route.id}
            loading={loading}
            error={loadError}
            onSelect={handleSelect}
            onAdd={handleAdd}
            onToggleAuto={handleToggleAuto}
            onRetry={() => void refreshLibrary()}
          />
          <DetailPane
            bookmark={selectedBookmark}
            backups={detail?.backups ?? []}
            loading={detailLoading}
            error={detailError}
            settings={settings}
            emptyLibrary={bookmarks.length === 0}
            onClose={closeDetail}
            onBackup={() => void handleBackup()}
            onDeleteBookmark={requestDeleteBookmark}
            onDeleteBackup={requestDeleteBackup}
            onChangeInterval={(minutes) => void handleChangeInterval(minutes)}
            onToggleEnabled={(enabled) => void handleToggleEnabled(enabled)}
            onNotify={(message) => notify(message)}
            onRetry={() => bump()}
          />
          {route.id ? <button className="detail-scrim" type="button" aria-label="关闭详情" onClick={closeDetail} /> : null}
        </div>
      ) : route.view === "activity" ? (
        <ActivityView
          activity={activity}
          health={health}
          settings={settings}
          loading={activityLoading}
          error={activityError}
          onRefresh={() => {
            bump();
            void refreshHealth();
          }}
          onBackupAll={() => void handleBackupAll()}
          onReleaseBrowser={() => void handleReleaseBrowser()}
          onSelectBookmark={(id) => navigate(`#/b/${id}`)}
          onCancel={(backup) => void handleCancelQueued(backup)}
        />
      ) : (
        <SettingsView
          settings={settings}
          health={health}
          plugins={plugins}
          pluginsLoading={pluginsLoading}
          loading={loading}
          error={loadError}
          saving={savingSettings}
          onSave={handleSaveSettings}
          onTogglePlugin={(id, enabled) => void handleTogglePlugin(id, enabled)}
          onReloadPlugins={() => void handleReloadPlugins()}
          onReleaseBrowser={() => void handleReleaseBrowser()}
          onBackupAll={() => void handleBackupAll()}
          onRefresh={() => {
            bump();
            void refreshHealth();
          }}
          onNotify={(message) => notify(message)}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        confirmLabel={confirm?.label ?? "删除"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void confirm?.onConfirm()}
      />

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
