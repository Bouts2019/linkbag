import { describe, expect, test } from "bun:test";

type CoverData = {
  title: string;
  account: string;
  cover235: string | null;
  cover11: string | null;
  cover169: string | null;
  thumb: string | null;
  firstInline: string | null;
};

type CoverModule = {
  normalizeCoverUrl: (value: unknown) => string | null;
  extractCoverData: (html: string) => CoverData;
  default: {
    afterCapture: (ctx: PluginTestContext) => Promise<void>;
  };
};

type PluginTestContext = {
  url: string;
  title: string;
  html: string;
  backupId: number;
  signal: AbortSignal;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  saveAsset: (asset: {
    name?: string;
    data: Uint8Array | string;
    contentType?: string;
    role?: string;
    label?: string;
  }) => Promise<unknown>;
  log: (message: string) => void;
};

const moduleUrl = new URL("../plugins/wechat-cover/index.js", import.meta.url).href;
const cover = (await import(moduleUrl)) as CoverModule;
const { normalizeCoverUrl, extractCoverData } = cover;

const TITLE = "新版文章标题";
const ACCOUNT = "示例公众号";
const OLD_TITLE = "老版文章";
const OLD_ACCOUNT = "老公众号";

const NEW_ARTICLE = String.raw`
<!doctype html>
<html>
<head>
  <meta property="og:title" content="${TITLE}" />
  <meta property="og:article:author" content="${ACCOUNT}" />
  <meta property="og:image" content="https://mmbiz.qpic.cn/sz_mmbiz_jpg/NEWHASH/640?wx_fmt=jpeg&amp;wxfrom=5" />
</head>
<body>
<script>
var msg_title = "${TITLE}";
var msg_cdn_url = "http:\/\/mmbiz.qpic.cn\/sz_mmbiz_jpg\/NEWHASH\/640?wx_fmt=jpeg";
var cdn_url_1_1 = "https:\/\/mmbiz.qpic.cn\/sz_mmbiz_jpg\/NEWHASH11\/300?wxfrom=5\x26amp;wx_fmt=jpeg";
</script>
<div id="js_content">
  <p><img data-src="https://mmbiz.qpic.cn/sz_mmbiz_png\/INLINE\/1080?wx_fmt=png" /></p>
</div>
</body>
</html>
`;

const OLD_ARTICLE = String.raw`
<!doctype html>
<html>
<body>
<script>
var msg_title = "${OLD_TITLE}";
var nickname = "${OLD_ACCOUNT}";
var msg_cdn_url = "http:\/\/mmbiz.qpic.cn\/mmbiz_jpg\/OLDHASH\/640?wx_fmt=jpeg";
var cdn_url_16_9 = "http:\/\/mmbiz.qpic.cn\/mmbiz_jpg\/OLD169\/300?wx_fmt=jpeg";
</script>
<div data-bgurl="http://mmbiz.qpic.cn/mmbiz_jpg/OLDTHUMB/640?wx_fmt=jpeg" id="js_cover"></div>
</body>
</html>
`;

function makeContext(html: string, pages: Record<string, string> = {}) {
  const saved: Parameters<PluginTestContext["saveAsset"]>[0][] = [];
  const requested: string[] = [];
  const ctx: PluginTestContext = {
    url: "https://mp.weixin.qq.com/s/test",
    title: "标题",
    html,
    backupId: 1,
    signal: new AbortController().signal,
    fetch: async (input) => {
      const url = String(input);
      requested.push(url);
      const page = pages[url];
      if (page !== undefined) {
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
      });
    },
    saveAsset: async (asset) => {
      saved.push(asset);
      return { filename: asset.name };
    },
    log: () => {},
  };
  return { ctx, saved, requested };
}

describe("normalizeCoverUrl", () => {
  test("decodes escaping, upgrades protocol and requests original size", () => {
    expect(
      normalizeCoverUrl(String.raw`http:\/\/mmbiz.qpic.cn\/sz_mmbiz_jpg\/abc\/640?wx_fmt=jpeg`),
    ).toBe("https://mmbiz.qpic.cn/sz_mmbiz_jpg/abc/0?wx_fmt=jpeg");
    expect(
      normalizeCoverUrl(String.raw`//mmbiz.qpic.cn/sz_mmbiz_jpg/abc/300?wxfrom=5\x26amp;wx_fmt=jpeg`),
    ).toBe("https://mmbiz.qpic.cn/sz_mmbiz_jpg/abc/0?wxfrom=5&wx_fmt=jpeg");
    expect(normalizeCoverUrl("http://mmbiz.qpic.cn/mmbiz_png/x/1080?wx_fmt=png")).toBe(
      "https://mmbiz.qpic.cn/mmbiz_png/x/0?wx_fmt=png",
    );
  });

  test("leaves non-image and non-http values out", () => {
    expect(normalizeCoverUrl("")).toBeNull();
    expect(normalizeCoverUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(normalizeCoverUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeCoverUrl(undefined)).toBeNull();
  });
});

describe("extractCoverData", () => {
  test("new articles have the main cover but no 16:9 card", () => {
    const data = extractCoverData(NEW_ARTICLE);
    expect(data.title).toBe("新版文章标题");
    expect(data.account).toBe("示例公众号");
    expect(data.cover235).toBe("https://mmbiz.qpic.cn/sz_mmbiz_jpg/NEWHASH/0?wx_fmt=jpeg");
    expect(data.cover11).toBe("https://mmbiz.qpic.cn/sz_mmbiz_jpg/NEWHASH11/0?wxfrom=5&wx_fmt=jpeg");
    expect(data.cover169).toBeNull();
    expect(data.thumb).toBeNull();
    expect(data.firstInline).toBe("https://mmbiz.qpic.cn/sz_mmbiz_png/INLINE/0?wx_fmt=png");
  });

  test("old articles expose the 16:9 card and js_cover thumb", () => {
    const data = extractCoverData(OLD_ARTICLE);
    expect(data.cover235).toBe("https://mmbiz.qpic.cn/mmbiz_jpg/OLDHASH/0?wx_fmt=jpeg");
    expect(data.cover169).toBe("https://mmbiz.qpic.cn/mmbiz_jpg/OLD169/0?wx_fmt=jpeg");
    expect(data.thumb).toBe("https://mmbiz.qpic.cn/mmbiz_jpg/OLDTHUMB/0?wx_fmt=jpeg");
    expect(data.account).toBe("老公众号");
  });

  test("local HTML parses the same as an online response", async () => {
    // The same parser runs for saved files and fetched pages; a fetched
    // response and the saved HTML it came from must yield identical fields.
    const { ctx } = makeContext("", { "https://mp.weixin.qq.com/s/test": NEW_ARTICLE });
    const response = await ctx.fetch(ctx.url);
    expect(extractCoverData(await response.text())).toEqual(extractCoverData(NEW_ARTICLE));
  });

  test("falls back to og:image when msg_cdn_url is absent", () => {
    const html = `<meta content="http://mmbiz.qpic.cn/mmbiz_jpg/FALLBACK/640?wx_fmt=jpeg" property="og:image">`;
    expect(extractCoverData(html).cover235).toBe(
      "https://mmbiz.qpic.cn/mmbiz_jpg/FALLBACK/0?wx_fmt=jpeg",
    );
  });
});

describe("wechat-cover plugin", () => {
  test("saves distinct qpic images and dedupes by path", async () => {
    const html = String.raw`
      <script>
      var msg_cdn_url = "https://mmbiz.qpic.cn/sz_mmbiz_jpg/DUP/640?wx_fmt=jpeg";
      var cdn_url_1_1 = "https://mmbiz.qpic.cn/sz_mmbiz_jpg/DUP/300?wxfrom=5&wx_fmt=jpeg";
      </script>
      <div id="js_content">
        <img data-src="https://mmbiz.qpic.cn/sz_mmbiz_jpg/DUP/0?wx_lazy=1&wx_fmt=jpeg" />
        <img data-src="https://example.com/not-wechat.jpg" />
      </div>
    `;
    const { ctx, saved, requested } = makeContext(html);
    await cover.default.afterCapture(ctx);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      role: "cover",
      label: "文章封面（2.35:1）",
      contentType: "image/jpeg",
    });
    const imageRequests = requested.filter((url) => url.includes("qpic.cn"));
    expect(imageRequests).toHaveLength(1);
    expect(requested.some((url) => url.includes("example.com"))).toBe(false);
  });

  test("fetches the article when the saved HTML has no cover", async () => {
    const { ctx, saved, requested } = makeContext("<html>blocked</html>", {
      "https://mp.weixin.qq.com/s/test": NEW_ARTICLE,
    });
    await cover.default.afterCapture(ctx);

    expect(requested[0]).toBe("https://mp.weixin.qq.com/s/test");
    expect(saved.length).toBeGreaterThan(0);
    expect(saved[0]).toMatchObject({ role: "cover" });
  });

  test("keeps working when the cover download fails", async () => {
    const html = String.raw`<script>var msg_cdn_url = "https://mmbiz.qpic.cn/sz_mmbiz_jpg/X/640?wx_fmt=jpeg";</script>`;
    const saved: unknown[] = [];
    const ctx: PluginTestContext = {
      ...makeContext(html).ctx,
      fetch: async () => new Response("nope", { status: 403 }),
      saveAsset: async (asset) => {
        saved.push(asset);
        return asset;
      },
    };
    await cover.default.afterCapture(ctx);
    expect(saved).toHaveLength(0);
  });
});
