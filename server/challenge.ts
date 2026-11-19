/**
 * Detect the common "you are a robot / complete verification" interstitials
 * that sites return instead of the requested page. These are not valid
 * archives: saving them would replace a good snapshot with a challenge page.
 */
const CHALLENGE_MARKERS: Array<{ label: string; test: (html: string, title: string) => boolean }> = [
  {
    label: "微信环境验证",
    test: (html, title) =>
      (html.includes("当前环境异常") && html.includes("完成验证后即可继续访问")) ||
      (title.includes("weixin official accounts platform") && html.includes("captcha")),
  },
  {
    label: "Cloudflare 验证",
    test: (html, title) =>
      (title.includes("just a moment") &&
        (html.includes("cf-chl") || html.includes("challenge-platform") || html.includes("cf_chl_opt"))) ||
      (title.includes("attention required") && html.includes("cloudflare")) ||
      (html.includes("sorry, you have been blocked") && html.includes("cloudflare")),
  },
  {
    label: "人机验证",
    test: (html) =>
      html.includes("verify you are human") ||
      html.includes("verifying you are human") ||
      (html.includes("checking your browser") && html.includes("cloudflare")),
  },
  {
    label: "Imperva 拦截",
    test: (html) =>
      html.includes("request unsuccessful. incapsula incident") ||
      html.includes("incapsula incident id"),
  },
  {
    label: "PerimeterX 验证",
    test: (html) => html.includes("px-captcha") || html.includes("perimeterx"),
  },
  {
    label: "DataDome 验证",
    test: (html) => html.includes("datadome") && html.includes("captcha"),
  },
];

export function detectChallenge(html: string, title = ""): string | null {
  const sample = html.slice(0, 512 * 1024).toLowerCase();
  const normalizedTitle = title.toLowerCase();
  for (const marker of CHALLENGE_MARKERS) {
    if (marker.test(sample, normalizedTitle)) return marker.label;
  }
  return null;
}
