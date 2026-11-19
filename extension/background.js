const MENU_ID = "linkbag-save";
const DEFAULT_SERVER = "http://127.0.0.1:8787";

async function serverUrl() {
  const stored = await chrome.storage.local.get("serverUrl");
  return String(stored.serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
}

function createMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "存入 LinkBag",
      contexts: ["page", "link"],
    });
  });
}

chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);

function badge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

let resetTimer;

function flashBadge(text, color, title) {
  clearTimeout(resetTimer);
  badge(text, color);
  chrome.action.setTitle({ title: title || "LinkBag" });
  resetTimer = setTimeout(() => {
    badge("", "#2D463B");
    chrome.action.setTitle({ title: "LinkBag" });
  }, 2800);
}

async function saveLink(url) {
  flashBadge("…", "#A8792D", "正在存入 LinkBag…");
  try {
    const base = await serverUrl();
    const response = await fetch(`${base}/api/bookmarks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LinkBag": "1",
      },
      body: JSON.stringify({ url, source: "extension" }),
    });
    if (!response.ok) {
      let message = "存入失败";
      try {
        const data = await response.json();
        message = data?.error?.message || message;
      } catch {
        // keep the fallback
      }
      throw new Error(message);
    }
    const data = await response.json();
    flashBadge(
      "✓",
      "#2D463B",
      data.created ? "已存入 LinkBag，正在备份" : "已在 LinkBag 中，已重新加入备份",
    );
  } catch (error) {
    flashBadge("!", "#A63B2E", `LinkBag 服务未响应：${String(error.message || error)}`);
  }
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  const url = info.linkUrl || info.pageUrl;
  if (url) void saveLink(url);
});
