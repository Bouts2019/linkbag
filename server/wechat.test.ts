import { describe, expect, test } from "bun:test";
import {
  extractWechatVideos,
  injectVideoPlayers,
  isAllowedVideoUrl,
  isWechatArticleUrl,
} from "./wechat";

const ARTICLE = String.raw`
<script>
window.cgiDataNew = {
  video_page_infos: [
    {
      video_id: 'wxv_111',
      mp_video_trans_info: [
        {
          format_id: '10004',
          width: '872',
          height: '480',
          filesize: '100',
          url: 'http://mpvideo.qpic.cn/a.f10004.mp4?dis_k=1\\x26amp;dis_t=2',
          video_quality_level: '1',
        },
        {
          format_id: '10002',
          width: '1280',
          height: '704',
          filesize: '300',
          url: 'http://mpvideo.qpic.cn/a.f10002.mp4?dis_k=3\\x26amp;dis_t=4',
          video_quality_level: '3',
        },
      ],
    },
    {
      video_id: 'wxv_222',
      mp_video_trans_info: [
        {
          format_id: '10002',
          width: '1280',
          height: '720',
          filesize: '900',
          url: 'https://mpvideo.qpic.cn/b.f10002.mp4?x=1&amp;y=2',
          video_quality_level: '3',
        },
      ],
    },
  ],
};
</script>`;

describe("WeChat video metadata", () => {
  test("picks the highest quality and decodes escaped ampersands", () => {
    expect(extractWechatVideos(ARTICLE)).toEqual([
      {
        id: "wxv_111",
        url: "http://mpvideo.qpic.cn/a.f10002.mp4?dis_k=3&dis_t=4",
        size: 300,
      },
      {
        id: "wxv_222",
        url: "https://mpvideo.qpic.cn/b.f10002.mp4?x=1&y=2",
        size: 900,
      },
    ]);
  });

  test("ignores non-WeChat media hosts and malformed pages", () => {
    expect(extractWechatVideos("<html>no videos</html>")).toEqual([]);
    expect(
      extractWechatVideos(String.raw`video_page_infos: [{ video_id: 'wxv_333',
        mp_video_trans_info: [{ filesize: '100', url: 'https://example.com/x.mp4', video_quality_level: '3' }] }]`),
    ).toEqual([]);
    expect(isAllowedVideoUrl("http://mpvideo.qpic.cn/a.mp4?x=1")).toBe(true);
    expect(isAllowedVideoUrl("https://example.com/a.mp4")).toBe(false);
    expect(isWechatArticleUrl("https://mp.weixin.qq.com/s/abc")).toBe(true);
    expect(isWechatArticleUrl("https://example.com/s/abc")).toBe(false);
  });

  test("injects a local video player before </body>", () => {
    const html = `<html><body><span class="video_iframe" data-mpvid="wxv_111" data-ratio="1.8"></span></body></html>`;
    const result = injectVideoPlayers(html, [
      { id: "wxv_111", url: "http://mpvideo.qpic.cn/a.mp4", size: 300 },
    ]);
    expect(result).toContain("data-linkbag-video-player");
    expect(result).toContain("wxv_111.mp4");
    expect(result.indexOf("<script data-linkbag-video-player>")).toBeLessThan(result.indexOf("</body>"));
  });

  test("injects a placeholder when downloads failed", () => {
    const html = `<html><body><span class="video_iframe" data-mpvid="wxv_111"></span></body></html>`;
    const result = injectVideoPlayers(html, []);
    expect(result).toContain("data-linkbag-video-player");
    expect(result).toContain("视频未能备份");
  });
});
