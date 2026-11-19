import type { Activity, Backup, Health, Settings, Stats } from "../../../shared/types";
import { ErrorBanner } from "./States";
import { ArchiveIcon, ExternalIcon, PlayIcon, RefreshIcon, TrashIcon } from "../icons";
import {
  cx,
  formatCompact,
  formatDateTime,
  formatDuration,
  formatNext,
  formatSize,
  useNow,
} from "../utils";

type Props = {
  activity: (Activity & { stats: Stats }) | null;
  health: Health | null;
  settings: Settings | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onBackupAll: () => void;
  onReleaseBrowser: () => void;
  onSelectBookmark: (id: number) => void;
  onCancel: (backup: Backup) => void;
};

export function ActivityView({
  activity,
  health,
  settings,
  loading,
  error,
  onRefresh,
  onBackupAll,
  onReleaseBrowser,
  onSelectBookmark,
  onCancel,
}: Props) {
  const stats = activity?.stats ?? null;
  const browserText =
    health?.running
      ? "浏览器正在工作"
      : health?.browserState === "warm"
        ? "浏览器已就绪"
        : health?.browserState === "starting"
          ? "浏览器正在启动"
          : health?.browserState === "error"
            ? "浏览器未就绪"
            : "浏览器待机，内存已释放";
  const statusTone = health?.running
    ? "busy"
    : health?.browserState === "warm"
      ? "warm"
      : health?.browserState === "starting"
        ? "busy"
        : health?.browserState === "error"
          ? "error"
          : "cold";

  return (
    <div className="page-scroll">
      <div className="page-inner activity-page">
        <header className="page-head">
          <div>
            <p className="page-kicker">备份队列与历史</p>
            <h1>活动</h1>
            <p className="page-lede">看一眼队列、正在保存的快照，以及最近的备份结果。</p>
          </div>
          <div className="page-actions">
            <button type="button" className="btn btn-quiet" onClick={onRefresh} title="刷新活动">
              <RefreshIcon size={14} />
              刷新
            </button>
            <button type="button" className="btn btn-primary" onClick={onBackupAll}>
              <PlayIcon size={13} />
              全部备份
            </button>
          </div>
        </header>

        <div className="activity-stats">
          <Stat value={stats?.running ?? 0} label="正在备份" live={(stats?.running ?? 0) > 0} />
          <Stat value={stats?.queue ?? 0} label="排队中" />
          <Stat value={stats?.backups7d ?? 0} label="七日快照" />
          <Stat value={formatSize(stats?.storedBytes)} label="已存占用" />
        </div>

        <div className="browser-strip">
          <span className={cx("browser-status", `is-${statusTone}`)}>
            <span className="status-dot" aria-hidden="true" />
            {browserText}
          </span>
          <span className="browser-note">
            {health
              ? `空闲 ${settings?.browserIdleMinutes ?? 5} 分钟后自动释放`
              : "正在读取服务状态"}
          </span>
          {health?.browserState === "warm" && !health.running ? (
            <button type="button" className="text-btn" onClick={onReleaseBrowser}>
              立即释放
            </button>
          ) : null}
        </div>

        {error ? <ErrorBanner message={error} onRetry={onRefresh} /> : null}

        <section className="activity-section">
          <SectionHead title="正在备份" count={activity?.running.length ?? 0} />
          {loading && !activity ? (
            <p className="section-empty">正在读取队列…</p>
          ) : activity && activity.running.length > 0 ? (
            <div className="running-list">
              {activity.running.map((backup) => (
                <RunningRow key={backup.id} backup={backup} onOpen={() => onSelectBookmark(backup.bookmarkId)} />
              ))}
            </div>
          ) : (
            <p className="section-empty">现在没有正在保存的页面。</p>
          )}
        </section>

        <section className="activity-section">
          <SectionHead title="排队中" count={activity?.queued.length ?? 0} />
          {activity && activity.queued.length > 0 ? (
            <ol className="queue-list">
              {activity.queued.map((backup, index) => (
                <li className="queue-row" key={backup.id}>
                  <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
                  <button type="button" className="queue-main" onClick={() => onSelectBookmark(backup.bookmarkId)}>
                    <span className="queue-title">{backup.bookmarkTitle || backup.bookmarkUrl}</span>
                    <span className="queue-meta">
                      {originLabel(backup.requestedBy)}，{formatRelativeShort(backup.createdAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => onCancel(backup)}
                    aria-label="取消这次备份"
                    title="取消这次备份"
                  >
                    <TrashIcon size={14} />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="section-empty">队列是空的。</p>
          )}
        </section>

        <section className="activity-section">
          <SectionHead title="接下来" count={activity?.upcoming.length ?? 0} />
          {activity && activity.upcoming.length > 0 ? (
            <ul className="upcoming-list">
              {activity.upcoming.map((bookmark) => (
                <li key={bookmark.id}>
                  <button type="button" className="upcoming-row" onClick={() => onSelectBookmark(bookmark.id)}>
                    <span className="upcoming-time">{formatNext(bookmark.nextBackupAt)}</span>
                    <span className="upcoming-title">{bookmark.title || bookmark.domain}</span>
                    <span className="upcoming-domain">{bookmark.domain}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="section-empty">
              {settings?.autoBackupEnabled === false ? "自动备份已暂停。" : "还没有安排下一次自动备份。"}
            </p>
          )}
        </section>

        <section className="activity-section">
          <SectionHead title="最近完成" count={activity?.recent.length ?? 0} />
          {activity && activity.recent.length > 0 ? (
            <div className="recent-table" role="table" aria-label="最近的备份结果">
              <div className="recent-head" role="row">
                <span role="columnheader">时间</span>
                <span role="columnheader">收藏</span>
                <span role="columnheader">结果</span>
                <span role="columnheader">大小</span>
                <span role="columnheader">耗时</span>
                <span role="columnheader" aria-label="操作" />
              </div>
              {activity.recent.map((backup) => (
                <div className={cx("recent-row", `is-${backup.status}`)} role="row" key={backup.id}>
                  <span className="recent-time" role="cell" title={formatDateTime(backup.finishedAt ?? backup.createdAt)}>
                    {formatCompact(backup.finishedAt ?? backup.createdAt)}
                  </span>
                  <button
                    type="button"
                    className="recent-title"
                    role="cell"
                    onClick={() => onSelectBookmark(backup.bookmarkId)}
                  >
                    {backup.bookmarkTitle || backup.bookmarkUrl}
                  </button>
                  <span className={cx("recent-result", `is-${backup.status}`)} role="cell">
                    <span className="result-dot" aria-hidden="true" />
                    {backup.status === "success" ? "已保存" : "失败"}
                  </span>
                  <span className="recent-number" role="cell">
                    {formatSize(backup.size)}
                  </span>
                  <span className="recent-number" role="cell">
                    {formatDuration(backup.durationMs)}
                  </span>
                  <span className="recent-action" role="cell">
                    {backup.status === "success" && backup.archiveUrl ? (
                      <a
                        className="icon-btn"
                        href={backup.archiveUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label="打开这份快照"
                      >
                        <ExternalIcon size={14} />
                      </a>
                    ) : (
                      <button type="button" className="text-btn compact" onClick={() => onSelectBookmark(backup.bookmarkId)}>
                        查看
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="section-empty">还没有备份结果。</p>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ value, label, live = false }: { value: number | string; label: string; live?: boolean }) {
  return (
    <div className={cx("activity-stat", live && "is-live")}>
      <span className="activity-stat-value">{value}</span>
      <span className="activity-stat-label">{label}</span>
    </div>
  );
}

function SectionHead({ title, count }: { title: string; count: number }) {
  return (
    <div className="section-head activity-section-head">
      <h2>{title}</h2>
      <span className="section-count">{count}</span>
    </div>
  );
}

function RunningRow({ backup, onOpen }: { backup: Backup; onOpen: () => void }) {
  const now = useNow(true);
  const elapsed = backup.startedAt ? Math.max(1, Math.floor((now - backup.startedAt) / 1000)) : 0;
  return (
    <div className="running-row">
      <div className="running-icon">
        <ArchiveIcon size={16} />
      </div>
      <div className="running-main">
        <button type="button" className="running-title" onClick={onOpen}>
          {backup.bookmarkTitle || backup.bookmarkUrl}
        </button>
        <p className="running-meta">
          已进行 {elapsed} 秒，{originLabel(backup.requestedBy)}
        </p>
        <span className="running-progress" aria-hidden="true">
          <span />
        </span>
      </div>
    </div>
  );
}

function originLabel(origin: string): string {
  switch (origin) {
    case "scheduler":
      return "自动";
    case "extension":
      return "浏览器扩展";
    case "initial":
      return "首次存入";
    case "retry":
      return "重试";
    default:
      return "手动";
  }
}

function formatRelativeShort(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return formatDateTime(timestamp);
}
