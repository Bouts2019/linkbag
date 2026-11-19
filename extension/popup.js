const DEFAULT_SERVER = "http://127.0.0.1:8787";
const BACKUP_PREVIEW_LIMIT = 8;

const state = {
  base: DEFAULT_SERVER,
  health: null,
  stats: null,
  bookmarks: [],
  backups: new Map(),
  expandedId: null,
  query: "",
  loading: false,
  online: true,
  error: null,
  detailLoading: new Set(),
  eventSource: null,
  refreshTimer: null,
};

const els = {
  status: document.getElementById("status"),
  statusText: document.getElementById("statusText"),
  settingsBtn: document.getElementById("settingsBtn"),
  search: document.getElementById("search"),
  meta: document.getElementById("meta"),
  countLabel: document.getElementById("countLabel"),
  queueLabel: document.getElementById("queueLabel"),
  list: document.getElementById("list"),
  offline: document.getElementById("offline"),
  serverUrl: document.getElementById("serverUrl"),
  retryBtn: document.getElementById("retryBtn"),
  offlineSettings: document.getElementById("offlineSettings"),
  error: document.getElementById("error"),
  openDashboard: document.getElementById("openDashboard"),
  serverLabel: document.getElementById("serverLabel"),
  footerSettings: document.getElementById("footerSettings"),
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

class NetworkError extends Error {}

async function loadServerUrl() {
  const stored = await chrome.storage.local.get("serverUrl");
  const value = String(stored.serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
  state.base = value;
  els.serverLabel.textContent = safeHost(value);
  els.serverUrl.textContent = value;
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(state.base + path, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.method && options.method !== "GET" ? { "X-LinkBag": "1" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new NetworkError("无法连接到 LinkBag 服务");
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const data = await response.json();
      message = data?.error?.message || message;
    } catch {
      // keep fallback
    }
    throw new HttpError(message, response.status);
  }
  return response.json();
}

function compactTime(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= start) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  if (timestamp >= start - 86400000) return "昨天";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function fullTime(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

function sizeLabel(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 102400 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function durationLabel(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} 毫秒`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

function titleOf(bookmark) {
  if (bookmark.title) return bookmark.title;
  try {
    const parts = new URL(bookmark.url).pathname.split("/").filter(Boolean);
    return parts.length ? decodeURIComponent(parts[parts.length - 1]) : bookmark.domain;
  } catch {
    return bookmark.domain || bookmark.url;
  }
}

function monogramData(domain) {
  const cleaned = domain.replace(/^www\./, "").trim();
  const letter = cleaned ? [...cleaned][0].toUpperCase() : "·";
  let hash = 0;
  for (const char of domain) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { letter, tone: hash % 5 };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconSvg(paths, size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

function chevronSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m7 10 5 5 5-5");
  svg.appendChild(path);
  return svg;
}

function setStatus() {
  const health = state.health;
  const stats = state.stats;
  let text = "连接中";
  let tone = "cold";
  if (!state.online) {
    text = "未连接";
    tone = "error";
  } else if (health?.browserState === "error") {
    text = "浏览器未就绪";
    tone = "error";
  } else if (health?.running || stats?.running) {
    text = "正在备份";
    tone = "busy";
  } else if (health?.browserState === "warm") {
    text = "已就绪";
    tone = "warm";
  } else if (health?.browserState === "starting") {
    text = "启动中";
    tone = "busy";
  } else {
    text = "待机";
    tone = "cold";
  }
  els.status.className = `status is-${tone}`;
  els.statusText.textContent = text;
  els.status.title = health?.browserLastError || "备份用的浏览器会按需启动，空闲后自动释放";
}

function renderMeta() {
  const count = state.bookmarks.length;
  if (!state.online) {
    els.meta.hidden = true;
    return;
  }
  els.meta.hidden = false;
  els.countLabel.textContent = count === 0 ? "还没有收藏" : `${count} 份收藏`;
  const parts = [];
  if (state.stats?.running) parts.push("正在备份");
  else if (state.stats?.queue) parts.push(`队列 ${state.stats.queue}`);
  if (state.stats?.autoBackupEnabled === false) parts.push("自动备份已暂停");
  els.queueLabel.textContent = parts.join("，");
}

function renderSkeleton() {
  els.list.replaceChildren();
  for (let i = 0; i < 4; i += 1) {
    const row = el("div", "skeleton-row");
    row.append(el("span", "skeleton-block"), el("span", "skeleton-main"));
    row.lastChild.append(el("span", "skeleton-block"), el("span", "skeleton-block"));
    row.append(el("span", "skeleton-block short"));
    els.list.append(row);
  }
}

function openUrl(url) {
  if (url) chrome.tabs.create({ url });
}

function renderList() {
  els.list.replaceChildren();
  if (!state.online) return;
  if (state.loading && state.bookmarks.length === 0) {
    renderSkeleton();
    return;
  }

  const query = state.query.trim().toLowerCase();
  const filtered = state.bookmarks.filter((bookmark) => {
    if (!query) return true;
    return (
      bookmark.title.toLowerCase().includes(query) ||
      bookmark.domain.toLowerCase().includes(query) ||
      bookmark.url.toLowerCase().includes(query)
    );
  });

  if (state.bookmarks.length === 0) {
    const empty = el("div", "empty-list");
    empty.append(el("h2", "", "把网页收进来。"));
    empty.append(
      el("p", "", "在任意网页或链接上点右键，选择「存入 LinkBag」。这里会显示保存过的页面和每一次快照。"),
    );
    const button = el("button", "btn btn-primary", "打开控制台");
    button.type = "button";
    button.addEventListener("click", () => openUrl(state.base));
    empty.append(button);
    els.list.append(empty);
    return;
  }

  if (filtered.length === 0) {
    const empty = el("div", "empty-list");
    empty.append(el("h2", "", "没有找到。"));
    empty.append(el("p", "", "换一个标题、域名或网址试试。"));
    els.list.append(empty);
    return;
  }

  for (const bookmark of filtered) {
    els.list.append(buildBookmarkGroup(bookmark));
  }
}

function buildBookmarkGroup(bookmark) {
  const open = state.expandedId === bookmark.id;
  const group = el("div", `link-group${open ? " is-open" : ""}`);
  group.dataset.id = String(bookmark.id);
  const row = el("div", "link-row");

  const { letter, tone } = monogramData(bookmark.domain);
  row.append(el("span", `monogram tone-${tone}`, letter));

  const main = el("button", "link-main");
  main.type = "button";
  main.title = bookmark.url;
  const title = el("span", "link-title", titleOf(bookmark));
  const sub = el("span", "link-sub");
  sub.append(el("span", "link-domain", bookmark.domain));
  sub.append(el("span", "link-count", bookmark.backupCount > 0 ? `${bookmark.backupCount} 次` : "未备份"));
  if (bookmark.latestBackup?.status === "running" || bookmark.latestBackup?.status === "queued") {
    sub.append(el("span", "link-state is-live", bookmark.latestBackup.status === "running" ? "备份中" : "排队中"));
  } else if (bookmark.lastStatus === "failed") {
    sub.append(el("span", "link-state", "上次失败"));
  }
  main.append(title, sub);
  main.addEventListener("click", () => {
    const archive = bookmark.latestBackup?.archiveUrl;
    openUrl(archive || `${state.base}/#/b/${bookmark.id}`);
  });
  row.append(main);

  const latestTime =
    bookmark.latestBackup?.finishedAt ?? bookmark.latestBackup?.createdAt ?? bookmark.lastBackupAt ?? null;
  row.append(el("span", "link-time", compactTime(latestTime)));

  const expand = el("button", "expand-btn");
  expand.type = "button";
  expand.title = open ? "收起备份" : "展开备份";
  expand.setAttribute("aria-label", open ? "收起备份" : "展开备份");
  expand.setAttribute("aria-expanded", String(open));
  expand.append(chevronSvg());
  expand.addEventListener("click", () => toggleExpand(bookmark.id));
  row.append(expand);

  group.append(row);
  if (open) group.append(buildBackupPanel(bookmark));
  return group;
}

function buildBackupPanel(bookmark) {
  const panel = el("div", "backup-panel");
  const head = el("div", "panel-head");
  head.append(el("span", "", "备份记录"));
  const actions = el("div", "panel-actions");
  const backupButton = el("button", "text-btn", "现在备份");
  backupButton.type = "button";
  backupButton.disabled = bookmark.latestBackup?.status === "running" || bookmark.latestBackup?.status === "queued";
  backupButton.addEventListener("click", () => void backupNow(bookmark.id, backupButton));
  actions.append(backupButton);
  head.append(actions);
  panel.append(head);

  const backups = state.backups.get(bookmark.id);
  if (!backups) {
    panel.append(el("div", "panel-loading", "正在读取备份记录…"));
    return panel;
  }
  if (backups.length === 0) {
    panel.append(el("div", "panel-empty", "还没有快照。点「现在备份」开始第一份。"));
    return panel;
  }

  const list = el("ol", "backup-lines");
  for (const backup of backups.slice(0, BACKUP_PREVIEW_LIMIT)) {
    const line = el("li", "backup-line");
    const link = el(backup.status === "success" ? "a" : "div", "backup-link");
    if (backup.status === "success" && backup.archiveUrl) {
      link.href = backup.archiveUrl;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      link.title = "打开这份快照";
    }
    link.append(el("span", "backup-when", fullTime(backup.finishedAt ?? backup.startedAt ?? backup.createdAt)));
    const detail = el("span", "backup-detail");
    if (backup.status === "failed") {
      detail.append(el("span", "is-failed", backup.error || "备份失败"));
    } else if (backup.status === "running") {
      detail.append(el("span", "", "正在拍快照"));
    } else if (backup.status === "queued") {
      detail.append(el("span", "", "等待开始"));
    } else {
      detail.append(el("span", "", sizeLabel(backup.size)), el("span", "", durationLabel(backup.durationMs)));
      if (backup.sameAsPrevious) detail.append(el("span", "is-unchanged", "内容未变化"));
      detail.append(el("span", "", originLabel(backup.requestedBy)));
    }
    link.append(detail);
    line.append(link);
    const open = el("a", "backup-open");
    open.setAttribute("aria-label", "打开这份快照");
    open.setAttribute("title", "打开这份快照");
    if (backup.status === "success" && backup.archiveUrl) {
      open.href = backup.archiveUrl;
      open.target = "_blank";
      open.rel = "noreferrer noopener";
      open.append(iconSvg(["M14 5h5v5M19 5l-8 8", "M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4"], 12));
    } else {
      open.hidden = true;
    }
    line.append(open);
    list.append(line);
  }
  panel.append(list);

  if (backups.length > BACKUP_PREVIEW_LIMIT) {
    const more = el("button", "text-btn", `还有 ${backups.length - BACKUP_PREVIEW_LIMIT} 份，打开控制台查看`);
    more.type = "button";
    more.addEventListener("click", () => openUrl(`${state.base}/#/b/${bookmark.id}`));
    panel.append(more);
  }
  return panel;
}

function originLabel(origin) {
  switch (origin) {
    case "scheduler":
      return "自动";
    case "extension":
      return "扩展";
    case "initial":
      return "首次";
    case "retry":
      return "重试";
    default:
      return "手动";
  }
}

async function toggleExpand(id) {
  if (state.expandedId === id) {
    state.expandedId = null;
    renderList();
    return;
  }
  state.expandedId = id;
  renderList();
  if (!state.backups.has(id)) {
    await loadDetail(id);
  }
}

async function loadDetail(id) {
  if (state.detailLoading.has(id)) return;
  state.detailLoading.add(id);
  try {
    const data = await api(`/api/bookmarks/${id}`);
    state.backups.set(id, data.backups);
    state.error = null;
  } catch (error) {
    if (error instanceof NetworkError) {
      state.online = false;
      state.backups.set(id, state.backups.get(id) || []);
    } else {
      state.backups.set(id, state.backups.get(id) || []);
      showError(error.message);
    }
  } finally {
    state.detailLoading.delete(id);
    if (state.expandedId === id) {
      if (state.online) renderList();
      else render();
    }
  }
}

async function backupNow(id, button) {
  button.disabled = true;
  button.textContent = "正在加入…";
  try {
    await api(`/api/bookmarks/${id}/backup`, { method: "POST", body: JSON.stringify({ source: "extension" }) });
    button.textContent = "已加入队列";
    setTimeout(() => void loadAll(false), 400);
  } catch (error) {
    button.disabled = false;
    button.textContent = "现在备份";
    showError(error.message);
  }
}

function showError(message) {
  state.error = message;
  els.error.textContent = message;
  els.error.hidden = false;
}

function clearError() {
  state.error = null;
  els.error.hidden = true;
}

function render() {
  setStatus();
  renderMeta();
  if (!state.online) {
    els.list.hidden = true;
    els.meta.hidden = true;
    els.offline.hidden = false;
    els.serverUrl.textContent = state.base;
    els.error.hidden = true;
    return;
  }
  els.offline.hidden = true;
  els.list.hidden = false;
  renderList();
}

async function loadAll(showSkeleton = false) {
  if (state.loading) return;
  state.loading = true;
  if (showSkeleton && state.bookmarks.length === 0) renderSkeleton();
  try {
    const health = await api("/api/health");
    const list = await api("/api/bookmarks");
    state.health = health;
    state.bookmarks = list.bookmarks;
    state.stats = list.stats;
    state.online = true;
    clearError();
    if (state.expandedId) {
      void loadDetail(state.expandedId);
    }
  } catch (error) {
    if (error instanceof NetworkError) {
      state.online = false;
    } else {
      state.online = true;
      showError(error.message);
    }
  } finally {
    state.loading = false;
    render();
  }
}

function scheduleRefresh() {
  window.clearTimeout(state.refreshTimer);
  state.refreshTimer = window.setTimeout(() => void loadAll(false), 300);
}

function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  try {
    const source = new EventSource(`${state.base}/api/events`);
    source.addEventListener("change", () => scheduleRefresh());
    source.onerror = () => {
      // The polling fallback below keeps the popup usable if SSE is unavailable.
    };
    state.eventSource = source;
  } catch {
    // polling fallback
  }
}

els.search.addEventListener("input", () => {
  state.query = els.search.value;
  renderList();
});

els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.footerSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.offlineSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.openDashboard.addEventListener("click", () => openUrl(state.base));
els.retryBtn.addEventListener("click", () => {
  state.online = true;
  renderSkeleton();
  void loadAll(true);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.serverUrl) {
    void (async () => {
      await loadServerUrl();
      connectEvents();
      state.bookmarks = [];
      state.backups.clear();
      state.expandedId = null;
      state.online = true;
      await loadAll(true);
    })();
  }
});

window.addEventListener("pagehide", () => {
  state.eventSource?.close();
  window.clearTimeout(state.refreshTimer);
});

(async () => {
  await loadServerUrl();
  renderSkeleton();
  await loadAll(true);
  connectEvents();
  window.setInterval(() => {
    if (document.visibilityState === "visible") void loadAll(false);
  }, 12_000);
})();
