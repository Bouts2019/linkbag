const DEFAULT_SERVER = "http://127.0.0.1:8787";

const input = document.getElementById("serverInput");
const testBtn = document.getElementById("testBtn");
const saveBtn = document.getElementById("saveBtn");
const saveBtnBottom = document.getElementById("saveBtnBottom");
const testResult = document.getElementById("testResult");
const openDashboard = document.getElementById("openDashboard");
const version = document.getElementById("version");

function normalizeServer(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: "地址格式不正确，例如 http://127.0.0.1:8787" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "地址需要以 http:// 或 https:// 开头" };
  }
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
    return { error: "目前只支持本机地址（localhost 或 127.0.0.1）" };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return { error: "请只填写服务地址和端口，不要带路径" };
  }
  if (url.username || url.password) {
    return { error: "地址里不能包含用户名或密码" };
  }
  return { origin: url.origin };
}

function setResult(message, isError = false) {
  testResult.textContent = message;
  testResult.classList.toggle("is-error", isError);
}

async function testConnection(origin, { quiet = false } = {}) {
  if (!quiet) setResult("正在连接…");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(`${origin}/api/health`, { signal: controller.signal });
    if (!response.ok) throw new Error(`服务返回 ${response.status}`);
    const health = await response.json();
    const browser =
      health.browserState === "warm"
        ? "浏览器已就绪"
        : health.browserState === "starting"
          ? "浏览器启动中"
          : health.browserState === "error"
            ? "浏览器未就绪"
            : "浏览器待机";
    setResult(`已连接，${browser}`);
    return true;
  } catch (error) {
    setResult(error.name === "AbortError" ? "连接超时，请确认服务已启动" : "无法连接，请确认服务已启动", true);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function save() {
  const result = normalizeServer(input.value);
  if (result.error) {
    setResult(result.error, true);
    input.focus();
    return;
  }
  input.value = result.origin;
  await chrome.storage.local.set({ serverUrl: result.origin });
  setResult("地址已保存，正在连接…");
  await testConnection(result.origin);
}

function openDashboardPage() {
  const result = normalizeServer(input.value);
  const base = result.origin || DEFAULT_SERVER;
  chrome.tabs.create({ url: base });
}

testBtn.addEventListener("click", () => {
  const result = normalizeServer(input.value);
  if (result.error) {
    setResult(result.error, true);
    return;
  }
  void testConnection(result.origin);
});

saveBtn.addEventListener("click", () => void save());
saveBtnBottom.addEventListener("click", () => void save());
openDashboard.addEventListener("click", openDashboardPage);
input.addEventListener("input", () => setResult(""));

(async () => {
  version.textContent = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get("serverUrl");
  input.value = stored.serverUrl || DEFAULT_SERVER;
  void testConnection(input.value, { quiet: true });
})();
