/**
 * WeChat article cover extractor.
 *
 * The archive already contains `og:image` and sometimes the inline JS
 * variables. Prefer the original cover (`msg_cdn_url`) and fall back to
 * `og:image`; if neither is present, fetch the article once and try again.
 * See docs/plugins.md for the plugin API.
 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const REFERER = "https://mp.weixin.qq.com/";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x26;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function jsVariable(html, name) {
  const match = new RegExp(`\\bvar\\s+${escapeRegExp(name)}\\s*=\\s*["']([^"']*)["']`, "i").exec(html);
  return match?.[1] ?? null;
}

function metaContent(html, key) {
  const escaped = escapeRegExp(key);
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*?content=["']([^"']+)`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1];
  }
  return null;
}

function elementAttribute(html, id, attribute) {
  const tag = new RegExp(`<[^>]*\\bid=["']${escapeRegExp(id)}["'][^>]*>`, "i").exec(html)?.[0];
  if (!tag) return null;
  const match = new RegExp(`\\b${escapeRegExp(attribute)}=["']([^"']+)["']`, "i").exec(tag);
  return match?.[1] ?? null;
}

function firstInlineImage(html) {
  const start = html.search(/\bid=["']js_content["']/i);
  if (start < 0) return null;
  const segment = html.slice(start, start + 1_500_000);
  return /<img\b[^>]*(?:data-src|src)=["']([^"']+)["']/i.exec(segment)?.[1] ?? null;
}

/**
 * Decode JS/HTML escaping, force HTTPS, and normalize the mmbiz size segment
 * to /0 (original image). Non-image/data URLs return null.
 */
export function normalizeCoverUrl(value) {
  if (!value) return null;
  let url = String(value)
    .trim()
    .replace(/\\+x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\+u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, "/");
  url = decodeHtml(url);
  if (url.startsWith("//")) url = "https:" + url;
  if (url.startsWith("http://")) url = "https://" + url.slice("http://".length);
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (parsed.hostname === "qpic.cn" || parsed.hostname.endsWith(".qpic.cn")) {
      parsed.pathname = parsed.pathname.replace(/\/(\d{2,4})$/, "/0");
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function extractCoverData(html) {
  return {
    title: decodeHtml(jsVariable(html, "msg_title") || metaContent(html, "og:title") || ""),
    account: decodeHtml(jsVariable(html, "nickname") || metaContent(html, "og:article:author") || ""),
    cover235:
      normalizeCoverUrl(jsVariable(html, "msg_cdn_url")) ||
      normalizeCoverUrl(metaContent(html, "og:image")),
    cover11: normalizeCoverUrl(jsVariable(html, "cdn_url_1_1")),
    cover169: normalizeCoverUrl(jsVariable(html, "cdn_url_16_9")),
    thumb: normalizeCoverUrl(elementAttribute(html, "js_cover", "data-bgurl")),
    firstInline: normalizeCoverUrl(firstInlineImage(html)),
  };
}

function isAllowedImageUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "qpic.cn" || url.hostname.endsWith(".qpic.cn"))
    );
  } catch {
    return false;
  }
}

async function fetchPage(ctx) {
  const response = await ctx.fetch(ctx.url, {
    headers: {
      "user-agent": USER_AGENT,
      referer: REFERER,
      "accept-language": "zh-CN,zh;q=0.9",
      accept: "text/html,application/xhtml+xml",
    },
    signal: ctx.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1] ?? "utf-8";
  const bytes = await response.arrayBuffer();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function downloadCover(ctx, candidate) {
  if (!isAllowedImageUrl(candidate.url)) {
    ctx.log(`跳过非微信图片地址：${candidate.url}`);
    return null;
  }
  const response = await ctx.fetch(candidate.url, {
    headers: {
      "user-agent": USER_AGENT,
      referer: REFERER,
    },
    signal: ctx.signal,
  });
  if (!response.ok) {
    ctx.log(`封面下载失败 ${response.status}：${candidate.url}`);
    return null;
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    ctx.log(`封面返回了非图片内容（${contentType || "unknown"}）`);
    return null;
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) {
    ctx.log("封面超过大小限制");
    return null;
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) {
    ctx.log("封面数据为空或超过大小限制");
    return null;
  }
  return ctx.saveAsset({
    name: candidate.name,
    data,
    contentType,
    role: candidate.role,
    label: candidate.label,
  });
}

export default {
  async afterCapture(ctx) {
    let data = extractCoverData(ctx.html);
    if (!data.cover235) {
      try {
        const page = await fetchPage(ctx);
        const online = extractCoverData(page);
        data = {
          ...online,
          title: data.title || online.title,
          account: data.account || online.account,
        };
      } catch (error) {
        ctx.log(`补取文章页失败：${error?.message ?? error}`);
      }
    }

    const candidates = [
      { url: data.cover235, role: "cover", label: "文章封面（2.35:1）", name: "wechat-cover-235" },
      { url: data.cover11, role: "cover-1-1", label: "分享卡片（1:1）", name: "wechat-cover-1-1" },
      { url: data.cover169, role: "cover-16-9", label: "分享卡片（16:9）", name: "wechat-cover-16-9" },
      { url: data.thumb, role: "thumb", label: "正文顶部缩略图", name: "wechat-thumb" },
      { url: data.firstInline, role: "first-inline", label: "正文首图", name: "wechat-first-inline" },
    ];

    const seen = new Set();
    let saved = 0;
    for (const candidate of candidates) {
      if (!candidate.url) continue;
      let key;
      try {
        key = new URL(candidate.url).pathname;
      } catch {
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (await downloadCover(ctx, candidate)) saved += 1;
      } catch (error) {
        ctx.log(`保存封面失败：${error?.message ?? error}`);
      }
    }
    if (saved === 0) ctx.log("没有找到可保存的封面图");
    else ctx.log(`已保存 ${saved} 张封面图`);
  },
};
