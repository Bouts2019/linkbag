# LinkBag 插件

插件在**一份快照抓取完成之后**运行，可以读取归档 HTML、请求网络、保存伴随文件，或者改写归档 HTML。内置的 [`plugins/wechat-cover`](../plugins/wechat-cover) 就是一个例子：它把微信公众号文章的封面图取出来，作为这份备份的附件保存。提取规则见 [wechat-cover-spec.md](./wechat-cover-spec.md)。

插件不是沙箱。它们和 LinkBag 主进程运行在同一个 Bun 进程里，能访问文件系统和网络。**只安装你信任的插件代码。**

## 目录与安装

内置插件放在仓库的 `plugins/` 下，随镜像一起发布。用户插件放在数据目录的 `plugins/` 下（可以用 `LINKBAG_PLUGINS_DIR` 改）：

```text
<数据目录>/plugins/
  my-plugin/
    plugin.json
    index.js
```

在「设置 → 插件」里点「重新扫描插件」即可发现新目录，不需要重启服务。

- 每个插件一个目录，目录名最好和 `id` 一致。
- id 重复时，内置插件优先，用户目录里的同名插件会被跳过。
- 内置插件默认启用；用户插件默认**停用**，需要在设置里手动打开。
- 启用状态保存在 SQLite 的 `plugin_states` 表里，重启后保留。

## plugin.json

```json
{
  "id": "my-plugin",
  "name": "显示名称",
  "version": "1.0.0",
  "description": "一句话说明它会做什么。",
  "author": "Your Name",
  "entry": "index.js",
  "hosts": ["example.com", "*.example.org"],
  "defaultEnabled": false
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | 是 | `^[a-z0-9][a-z0-9_-]{0,63}$`，同时用于附件路径 |
| `entry` | 否 | 相对插件目录的入口文件，默认 `index.js`，不能逃出插件目录 |
| `hosts` | 否 | 只在这些主机上运行；支持精确主机、`*` 和 `*.example.com`。留空表示所有网页 |
| `defaultEnabled` | 否 | 首次发现时是否启用；内置插件默认 `true`，用户插件默认 `false` |
| 其他 | 否 | `name` 缺省为 id，`version` 缺省为 `0.0.0`，`description`/`author` 可空 |

入口文件是普通 ES 模块，可以用 `export default`、`export const plugin`，或直接导出 `afterCapture`：

```js
export default {
  async afterCapture(ctx) {
    // ...
  },
};
```

## 钩子

目前提供 `afterCapture`，在 SingleFile 抓取完成、视频处理完成后运行。可以返回 `{ html }` 用新的 HTML 替换本次归档内容。

```js
export default {
  async afterCapture(ctx) {
    // 只处理特定页面时也可以自己判断，或改用 plugin.json 的 hosts
    if (!ctx.url.includes("/article/")) return;
    const response = await ctx.fetch(ctx.url);
    const data = await response.text();
    await ctx.saveAsset({
      name: "article.txt",
      data,
      contentType: "text/plain",
      role: "text",
      label: "文章原文",
    });
  },
};
```

也可以额外导出 `matches(url)` 做更细的过滤，返回 `false` 时该插件不会运行。

## 上下文 API

`afterCapture(ctx)` 收到的对象：

| 成员 | 说明 |
|---|---|
| `ctx.url` | 收藏的原始 URL |
| `ctx.title` | 抓取时的页面标题 |
| `ctx.html` | 当前的归档 HTML（字符串） |
| `ctx.backupId` | 本次备份的数据库 id |
| `ctx.signal` | `AbortSignal`；超时或进程收尾时会中止 |
| `ctx.fetch(input, init)` | 带超时信号的 `fetch`，请求会自动绑定 `ctx.signal` |
| `ctx.saveAsset(asset)` | 保存一个伴随文件，返回已写入的描述对象 |
| `ctx.log(message)` | 写入服务日志，前缀为 `[plugin:<id>]` |

### saveAsset

```js
const saved = await ctx.saveAsset({
  name: "cover.jpg",          // 文件名提示，会被清理成安全的 ASCII 名称
  data: bytes,                // string | ArrayBuffer | Uint8Array
  contentType: "image/jpeg",  // 缺省时按扩展名推断
  role: "cover",              // 可选，短的英文标识，默认 "asset"
  label: "文章封面",            // 可选，界面上显示的名称
});
```

- 单个文件最大 25 MB。
- `name` 只作为提示：路径分隔符、中文和特殊字符会被替换，扩展名优先按 `contentType` 决定。
- 插件目录内同名文件会自动加 `-2`、`-3` 后缀。
- 保存的文件属于当前备份：可以通过 `GET /api/backups/:id/assets` 查询，也会在归档服务的 `/a/<backupId>/plugins/<pluginId>/<filename>` 下提供访问（支持 `?download=1`）。
- 删除备份时，插件目录会一起删除。

## 运行规则与错误处理

- 执行顺序按插件名称排序（内置优先）。
- 每个插件最多运行 **20 秒**，超时会被中止；`ctx.fetch` 使用同一个信号。
- 插件抛错不会让备份失败：已经写入的附件会被删除，错误写入服务日志。
- 保存的附件会随备份一起记录；内容未变化而复用旧快照时，附件仍按本次备份单独保存。

## 示例：微信公众号封面图

内置插件 `plugins/wechat-cover` 的流程：

1. 从归档 HTML 里取 `msg_cdn_url`（主封面），找不到再用 `og:image`；
2. 同时提取 `cdn_url_1_1`、`cdn_url_16_9`、`#js_cover[data-bgurl]` 和正文首图；
3. 把协议补成 HTTPS，把 `mmbiz.qpic.cn` 的尺寸段统一改成 `/0`（原图）；
4. 按 URL path 去重，只下载 `*.qpic.cn` 上的图片，带上微信 Referer；
5. 通过 `ctx.saveAsset` 保存，界面的快照详情里会显示「插件保存的文件」。

完整的提取规则、边界情况和验收用例见 [wechat-cover-spec.md](./wechat-cover-spec.md)。

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/plugins` | 列出插件、版本、适用主机、启用状态和加载错误 |
| `PATCH` | `/api/plugins/:id` | `{ "enabled": true }` 启用或停用 |
| `POST` | `/api/plugins/reload` | 重新扫描插件目录 |
| `GET` | `/api/backups/:id/assets` | 列出某次备份保存的插件附件 |

写接口需要 `X-LinkBag: 1` 请求头，和 LinkBag 其他写操作一致。

## 安全提示

- 插件拥有主进程的全部权限，不要运行来源不明的代码。
- 插件可以通过 `ctx.fetch` 访问内网地址；只安装你审阅过的插件。
- 插件保存的附件和归档 HTML 一样按不可信内容对待，归档服务使用独立源提供访问。
- 远程部署时，数据目录里的用户插件不会随镜像更新；内置插件随代码发布。
