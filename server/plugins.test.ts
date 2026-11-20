import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "./db";
import { isValidPluginId, PluginManager, pluginHostMatches } from "./plugins";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "linkbag-plugins-"));
  tempDirs.push(dir);
  return dir;
}

function fakeStore(initial: Record<string, boolean> = {}): Store {
  const states = new Map(Object.entries(initial));
  return {
    pluginStates: () => new Map(states),
    setPluginEnabled: (pluginId: string, enabled: boolean) => {
      states.set(pluginId, enabled);
    },
  } as unknown as Store;
}

function installPlugin(dir: string, manifest: Record<string, unknown>, source: string): void {
  const pluginDir = join(dir, String(manifest.id));
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest));
  writeFileSync(join(pluginDir, String(manifest.entry ?? "index.js")), source);
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("pluginHostMatches", () => {
  test("matches exact, wildcard and subdomain patterns", () => {
    expect(pluginHostMatches("mp.weixin.qq.com", "mp.weixin.qq.com")).toBe(true);
    expect(pluginHostMatches("MP.WEIXIN.QQ.COM", "mp.weixin.qq.com")).toBe(true);
    expect(pluginHostMatches("*.weixin.qq.com", "mp.weixin.qq.com")).toBe(true);
    expect(pluginHostMatches("*.weixin.qq.com", "weixin.qq.com")).toBe(false);
    expect(pluginHostMatches("weixin.qq.com", "mp.weixin.qq.com")).toBe(false);
    expect(pluginHostMatches("https://mp.weixin.qq.com/s/abc", "mp.weixin.qq.com")).toBe(true);
    expect(pluginHostMatches("*", "anything.example")).toBe(true);
  });
});

describe("plugin ids", () => {
  test("accepts safe ids only", () => {
    expect(isValidPluginId("wechat-cover")).toBe(true);
    expect(isValidPluginId("my_plugin2")).toBe(true);
    expect(isValidPluginId("../evil")).toBe(false);
    expect(isValidPluginId("UPPER")).toBe(false);
    expect(isValidPluginId("")).toBe(false);
    expect(isValidPluginId("-leading")).toBe(false);
  });
});

describe("PluginManager", () => {
  test("loads manifests and skips duplicate ids", async () => {
    const builtinDir = tempDir();
    const userDir = tempDir();
    installPlugin(
      builtinDir,
      { id: "demo", name: "内置示例", version: "1.0.0", hosts: ["example.com"] },
      "export default { async afterCapture() {} };",
    );
    installPlugin(
      userDir,
      { id: "demo", name: "重复插件", version: "2.0.0", hosts: ["*"] },
      "export default { async afterCapture() {} };",
    );

    const manager = new PluginManager(fakeStore(), { builtinDir, userDir });
    const plugins = await manager.load();

    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      id: "demo",
      name: "内置示例",
      builtin: true,
      enabled: true,
      error: null,
    });
    expect(manager.hasFor("https://example.com/post")).toBe(true);
    expect(manager.hasFor("https://other.com/post")).toBe(false);
  });

  test("records load errors without failing the scan", async () => {
    const userDir = tempDir();
    installPlugin(userDir, { id: "broken", defaultEnabled: true }, "export default { afterCapture: 42 };");
    installPlugin(userDir, { id: "ok", defaultEnabled: true }, "export default { async afterCapture() {} };");

    const manager = new PluginManager(fakeStore(), { builtinDir: tempDir(), userDir });
    const plugins = await manager.load();

    expect(plugins.map((plugin) => plugin.id)).toEqual(["broken", "ok"]);
    expect(plugins.find((plugin) => plugin.id === "broken")?.error).toContain("afterCapture");
    expect(manager.hasFor("https://example.com/")).toBe(true);
  });

  test("runs matching plugins, writes assets and can rewrite html", async () => {
    const userDir = tempDir();
    installPlugin(userDir, { id: "asset-demo", hosts: ["example.com"], defaultEnabled: true }, `
      export default {
        async afterCapture(ctx) {
          await ctx.saveAsset({
            name: "cover.PNG",
            data: new Uint8Array([1, 2, 3]),
            contentType: "image/png; charset=binary",
            role: "cover",
            label: "封面图",
          });
          return { html: ctx.html + "<!-- plugin -->" };
        },
      };
    `);

    const manager = new PluginManager(fakeStore(), { builtinDir: tempDir(), userDir });
    await manager.load();
    const assetsDir = join(tempDir(), "assets");
    const result = await manager.run({
      url: "https://example.com/post",
      title: "示例",
      html: "<html></html>",
      backupId: 7,
      assetsDir,
    });

    expect(result.html).toBe("<html></html><!-- plugin -->");
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      pluginId: "asset-demo",
      role: "cover",
      label: "封面图",
      filename: "cover.png",
      contentType: "image/png",
      size: 3,
    });
    expect(readFileSync(join(assetsDir, "asset-demo", "cover.png"))).toEqual(Buffer.from([1, 2, 3]));
  });

  test("sanitizes asset filenames and rejects oversized data", async () => {
    const userDir = tempDir();
    installPlugin(userDir, { id: "names", defaultEnabled: true }, `
      export default {
        async afterCapture(ctx) {
          await ctx.saveAsset({ name: "../../标题 / 封面.jpg", data: "x", contentType: "image/jpeg" });
          try {
            await ctx.saveAsset({ name: "big.bin", data: new Uint8Array(25 * 1024 * 1024 + 1) });
          } catch (error) {
            ctx.log(String(error.message));
          }
        },
      };
    `);

    const manager = new PluginManager(fakeStore(), { builtinDir: tempDir(), userDir });
    await manager.load();
    const assetsDir = join(tempDir(), "assets");
    const messages: string[] = [];
    const result = await manager.run({
      url: "https://example.com/",
      title: "",
      html: "",
      backupId: 1,
      assetsDir,
      log: (message) => messages.push(message),
    });

    expect(result.assets).toHaveLength(1);
    const filename = result.assets[0]?.filename ?? "";
    expect(filename).toMatch(/^[A-Za-z0-9_-]+\.jpg$/);
    expect(existsSync(join(assetsDir, "names", filename))).toBe(true);
    expect(messages.some((message) => message.includes("25 MB"))).toBe(true);
  });

  test("respects disabled plugins and host filters", async () => {
    const userDir = tempDir();
    installPlugin(userDir, { id: "hosted", hosts: ["mp.weixin.qq.com"] }, `
      export default {
        async afterCapture(ctx) {
          await ctx.saveAsset({ name: "a.txt", data: "a", contentType: "text/plain" });
        },
      };
    `);

    const manager = new PluginManager(fakeStore({ hosted: true }), {
      builtinDir: tempDir(),
      userDir,
    });
    await manager.load();
    const assetsDir = join(tempDir(), "assets");

    const wrongHost = await manager.run({
      url: "https://example.com/",
      title: "",
      html: "",
      backupId: 1,
      assetsDir,
    });
    expect(wrongHost.assets).toHaveLength(0);

    manager.setEnabled("hosted", false);
    expect(manager.hasFor("https://mp.weixin.qq.com/s/abc")).toBe(false);
    const disabled = await manager.run({
      url: "https://mp.weixin.qq.com/s/abc",
      title: "",
      html: "",
      backupId: 2,
      assetsDir,
    });
    expect(disabled.assets).toHaveLength(0);
  });

  test("removes assets when a plugin throws", async () => {
    const userDir = tempDir();
    installPlugin(userDir, { id: "fails", defaultEnabled: true }, `
      export default {
        async afterCapture(ctx) {
          await ctx.saveAsset({ name: "partial.txt", data: "partial" });
          throw new Error("boom");
        },
      };
    `);

    const manager = new PluginManager(fakeStore(), { builtinDir: tempDir(), userDir });
    await manager.load();
    const assetsDir = join(tempDir(), "assets");
    const messages: string[] = [];
    const result = await manager.run({
      url: "https://example.com/",
      title: "",
      html: "",
      backupId: 1,
      assetsDir,
      log: (message) => messages.push(message),
    });

    expect(result.assets).toHaveLength(0);
    expect(existsSync(join(assetsDir, "fails"))).toBe(false);
    expect(messages.some((message) => message.includes("boom"))).toBe(true);
  });
});
