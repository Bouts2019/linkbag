import { AlertIcon, ArchiveIcon, PlusIcon } from "../icons";

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <AlertIcon size={17} />
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="text-btn" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

export function EmptyLibrary({ onFocusAdd }: { onFocusAdd: () => void }) {
  return (
    <div className="empty-library">
      <div className="empty-stack" aria-hidden="true">
        <span />
        <span />
        <span>
          <ArchiveIcon size={18} />
        </span>
      </div>
      <h2>把网页收进来。</h2>
      <p>
        粘贴一个地址，LinkBag 会把它当时的样子完整存下来；之后按你设定的节奏，继续留一份。
      </p>
      <button type="button" className="text-btn" onClick={onFocusAdd}>
        <PlusIcon size={14} />
        放入第一个链接
      </button>
    </div>
  );
}

export function NoResults({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="no-results">
      <p>{query.trim() ? `没有找到与“${query.trim()}”有关的收藏。` : "这个筛选下还没有收藏。"}</p>
      <button type="button" className="text-btn" onClick={onClear}>
        清除筛选
      </button>
    </div>
  );
}

export function LedgerSkeleton() {  return (
    <div className="ledger-skeleton" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton-line w-short" />
          <span className="skeleton-main">
            <span className="skeleton-line w-long" />
            <span className="skeleton-line w-mid" />
          </span>
          <span className="skeleton-line w-short" />
        </div>
      ))}
    </div>
  );
}

export function DetailEmpty({ onAdd, emptyLibrary = false }: { onAdd: () => void; emptyLibrary?: boolean }) {
  return (
    <div className="detail-empty">
      <div className="detail-empty-mark" aria-hidden="true">
        <span className="sheet sheet-a" />
        <span className="sheet sheet-b" />
        <span className="sheet sheet-c" />
      </div>
      <p className="detail-empty-title">
        {emptyLibrary ? (
          <>
            存进来的网页，
            <br />
            会在这里展开。
          </>
        ) : (
          <>
            选一份收藏，
            <br />
            在这里展开它的快照。
          </>
        )}
      </p>
      <p className="detail-empty-note">
        {emptyLibrary
          ? "网页会在左侧列表里排好，打开一份就能看见当时的样子。"
          : "预览直接读取本地存档，不依赖原网站。"}
      </p>
      {emptyLibrary ? null : (
        <button type="button" className="text-btn" onClick={onAdd}>
          <PlusIcon size={14} />
          放入一个链接
        </button>
      )}
    </div>
  );
}

export function ServiceDown({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="service-down" role="alert">
      <span className="service-down-code">链接服务未响应</span>
      <h2>后台还没有醒来。</h2>
      <p>{message}</p>
      <p className="service-down-hint">
        在项目目录运行 <code>mise run start</code>，或检查 8787 端口是否被其他程序占用。
      </p>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        重新连接
      </button>
    </div>
  );
}
