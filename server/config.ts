import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function findChrome(): string | null {
  const explicit = process.env.LINKBAG_CHROME_PATH?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const name of ["google-chrome", "chromium", "chromium-browser", "chrome", "msedge"]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
}

const host = process.env.LINKBAG_HOST?.trim() || "127.0.0.1";
const port = intEnv("LINKBAG_PORT", 8787);
const archiveHost = process.env.LINKBAG_ARCHIVE_HOST?.trim() || "127.0.0.1";
const archivePort = intEnv("LINKBAG_ARCHIVE_PORT", 8788);
const publicHost = process.env.LINKBAG_PUBLIC_HOST?.trim() || (host === "0.0.0.0" ? "127.0.0.1" : host);
const dataDir = resolve(process.env.LINKBAG_DATA_DIR?.trim() || join(ROOT, "data"));
const archiveDir = join(dataDir, "archives");
const tmpDir = join(dataDir, "tmp");
const dbPath = join(dataDir, "linkbag.db");

for (const dir of [dataDir, archiveDir, tmpDir]) {
  mkdirSync(dir, { recursive: true });
}

export const config = {
  root: ROOT,
  host,
  port,
  archiveHost,
  archivePort,
  publicHost,
  archiveBaseUrl: (
    process.env.LINKBAG_ARCHIVE_ORIGIN?.trim() ||
    `http://${publicHost}:${archivePort}`
  ).replace(/\/+$/, ""),
  dataDir,
  archiveDir,
  tmpDir,
  dbPath,
  chromePath: findChrome(),
  version: "0.1.0",
  startedAt: Date.now(),
};
