import { describe, expect, test } from "bun:test";
import { detectChallenge } from "./challenge";

describe("detectChallenge", () => {
  test("recognizes the WeChat environment verification page", () => {
    const html = `<title>Weixin Official Accounts Platform</title>
      <h2>环境异常</h2><p>当前环境异常，完成验证后即可继续访问。</p>`;
    expect(detectChallenge(html, "Weixin Official Accounts Platform")).toBe("微信环境验证");
  });

  test("recognizes Cloudflare challenge and block pages", () => {
    expect(
      detectChallenge(
        `<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script>`,
        "Just a moment...",
      ),
    ).toBe("Cloudflare 验证");
    expect(
      detectChallenge(
        `<title>Attention Required! | Cloudflare</title><p>Cloudflare Ray ID</p>`,
        "Attention Required! | Cloudflare",
      ),
    ).toBe("Cloudflare 验证");
  });

  test("recognizes a few other interstitials", () => {
    expect(detectChallenge(`<p>Request unsuccessful. Incapsula incident ID: 123</p>`)).toBe("Imperva 拦截");
    expect(detectChallenge(`<div id="px-captcha"></div>`)).toBe("PerimeterX 验证");
    expect(detectChallenge(`<p>Please verify you are human</p>`)).toBe("人机验证");
  });

  test("does not flag normal pages that mention captcha", () => {
    expect(
      detectChallenge(
        `<title>How to add a captcha to your form</title><p>Use a captcha service.</p>`,
        "How to add a captcha to your form",
      ),
    ).toBeNull();
    expect(
      detectChallenge(
        `<title>27 万 Star 的 DeepSeek Harness</title><p>rich_media_content</p>`,
        "27 万 Star 的 DeepSeek Harness",
      ),
    ).toBeNull();
  });
});
