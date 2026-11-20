# 微信公众号封面图提取 —— 实现规格（可迁移版）

> 目标：给定一篇公众号文章 URL（或已保存的 HTML），稳定拿到封面图的原始图片地址，并可下载。
> 本文件描述的是**数据在哪、怎么取、怎么容错**，与语言无关；末尾附最小实现。

---

## 1. 输入输出契约

```
输入: https://mp.weixin.qq.com/s/<id>     或  本地保存的 .html
输出:
{
  "title":      "文章标题",
  "account":    "公众号名称",
  "cover_235":  "https://mmbiz.qpic.cn/.../0?wx_fmt=jpeg",   # 消息封面 2.35:1（主封面）
  "cover_11":   "https://mmbiz.qpic.cn/.../0?wx_fmt=jpeg",   # 分享卡片 1:1（可能为 null）
  "cover_169":  "https://mmbiz.qpic.cn/.../0?wx_fmt=jpeg",   # 分享卡片 16:9（新版常缺）
  "thumb":      "https://mmbiz.qpic.cn/.../0?wx_fmt=jpeg",   # 旧版正文顶部缩略图（可能为 null）
  "first_inline":"https://mmbiz.qpic.cn/.../0?wx_fmt=png",   # 正文首图（≠封面）
  "images":     ["...", "..."]                                # 正文全部图，按出现顺序去重
}
```

**关键认知**：文章页顶部显示的那张大图，多数情况下是**正文首图**，不是封面。真正用于转发/朋友圈的是 `msg_cdn_url`。右键“复制图片地址”经常拿错，这是最常见的失败原因。

---

## 2. 数据源：封面藏在页面的 6 个位置

公众号文章是**服务端直出 HTML + 内联 JS 变量**，没有独立 API，全部信息都在 HTML 里。

| # | 位置 | 正则/选择器 | 含义 | 可靠性 |
|---|---|---|---|---|
| 1 | JS 变量 | `var msg_cdn_url = "..."` | **消息封面 2.35:1**，主封面 | ★★★★★ 首选 |
| 2 | JS 变量 | `var cdn_url_1_1 = "..."` | 分享卡片 1:1 | ★★★★ 新版才有 |
| 3 | JS 变量 | `var cdn_url_16_9 = "..."` | 分享卡片 16:9 | ★★★ 老文章才有 |
| 4 | meta 标签 | `<meta property="og:image" content="...">` | 与 #1 同源，给爬虫/分享用 | ★★★★★ 兜底 |
| 5 | DOM 属性 | `id="js_cover"` 元素上的 `data-bgurl` | 旧版正文顶部缩略图 | ★★★ 新版已移除 |
| 6 | 正文容器 | `#js_content` 内 `img[data-src]` | 正文图（含首图） | ★★★★★ 用于正文图 |

辅助元数据：

| 字段 | 位置 |
|---|---|
| 标题 | `var msg_title` → `og:title` |
| 公众号 | `var nickname` → `og:article:author` |

> 注意 #1 与 #4 的关系：`og:image` 基本恒等于 `msg_cdn_url`，但顺序上仍应先取 JS 变量——个别模板里 `og:image` 指向的是分享页占位图。

---

## 3. 处理流程（6 步）

```
① 取页  →  ② 解码  →  ③ 字段抽取（按优先级）  →  ④ URL 规范化  →  ⑤ 去重  →  ⑥ 下载
```

### ① 取页

```
GET <url>
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/124
Referer:    https://mp.weixin.qq.com/
Accept-Language: zh-CN,zh;q=0.9
```

不需要 cookie。**但**数据中心 IP / 高频请求会被风控，返回的是一张“环境异常，请在微信客户端打开”的提示页（HTTP 200，不是 4xx，容易误判成功）。

**判定方法**：`页面包含「环境异常」且 不包含「msg_cdn_url」` → 视为被拦截。
**降级方案**：让用户在浏览器打开 → `Ctrl+S` 存成 `.html` → 走本地文件模式，解析逻辑完全相同。

### ② 解码

按响应头 `Content-Type` 的 charset 解码；老页面可能是 GBK，兜底顺序：`utf-8` → `gb18030` → `utf-8 + replace`。

### ③ 字段抽取

按优先级短路取值，任一命中即停：

```
cover_235 = js_var("msg_cdn_url")  ??  meta("og:image")
cover_11  = js_var("cdn_url_1_1")
cover_169 = js_var("cdn_url_16_9")
thumb     = attr(#js_cover[data-bgurl])       // 属性顺序不固定，正反两种写法都要试
```

JS 变量正则（注意转义）：

```
\bvar\s+<NAME>\s*=\s*["']([^"']*)["']
```

meta 正则（属性顺序不固定，正反两种都要试）：

```
<meta[^>]+(?:property|name)=["']<KEY>["'][^>]*?content=["']([^"']+)
<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["']<KEY>["']
```

### ④ URL 规范化（**最容易漏的一步**）

抽出来的字符串往往不是可直接用的 URL，需要依次处理：

| 问题 | 处理 |
|---|---|
| HTML 实体 | `&amp;` → `&` |
| JS 字符串转义 | `\x26` → `&`；`\u0026` → `&`；`\/` → `/` |
| 协议 | `http://` → `https://`；`//host/...` → `https://host/...` |
| 尺寸段 | `/<数字>?` → `/0?`（`0` = 原图，`640`/`300`/`1080` 是缩略图） |

URL 结构：

```
https://mmbiz.qpic.cn/<bucket>/<hash>/<size>?wx_fmt=<fmt>
        └ sz_mmbiz_jpg / mmbiz_jpg / mmbiz_png / mmbiz_gif 等
```

- `<size>`：`0` = 原图。其它数字是**服务端预设档位，不是任意缩放值**。实测同一张封面：

  | size | 结果 |
  |---|---|
  | `0` | 1080×459，37364 B（原图） |
  | `640` | 1080×459，35791 B（尺寸不变，重新压缩，字节略小） |
  | `300` | 150×64，2086 B |
  | `1080` | **HTTP 400**（非法档位） |

  结论：**统一写 `/0`**，不要自己拼数字。

- `wx_fmt`：`jpeg` / `png` / `gif` / `webp`，**决定真实格式，不要改**——把 png 改成 jpeg 会返回裂图。
- 部分 URL 带 `wxfrom=5&wx_lazy=1` 之类参数，可整段删掉，不影响。

### ⑤ 去重

同一张图会以不同 query（`from=appmsg`、`wx_lazy=1`）出现多次。**按 URL 的 path 部分去重**（`urlparse(u).path`），不要按完整 URL。

### ⑥ 下载

```
GET <image_url>
User-Agent: 同上
Referer:    https://mp.weixin.qq.com/
```

`mmbiz.qpic.cn` 对 Referer 校验很松，裸请求通常也能拿到；带上 Referer 是保险。文件名建议用 `<标题>_cover.<ext>`，扩展名从 `wx_fmt` 推断。

---

## 4. 边界情况清单

| 场景 | 表现 | 处理 |
|---|---|---|
| 新版文章 | 无 `cdn_url_16_9`、无 `js_cover` | 正常，字段返回 null 即可 |
| 纯视频 / 音频消息 | `msg_cdn_url` 为空 | 只能取视频首帧，或返回 null |
| 已删除 / 违规 | 返回提示页，无任何字段 | 明确报“文章不可访问”，不要当成空封面 |
| 风控页 | HTTP 200 + 「环境异常」 | 走本地 HTML 降级 |
| 图片 403 | 少数历史图片 | 加 Referer；仍失败则记录失败项，不要中断整批 |
| 标题含 `/ : * ? " < > \|` | 直接做文件名会失败 | 替换为 `_`，截断到 40 字符 |
| 转载 / 白名单文章 | 字段齐全，正常 | — |

---

## 5. 最小实现

### Python（核心 20 行，无第三方依赖）

```python
import re, html, urllib.request, urllib.parse

UA = {"User-Agent": "Mozilla/5.0 ... Chrome/124", "Referer": "https://mp.weixin.qq.com/"}

def fetch(url):
    raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
    return raw.decode("utf-8", "replace")

def js_var(page, name):
    m = re.search(r'\bvar\s+%s\s*=\s*["\']([^"\']*)["\']' % name, page)
    return m.group(1) if m else None

def norm(u):
    if not u: return None
    u = html.unescape(u).replace("\\x26", "&").replace("\\/", "/")
    u = u.replace("http://", "https://")
    if "mmbiz.qpic.cn" in u:
        u = re.sub(r"/(\d{2,4})(\?|$)", r"/0\2", u)
    return u

page = fetch("https://mp.weixin.qq.com/s/XXXX")
cover = norm(js_var(page, "msg_cdn_url")) or norm(
    re.search(r'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', page).group(1))
```

### Node.js

```js
const UA = { "User-Agent": "Mozilla/5.0 ... Chrome/124", Referer: "https://mp.weixin.qq.com/" };
const html = await (await fetch(url, { headers: UA })).text();

const jsVar = (p, n) => (p.match(new RegExp(`var\\s+${n}\\s*=\\s*["']([^"']*)["']`)) || [])[1];
const norm = u => u && u.replace(/&amp;/g, "&").replace(/\\x26/g, "&").replace(/\\\//g, "/")
                    .replace(/^http:/, "https:")
                    .replace(/(\/\d{2,4})(\?|$)/, "/0$2");

const cover = norm(jsVar(html, "msg_cdn_url"))
           || norm((html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) || [])[1]);
```

### Go

```go
re := regexp.MustCompile(`var\s+msg_cdn_url\s*=\s*"([^"]*)"`)
m := re.FindStringSubmatch(page)
// 同样做 &amp; / \x26 / 尺寸段 的规范化
```

---

## 6. 实测样本（2026-11，文章 `mp.weixin.qq.com/s/KOMlfLNiLKn8YrrTYMKAnQ`）

页面 3.75 MB，字段命中情况：

| 字段 | 结果 |
|---|---|
| `msg_cdn_url` | FOUND |
| `cdn_url_1_1` | FOUND |
| `cdn_url_16_9` | MISSING（新版已不输出） |
| `js_cover` | MISSING（新版已不输出） |
| `og:image` | FOUND，且与 `msg_cdn_url` **完全相同** |
| `nickname` | **MISSING** → 靠 `og:article:author` 兜底才拿到公众号名 |
| bucket 前缀 | `sz_mmbiz_jpg`（不是老版的 `mmbiz_jpg`） |

两个直接结论：

1. `nickname` 已经不是稳定字段，**必须**保留 `og:article:author` 兜底，否则公众号名会丢。
2. bucket 前缀会出现 `sz_mmbiz_*`，正则里不要写死 `mmbiz_jpg`，用 `[a-z_]*mmbiz_(jpg|png|gif)` 之类的宽松匹配。

---

## 7. 迁移验收用例

按这 4 条验收，基本能覆盖 95% 的真实情况：

1. **新版文章**：`cover_235` 非空，`cover_169` 为空 → 正常
2. **老版文章**：`cover_235` 与 `cover_169` 都非空
3. **本地 HTML**：同一份文件解析结果与在线一致（这是风控降级路径）
4. **原图校验**：请求 `/0` 得到的图，尺寸应等于或大于任何非零档位；非零档位若返回 400 属正常

---

## 8. 不值得做的方向

- **抓公众号后台接口**（`mp.weixin.qq.com/cgi-bin/...`）：需要登录态 + `token` + `t` 时间戳签名，风控更严，性价比低。
- **用 `og:image` 的缩略图直接当封面**：`og:image` 有时是压缩版，画质不够；务必走 `/0`。
- **正则匹配整页所有 `mmbiz.qpic.cn` 链接当封面**：会把正文图、二维码、作者头像全部混进来，必须先定位到 `msg_cdn_url`。
