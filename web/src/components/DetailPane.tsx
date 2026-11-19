import { useEffect, useMemo, useRef, useState } from "react";
import type { Backup, Bookmark, Settings } from "../../../shared/types";
import { DetailEmpty, ErrorBanner } from "./States";
import { Monogram } from "./Bits";
import {
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  ExternalIcon,
  PlayIcon,
  RefreshIcon,
  TrashIcon,
} from "../icons";
import {
  INTERVAL_OPTIONS,
  cx,
  formatDateTime,
  formatDuration,
  formatNext,
  formatRelative,
  formatSize,
  intervalLabel,
  statusText,
  useNow,
} from "../utils";

type DetailPaneProps = {
  bookmark: Bookmark | null;
  backups: Backup[];
  loading: boolean;
  error: string | null;
  settings: Settings | null;
  emptyLibrary?: boolean;
  onClose: () => void;
  onBackup: () => void;
  onDeleteBookmark: () => void;
  onDeleteBackup: (backup: Backup) => void;
  onChangeInterval: (minutes: number | null) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onNotify: (message: string) => void;
  onRetry: () => void;
};

export function DetailPane({
  bookmark,
  backups,
  loading,
  error,
  settings,
  emptyLibrary = false,
  onClose,
  onBackup,
  onDeleteBookmark,
  onDeleteBackup,
  onChangeInterval,
  onToggleEnabled,
  onNotify,
  onRetry,
}: DetailPaneProps) {
  const successBackups = useMemo(
    () => backups.filter((backup) => backup.status === "success"),
    [backups],
  );
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const latestSuccessId = successBackups[0]?.id ?? null;
  const previousLatest = useRef<number | null>(null);

  useEffect(() => {
    setPreviewId(latestSuccessId);
    setPreviewLoaded(false);
    previousLatest.current = latestSuccessId;
    // Reset only when the selected bookmark changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookmark?.id]);

  useEffect(() => {
    const latest = successBackups[0]?.id ?? null;
    if (latest === previousLatest.current) return;
    if (previewId === null || previewId === previousLatest.current) {
      setPreviewId(latest);
      setPreviewLoaded(false);
    }
    previousLatest.current = latest;
  }, [latestSuccessId, previewId, successBackups]);

  const preview = successBackups.find((backup) => backup.id === previewId) ?? successBackups[0] ?? null;

  useEffect(() => {
    setPreviewLoaded(false);
  }, [preview?.id]);

  if (!bookmark) {
    return (
      <aside className="detail-pane" aria-label="收藏详情">
        <DetailEmpty emptyLibrary={emptyLibrary} onAdd={() => document.getElementById("add-url")?.focus()} />
      </aside>
    );
  }

  const copyArchive = async () => {
    if (!preview?.archiveUrl) return;
    try {
      await navigator.clipboard.writeText(preview.archiveUrl);
      onNotify("备份链接已复制");
    } catch {
      onNotify("复制失败，请从地址栏手动复制");
    }
  };

  const active = bookmark.latestBackup?.status === "running" || bookmark.latestBackup?.status === "queued";
  const autoPaused = settings?.autoBackupEnabled === false || !bookmark.enabled || bookmark.intervalMinutes === 0;

  return (
    <aside className={cx("detail-pane", bookmark && "has-content")} aria-label="收藏详情">
      <div className="detail-inner">
        <div className="detail-topline">
          <button type="button" className="icon-btn back-btn" onClick={onClose} aria-label="返回收藏列表">
            <ArrowLeftIcon size={18} />
          </button>
          <span className="detail-accession">{bookmark.accession}</span>
          <div className="detail-top-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={onDeleteBookmark}
              aria-label="删除这份收藏"
              title="删除这份收藏"
            >
              <TrashIcon size={16} />
            </button>
            <button type="button" className="icon-btn close-btn" onClick={onClose} aria-label="关闭详情">
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </div>

        <div className="detail-heading">
          <Monogram domain={bookmark.domain} size="large" />
          <div className="detail-heading-text">
            <h1>{bookmark.title || bookmark.domain}</h1>
            <p className="detail-domain">
              <span>{bookmark.domain}</span>
              <a href={bookmark.url} target="_blank" rel="noreferrer noopener" className="origin-link">
                访问原网页
                <ExternalIcon size={11} />
              </a>
            </p>
          </div>
        </div>

        <div className="detail-meta">
          <span className={cx("state-label", `is-${bookmark.lastStatus ?? "none"}`)}>
            <span className="state-dot" aria-hidden="true" />
            {active
              ? bookmark.latestBackup?.status === "running"
                ? "正在拍快照"
                : "等待备份"
              : statusText(bookmark.lastStatus)}
            {bookmark.lastBackupAt && !active ? (
              <span className="state-time">最近 {formatRelative(bookmark.lastBackupAt)}</span>
            ) : null}
          </span>

          <label className="inline-field">
            <span>备份节奏</span>
            <select
              value={bookmark.intervalMinutes === null ? "default" : String(bookmark.intervalMinutes)}
              onChange={(event) => {
                const value = event.target.value;
                onChangeInterval(value === "default" ? null : Number(value));
              }}
              aria-label="这份收藏的备份节奏"
            >
              {INTERVAL_OPTIONS.map((option) => (
                <option key={String(option.value)} value={option.value === null ? "default" : String(option.value)}>
                  {option.value === null
                    ? `跟随默认（${intervalLabel(null, settings?.defaultIntervalMinutes ?? 1440)}）`
                    : option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="inline-check">
            <input
              type="checkbox"
              checked={bookmark.enabled}
              onChange={(event) => onToggleEnabled(event.target.checked)}
            />
            <span>参与自动备份</span>
          </label>
        </div>

        <p className="next-note">
          {settings?.autoBackupEnabled === false
            ? "全局自动备份已暂停，你仍然可以随时手动备份。"
            : !bookmark.enabled
              ? "这份收藏已暂停自动备份。"
              : bookmark.intervalMinutes === 0
                ? "这一份只会在你手动操作时备份。"
                : `下次自动备份：${formatNext(bookmark.nextBackupAt)}`}
        </p>

        <section className="preview-section" aria-label="快照预览">
          <div className="section-head preview-head">
            <div>
              <h2>快照预览</h2>
              <p className="section-sub">
                {preview
                  ? `${formatDateTime(preview.finishedAt ?? preview.createdAt)}，${formatSize(preview.size)}`
                  : "还没有可以预览的快照"}
              </p>
            </div>
            {preview ? (
              <div className="preview-actions">
                <button type="button" className="icon-btn" onClick={copyArchive} title="复制备份链接" aria-label="复制备份链接">
                  <CopyIcon size={15} />
                </button>
                <a className="icon-btn" href={preview.downloadUrl ?? preview.archiveUrl ?? "#"} title="下载备份" aria-label="下载备份">
                  <DownloadIcon size={15} />
                </a>
                <a
                  className="btn btn-small btn-primary"
                  href={preview.archiveUrl ?? "#"}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  打开备份
                  <ExternalIcon size={12} />
                </a>
              </div>
            ) : null}
          </div>

          <div className={cx("preview-frame", !preview && "is-empty")}>
            {preview?.archiveUrl ? (
              <>
                {!previewLoaded ? <span className="preview-scan" aria-hidden="true" /> : null}
                <iframe
                  key={preview.id}
                  src={preview.archiveUrl}
                  title={`${bookmark.title || bookmark.domain} 的备份预览`}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
                  loading="eager"
                  onLoad={() => setPreviewLoaded(true)}
                />
                {!previewLoaded ? (
                  <div className="preview-loading" role="status">
                    正在展开快照
                  </div>
                ) : null}
              </>
            ) : (
              <div className="preview-placeholder">
                {active ? (
                  <>
                    <span className="pulse-bars" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    <p>{bookmark.latestBackup?.status === "running" ? "正在保存这个页面…" : "快照已进入队列。"}</p>
                    <small>通常需要几秒钟，完成后这里会自动出现预览。</small>
                  </>
                ) : bookmark.lastStatus === "failed" ? (
                  <>
                    <p>上一次备份没有成功。</p>
                    <small>{bookmark.lastError ?? "请稍后重试。"}</small>
                    <button type="button" className="btn btn-small btn-primary" onClick={onBackup}>
                      <RefreshIcon size={13} />
                      重新备份
                    </button>
                  </>
                ) : (
                  <>
                    <p>还没有快照。</p>
                    <small>现在保存一次，之后这里会展开网页当时的样子。</small>
                    {!active ? (
                      <button type="button" className="btn btn-small btn-primary" onClick={onBackup}>
                        <PlayIcon size={12} />
                        立即备份
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        {error ? <ErrorBanner message={error} onRetry={onRetry} /> : null}

        <section className="history-section" aria-label="备份记录">
          <div className="section-head history-head">
            <div>
              <h2>备份记录</h2>
              <p className="section-sub">
                {successBackups.length} 份成功快照
                {bookmark.failureCount > 0 ? `，${bookmark.failureCount} 次失败` : ""}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-small"
              onClick={onBackup}
              disabled={Boolean(active)}
              title="为这份收藏立刻生成一份快照"
            >
              <RefreshIcon size={13} />
              {active ? "正在备份" : "立即备份"}
            </button>
          </div>

          {loading && backups.length === 0 ? (
            <div className="history-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          ) : backups.length === 0 ? (
            <p className="history-empty">还没有备份记录。第一份快照会在几秒内出现在这里。</p>
          ) : (
            <ol className="backup-list">
              {backups.map((backup) => (
                <BackupRow
                  key={backup.id}
                  backup={backup}
                  preview={preview?.id === backup.id}
                  onPreview={() => {
                    if (backup.status !== "success") return;
                    setPreviewId(backup.id);
                    setPreviewLoaded(false);
                  }}
                  onDelete={() => onDeleteBackup(backup)}
                  onRetry={onBackup}
                />
              ))}
            </ol>
          )}
        </section>
      </div>
    </aside>
  );
}

function BackupRow({
  backup,
  preview,
  onPreview,
  onDelete,
  onRetry,
}: {
  backup: Backup;
  preview: boolean;
  onPreview: () => void;
  onDelete: () => void;
  onRetry: () => void;
}) {
  const now = useNow(backup.status === "running");
  const elapsed = backup.startedAt ? now - backup.startedAt : null;
  const label =
    backup.requestedBy === "scheduler"
      ? "自动"
      : backup.requestedBy === "extension"
        ? "扩展"
        : backup.requestedBy === "initial"
          ? "首次"
          : backup.requestedBy === "retry"
            ? "重试"
            : "手动";
  return (
    <li className={cx("backup-row", preview && "is-preview", `is-${backup.status}`)}>
      <span className="backup-marker" aria-hidden="true" />
      <button
        type="button"
        className="backup-select"
        onClick={onPreview}
        disabled={backup.status !== "success"}
        aria-label={backup.status === "success" ? "在预览中打开这份快照" : "快照尚未完成"}
      >
        <span className="backup-time">{formatDateTime(backup.finishedAt ?? backup.startedAt ?? backup.createdAt)}</span>
        <span className="backup-meta">
          {backup.status === "running" ? (
            <span className="backup-live">正在拍快照，{Math.max(1, Math.floor((elapsed ?? 0) / 1000))} 秒</span>
          ) : backup.status === "queued" ? (
            <span className="backup-live">等待开始</span>
          ) : backup.status === "failed" ? (
            <span className="backup-fail">{backup.error || "备份失败"}</span>
          ) : (
            <>
              <span>{formatSize(backup.size)}</span>
              <span>{formatDuration(backup.durationMs)}</span>
              <span className="backup-origin">{label}</span>
              {backup.sameAsPrevious ? <span className="same-tag">内容未变化</span> : null}
            </>
          )}
        </span>
      </button>
      <span className="backup-actions">
        {backup.status === "success" && backup.archiveUrl ? (
          <a
            className="icon-btn"
            href={backup.archiveUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="打开这份快照"
            title="打开这份快照"
          >
            <ExternalIcon size={14} />
          </a>
        ) : null}
        {backup.status === "failed" ? (
          <button type="button" className="text-btn compact" onClick={onRetry}>
            重试
          </button>
        ) : null}
        {backup.status !== "running" ? (
          <button
            type="button"
            className="icon-btn"
            onClick={onDelete}
            aria-label="删除这份快照"
            title="删除这份快照"
          >
            <TrashIcon size={14} />
          </button>
        ) : null}
      </span>
    </li>
  );
}
