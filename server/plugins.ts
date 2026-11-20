import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { BackupAssetInput, PluginInfo } from "../shared/types";
import { config } from "./config";
import type { Store } from "./db";

const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const PLUGIN_TIMEOUT_MS = 20_000;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".json": "application/json",
  ".txt": "text/plain",
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "application/json": ".json",
  "text/plain": ".txt",
};

export type PluginAssetInput = {
  name?: string;
  data: string | ArrayBuffer | Uint8Array;
  contentType?: string;
  role?: string;
  label?: string;
};

export type PluginContext = {
  url: string;
  title: string;
  html: string;
  backupId: number;
  signal: AbortSignal;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  saveAsset: (asset: PluginAssetInput) => Promise<BackupAssetInput>;
  log: (message: string) => void;
};

type PluginResult = { html?: string } | void;

type PluginModule = {
  afterCapture?: (context: PluginContext) => Promise<PluginResult> | PluginResult;
  matches?: (url: string) => boolean;
};

type PluginManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  hosts: string[];
  defaultEnabled: boolean;
};

type LoadedPlugin = {
  info: PluginInfo;
  dir: string;
  module: PluginModule | null;
};

type ManifestSource = {
  dir: string;
  builtin: boolean;
};

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 500);
}

export function isValidPluginId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

export function pluginHostMatches(pattern: string, hostname: string): boolean {
  const raw = pattern.trim().toLowerCase();
  const host = hostname.trim().toLowerCase();
  if (!raw || raw === "*") return true;
  let value = raw;
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname.toLowerCase();
    } catch {
      return false;
    }
  }
  if (value.startsWith("*.")) return host.endsWith(value.slice(1));
  return host === value;
}

function normalizeHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().toLowerCase())
    .slice(0, 20);
}

function readManifest(dir: string, builtin: boolean): PluginManifest | null {
  const path = join(dir, "plugin.json");
  if (!existsSync(path)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    console.error(`[plugins] 无法读取 ${path}: ${errorMessage(error)}`);
    return null;
  }
  const fallbackId = dir.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : fallbackId;
  if (!isValidPluginId(id)) {
    console.error(`[plugins] 插件 id 不合法: ${String(raw.id ?? fallbackId)}`);
    return null;
  }
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    version: typeof raw.version === "string" && raw.version.trim() ? raw.version.trim() : "0.0.0",
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    author: typeof raw.author === "string" ? raw.author.trim() : "",
    entry: typeof raw.entry === "string" && raw.entry.trim() ? raw.entry.trim() : "index.js",
    hosts: normalizeHosts(raw.hosts),
    defaultEnabled: raw.defaultEnabled === true || (raw.defaultEnabled === undefined && builtin),
  };
}

function sanitizeRole(value: unknown): string {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(role) ? role : "asset";
}

function sanitizeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : fallback;
}

function nameExtension(name: unknown): string {
  if (typeof name !== "string") return "";
  const ext = extname(name.split(/[\\/]/).pop() ?? "").toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

function normalizeContentType(value: unknown): string {
  return typeof value === "string" ? (value.split(";")[0] ?? "").trim().toLowerCase() : "";
}

function assetFilename(dir: string, name: unknown, contentType: string): string {
  const nameExt = nameExtension(name);
  const typeExt = EXTENSION_BY_MIME[contentType] ?? "";
  const ext = typeExt || nameExt || ".bin";
  const raw = typeof name === "string" ? (name.split(/[\\/]/).pop() ?? "") : "";
  const stem =
    raw
      .replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "asset";
  let filename = `${stem}${ext}`;
  let suffix = 2;
  while (existsSync(join(dir, filename))) {
    filename = `${stem}-${suffix}${ext}`;
    suffix += 1;
  }
  return filename;
}

function writePluginAsset(
  dir: string,
  plugin: LoadedPlugin,
  input: PluginAssetInput,
): BackupAssetInput {
  if (!input || typeof input !== "object" || input.data === undefined) {
    throw new Error("saveAsset 需要提供 data");
  }
  const data =
    typeof input.data === "string"
      ? Buffer.from(input.data, "utf8")
      : input.data instanceof Uint8Array
        ? Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength)
        : Buffer.from(input.data);
  if (data.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`附件超过 ${MAX_ASSET_BYTES / 1024 / 1024} MB 限制`);
  }
  const contentType =
    normalizeContentType(input.contentType) ||
    MIME_BY_EXTENSION[nameExtension(input.name)] ||
    "application/octet-stream";
  mkdirSync(dir, { recursive: true });
  const filename = assetFilename(dir, input.name, contentType);
  writeFileSync(join(dir, filename), data);
  return {
    pluginId: plugin.info.id,
    pluginName: plugin.info.name,
    role: sanitizeRole(input.role),
    label: sanitizeLabel(input.label, filename),
    filename,
    contentType,
    size: data.byteLength,
  };
}

export class PluginManager {
  private store: Store;
  private plugins: LoadedPlugin[] = [];
  private builtinDir: string;
  private userDir: string;

  constructor(store: Store, options?: { builtinDir?: string; userDir?: string }) {
    this.store = store;
    this.builtinDir = options?.builtinDir ?? config.builtinPluginsDir;
    this.userDir = options?.userDir ?? config.pluginsDir;
  }

  async load(): Promise<PluginInfo[]> {
    const states = this.store.pluginStates();
    const sources: ManifestSource[] = [
      { dir: this.builtinDir, builtin: true },
      { dir: this.userDir, builtin: false },
    ];
    const loaded: LoadedPlugin[] = [];
    const seen = new Set<string>();

    for (const source of sources) {
      if (!existsSync(source.dir)) continue;
      let entries: Dirent[];
      try {
        entries = readdirSync(source.dir, { withFileTypes: true });
      } catch (error) {
        console.error(`[plugins] 无法读取目录 ${source.dir}: ${errorMessage(error)}`);
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(source.dir, entry.name);
        const manifest = readManifest(dir, source.builtin);
        if (!manifest) continue;
        if (seen.has(manifest.id)) {
          console.error(`[plugins] 跳过重复插件 id: ${manifest.id} (${dir})`);
          continue;
        }
        seen.add(manifest.id);
        loaded.push(await this.loadOne(dir, manifest, source.builtin, states.get(manifest.id)));
      }
    }

    loaded.sort((a, b) => {
      if (a.info.builtin !== b.info.builtin) return a.info.builtin ? -1 : 1;
      return a.info.name.localeCompare(b.info.name, "zh-CN");
    });
    this.plugins = loaded;
    const errors = loaded.filter((plugin) => plugin.info.error).length;
    console.error(
      `[plugins] 已加载 ${loaded.length} 个插件${errors > 0 ? `（${errors} 个有错误）` : ""}`,
    );
    return this.list();
  }

  private async loadOne(
    dir: string,
    manifest: PluginManifest,
    builtin: boolean,
    storedEnabled: boolean | undefined,
  ): Promise<LoadedPlugin> {
    const info: PluginInfo = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      builtin,
      enabled: storedEnabled ?? manifest.defaultEnabled,
      hosts: manifest.hosts,
      error: null,
    };
    const root = resolve(dir);
    const entryPath = resolve(root, manifest.entry);
    if (entryPath !== root && !entryPath.startsWith(root + sep)) {
      info.error = "入口文件必须位于插件目录内";
      return { info, dir, module: null };
    }
    if (!existsSync(entryPath)) {
      info.error = `找不到入口文件 ${manifest.entry}`;
      return { info, dir, module: null };
    }
    try {
      const moduleUrl = `${pathToFileURL(entryPath).href}?v=${Date.now()}`;
      const imported = (await import(moduleUrl)) as Record<string, unknown> & {
        default?: unknown;
        plugin?: unknown;
        afterCapture?: unknown;
      };
      const candidate =
        imported.default ??
        imported.plugin ??
        (typeof imported.afterCapture === "function" ? imported : undefined);
      let module: PluginModule;
      if (typeof candidate === "function") {
        module = { afterCapture: candidate as PluginModule["afterCapture"] };
      } else if (candidate && typeof candidate === "object") {
        module = candidate as PluginModule;
      } else {
        throw new Error("入口文件没有导出插件对象");
      }
      if (module.afterCapture !== undefined && typeof module.afterCapture !== "function") {
        throw new Error("afterCapture 必须是函数");
      }
      if (module.matches !== undefined && typeof module.matches !== "function") {
        throw new Error("matches 必须是函数");
      }
      return { info, dir, module };
    } catch (error) {
      info.error = errorMessage(error);
      console.error(`[plugins] 加载 ${manifest.id} 失败: ${info.error}`);
      return { info, dir, module: null };
    }
  }

  list(): PluginInfo[] {
    return this.plugins.map((plugin) => ({
      ...plugin.info,
      hosts: [...plugin.info.hosts],
    }));
  }

  async reload(): Promise<PluginInfo[]> {
    return this.load();
  }

  setEnabled(pluginId: string, enabled: boolean): boolean {
    const plugin = this.plugins.find((item) => item.info.id === pluginId);
    if (!plugin) return false;
    plugin.info.enabled = enabled;
    this.store.setPluginEnabled(pluginId, enabled);
    return true;
  }

  hasFor(url: string): boolean {
    return this.plugins.some(
      (plugin) =>
        plugin.info.enabled &&
        !plugin.info.error &&
        Boolean(plugin.module?.afterCapture) &&
        this.matches(plugin, url),
    );
  }

  private matches(plugin: LoadedPlugin, rawUrl: string): boolean {
    let hostname: string;
    try {
      hostname = new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (
      plugin.info.hosts.length > 0 &&
      !plugin.info.hosts.some((pattern) => pluginHostMatches(pattern, hostname))
    ) {
      return false;
    }
    if (plugin.module?.matches) {
      try {
        return Boolean(plugin.module.matches(rawUrl));
      } catch {
        return false;
      }
    }
    return true;
  }

  async run(input: {
    url: string;
    title: string;
    html: string;
    backupId: number;
    assetsDir: string;
    log?: (message: string) => void;
  }): Promise<{ html: string; assets: BackupAssetInput[] }> {
    const plugins = this.plugins;
    const assets: BackupAssetInput[] = [];
    let html = input.html;
    const log = input.log ?? ((message: string) => console.error(message));

    for (const plugin of plugins) {
      const hook = plugin.module?.afterCapture;
      if (
        !plugin.info.enabled ||
        plugin.info.error ||
        !hook ||
        !this.matches(plugin, input.url)
      ) {
        continue;
      }
      const pluginDir = join(input.assetsDir, plugin.info.id);
      mkdirSync(pluginDir, { recursive: true });
      const collected: BackupAssetInput[] = [];
      let alive = true;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`插件执行超时（${PLUGIN_TIMEOUT_MS / 1000} 秒）`));
        }, PLUGIN_TIMEOUT_MS);
      });

      const context: PluginContext = {
        url: input.url,
        title: input.title,
        html,
        backupId: input.backupId,
        signal: controller.signal,
        fetch: (resource, init) => fetch(resource, { ...init, signal: controller.signal }),
        saveAsset: async (asset) => {
          if (!alive) throw new Error("插件已结束，不能再写入附件");
          const saved = writePluginAsset(pluginDir, plugin, asset);
          collected.push(saved);
          return saved;
        },
        log: (message) => log(`[plugin:${plugin.info.id}] ${message}`),
      };

      try {
        const result = await Promise.race([Promise.resolve(hook(context)), timeout]);
        if (result && typeof result.html === "string") html = result.html;
        assets.push(...collected);
        if (collected.length > 0) {
          log(`[plugin:${plugin.info.id}] 保存了 ${collected.length} 个附件`);
        }
      } catch (error) {
        rmSync(pluginDir, { recursive: true, force: true });
        log(`[plugin:${plugin.info.id}] 执行失败: ${errorMessage(error)}`);
      } finally {
        alive = false;
        if (timer) clearTimeout(timer);
        if (collected.length === 0) rmSync(pluginDir, { recursive: true, force: true });
      }
    }

    return { html, assets };
  }
}
