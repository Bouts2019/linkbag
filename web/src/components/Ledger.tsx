import { useMemo, useState } from "react";
import type { Bookmark, Settings, Stats } from "../../../shared/types";
import {
  ErrorBanner,
  NoResults,
  EmptyLibrary,
  LedgerSkeleton,
  ServiceDown,
} from "./States";
import { BackupStrip, Switch } from "./Bits";
import { PlusIcon, SearchIcon } from "../icons";
import { cx, filterCounts, formatCompact, formatRelative, formatSize, intervalLabel } from "../utils";

type Filter = "all" | "backed" | "failing" | "empty";

type LedgerProps = {
  bookmarks: Bookmark[];
  stats: Stats | null;
  settings: Settings | null;
  selectedId: number | null;
  loading: boolean;
  error: string | null;
  onSelect: (bookmark: Bookmark) => void;
  onAdd: (url: string, intervalMinutes: number | null) => Promise<void>;
  onToggleAuto: (enabled: boolean) => void;
  onRetry: () => void;
};

export function Ledger({
  bookmarks,
  stats,
  settings,
  selectedId,
  loading,
  error,
  onSelect,
  onAdd,
  onToggleAuto,
  onRetry,
}: LedgerProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const counts = useMemo(() => filterCounts(bookmarks), [bookmarks]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return bookmarks.filter((bookmark) => {
      if (filter === "backed" && bookmark.backupCount === 0) return false;
      if (filter === "failing" && bookmark.failureCount === 0) return false;
      if (filter === "empty" && bookmark.backupCount > 0) return false;
      if (!needle) return true;
      return (
        bookmark.title.toLowerCase().includes(needle) ||
        bookmark.domain.toLowerCase().includes(needle) ||
        bookmark.url.toLowerCase().includes(needle) ||
        bookmark.excerpt.toLowerCase().includes(needle)
      );
    });
  }, [bookmarks, filter, query]);

  // Expose the search box to the global "/" shortcut without keeping focus state in App.

  return (
    <div className="ledger-pane">
      <div className="ledger-inner">
        <div className="library-head">
          <div className="library-count-block">
            <div className="count-line">
              <span className="big-count">{bookmarks.length.toLocaleString("zh-CN")}</span>
              <span className="count-unit">份收藏</span>
            </div>
            <p className="head-note">
              <span>过去七天保存 {stats?.backups7d ?? 0} 次</span>
              <span className="note-divider" aria-hidden="true" />
              <span>占用 {formatSize(stats?.storedBytes)}</span>
            </p>
          </div>
          <label className="search-box" htmlFor="ledger-search">
            <SearchIcon size={15} />
            <input
              id="ledger-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题、域名或网址"
              autoComplete="off"
              spellCheck={false}
            />
            <kbd>/</kbd>
          </label>
        </div>

        <div className="filter-bar">
          <div className="filters" role="tablist" aria-label="筛选收藏">
            {(
              [
                ["all", "全部", counts.all],
                ["backed", "有备份", counts.backed],
                ["empty", "未备份", counts.empty],
                ["failing", "出错", counts.failing],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                className={cx("filter-tab", filter === key && "is-active")}
                onClick={() => setFilter(key)}
              >
                {label}
                <span className="filter-count">{count}</span>
              </button>
            ))}
          </div>
          <Switch
            checked={settings?.autoBackupEnabled ?? true}
            onChange={onToggleAuto}
            label="自动备份"
            disabled={!settings}
          />
        </div>

        <AddForm onAdd={onAdd} settings={settings} />

        {error && bookmarks.length === 0 ? (
          <ServiceDown message={error} onRetry={onRetry} />
        ) : (
          <>
            {error ? <ErrorBanner message={error} onRetry={onRetry} /> : null}

            {loading && bookmarks.length === 0 ? (
              <LedgerSkeleton />
            ) : bookmarks.length === 0 ? (
              <EmptyLibrary onFocusAdd={() => document.getElementById("add-url")?.focus()} />
            ) : filtered.length === 0 ? (
              <NoResults
                query={query}
                onClear={() => {
                  setQuery("");
                  setFilter("all");
                }}
              />
            ) : (
              <div className="bookmark-list" role="list" aria-label="收藏列表">
                {filtered.map((bookmark) => (
                  <BookmarkRow
                    key={bookmark.id}
                    bookmark={bookmark}
                    selected={bookmark.id === selectedId}
                    onSelect={() => onSelect(bookmark)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AddForm({
  onAdd,
  settings,
}: {
  onAdd: (url: string, intervalMinutes: number | null) => Promise<void>;
  settings: Settings | null;
}) {
  const [url, setUrl] = useState("");
  const [interval, setIntervalValue] = useState("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const value = url.trim();
    if (!value) {
      setError("先粘贴一个网页地址。");
      document.getElementById("add-url")?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const intervalMinutes = interval === "default" ? null : Number(interval);
      await onAdd(value, intervalMinutes);
      setUrl("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "存入失败，请再试一次。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-row" onSubmit={submit}>
      <div className="add-field">
        <label className="sr-only" htmlFor="add-url">
          要存入的网址
        </label>
        <input
          id="add-url"
          type="text"
          inputMode="url"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            if (error) setError(null);
          }}
          placeholder="粘贴网页地址，按 Enter 存入"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "add-error" : undefined}
        />
      </div>
      <div className="add-interval">
        <label className="sr-only" htmlFor="add-interval">
          备份节奏
        </label>
        <select id="add-interval" value={interval} onChange={(event) => setIntervalValue(event.target.value)}>
          <option value="default">
            跟随默认（{intervalLabel(settings?.defaultIntervalMinutes ?? 1440, 1440)}）
          </option>
          <option value="360">每 6 小时</option>
          <option value="720">每 12 小时</option>
          <option value="1440">每天</option>
          <option value="4320">每 3 天</option>
          <option value="10080">每周</option>
          <option value="0">仅手动</option>
        </select>
      </div>
      <button type="submit" className="btn btn-primary add-submit" disabled={busy}>
        <PlusIcon size={15} />
        {busy ? "正在存入" : "存入"}
      </button>
      {error ? (
        <p className="add-error" id="add-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function bookmarkTitle(bookmark: Bookmark): string {
  if (bookmark.title) return bookmark.title;
  try {
    const parts = new URL(bookmark.url).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    return last ? decodeURIComponent(last) : bookmark.domain;
  } catch {
    return bookmark.domain || bookmark.url;
  }
}

function BookmarkRow({
  bookmark,
  selected,
  onSelect,
}: {
  bookmark: Bookmark;
  selected: boolean;
  onSelect: () => void;
}) {
  const active = bookmark.latestBackup?.status === "running" || bookmark.latestBackup?.status === "queued";
  return (
    <button
      type="button"
      className={cx("ledger-row", selected && "is-selected")}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${bookmarkTitle(bookmark)}，${bookmark.domain}，${bookmark.backupCount} 次备份`}
    >
      <span className="row-accession">{bookmark.accession}</span>
      <span className="row-text">
        <span className="row-title">{bookmarkTitle(bookmark)}</span>
        <span className="row-sub">
          <span className="row-domain">{bookmark.domain}</span>
          {active ? (
            <span className="row-live">
              <span className="live-dot" aria-hidden="true" />
              {bookmark.latestBackup?.status === "running" ? "正在拍快照" : "等待备份"}
            </span>
          ) : bookmark.lastStatus === "failed" ? (
            <span className="row-fail">上次失败</span>
          ) : null}
        </span>
      </span>
      <span className="row-marks">
        <BackupStrip backups={bookmark.recentBackups} />
        <span className="strip-label">
          {bookmark.backupCount > 0 ? `${bookmark.backupCount} 次` : "未备份"}
        </span>
      </span>
      <span className="row-time" title={bookmark.lastBackupAt ? formatRelative(bookmark.lastBackupAt) : "尚未备份"}>
        {formatCompact(bookmark.latestBackup?.finishedAt ?? bookmark.latestBackup?.createdAt ?? bookmark.lastBackupAt)}
      </span>
    </button>
  );
}
