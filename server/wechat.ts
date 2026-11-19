import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const WECHAT_REFERER = "https://mp.weixin.qq.com/";
const WECHAT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

const MAX_VIDEOS = 20;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_VIDEO_BYTES = 500 * 1024 * 1024;
const DOWNLOAD_DEADLINE_MS = 180_000;

export type WechatVideo = {
  id: string;
  url: string;
  size: number;
};

export function isWechatArticleUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.toLowerCase() === "mp.weixin.qq.com"
    );
  } catch {
    return false;
  }
}

export function isAllowedVideoUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.toLowerCase() === "mpvideo.qpic.cn" &&
      /\.mp4$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * WeChat's media CDN redirects to an edge node whose host is an IP and whose
 * path starts with /mpvideo.qpic.cn/. Accept that shape for the final response,
 * but do not follow arbitrary redirects.
 */
function isAllowedVideoResponseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!/\.mp4$/i.test(url.pathname)) return false;
    return url.hostname.toLowerCase() === "mpvideo.qpic.cn" || url.pathname.startsWith("/mpvideo.qpic.cn/");
  } catch {
    return false;
  }
}

/**
 * WeChat embeds signed MP4 URLs in the article HTML. The strings are JavaScript
 * source with escaped ampersands (sometimes double-escaped), so decode those
 * before handing the URL to fetch.
 */
function decodeWechatUrl(value: string): string {
  return value
    .replace(/\\+x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\+u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&#x26;/gi, "&");
}

/**
 * Extract the best available quality for each video in a WeChat article.
 *
 * The article contains a `video_page_infos` array. Each video has a
 * `mp_video_trans_info` list with `format_id`, `filesize`, `url` and
 * `video_quality_level`. Only the signed direct MP4 URLs are useful here;
 * downloading them does not require running the player.
 */
export function extractWechatVideos(html: string): WechatVideo[] {
  const marker = html.indexOf("video_page_infos");
  if (marker < 0) return [];
  const section = html.slice(marker);
  const blocks = section.split(/video_id:\s*['"]/).slice(1);
  const best = new Map<string, { video: WechatVideo; quality: number }>();

  for (const block of blocks) {
    const idEnd = block.search(/['"]/);
    if (idEnd <= 0) continue;
    const id = block.slice(0, idEnd);
    if (!/^wxv_[0-9A-Za-z]+$/.test(id)) continue;

    const entries = block.split(/format_id:\s*['"]/).slice(1);
    for (const entry of entries) {
      const formatIdEnd = entry.search(/['"]/);
      if (formatIdEnd <= 0) continue;
      const size = Number.parseInt(/filesize:\s*['"](\d+)['"]/.exec(entry)?.[1] ?? "0", 10);
      const rawUrl = /url:\s*['"]([^'"]+)['"]/.exec(entry)?.[1] ?? "";
      const quality = Number.parseInt(
        /video_quality_level:\s*['"](\d+)['"]/.exec(entry)?.[1] ?? "0",
        10,
      );
      const url = decodeWechatUrl(rawUrl);
      if (!isAllowedVideoUrl(url) || !Number.isFinite(size) || size <= 0) continue;

      const current = best.get(id);
      if (
        !current ||
        quality > current.quality ||
        (quality === current.quality && size > current.video.size)
      ) {
        best.set(id, { video: { id, url, size }, quality });
      }
    }
  }

  return [...best.values()].map((entry) => entry.video);
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 300);
}

async function downloadOne(video: WechatVideo, destination: string, deadline: number): Promise<number> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("下载超时");

  const response = await fetch(video.url, {
    headers: {
      "user-agent": WECHAT_USER_AGENT,
      referer: WECHAT_REFERER,
      accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(Math.min(60_000, remaining)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!isAllowedVideoResponseUrl(response.url)) throw new Error("视频地址跳转到了不允许的主机");
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("video/") && !contentType.includes("octet-stream")) {
    throw new Error(`意外的内容类型 ${contentType || "unknown"}`);
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_VIDEO_BYTES) throw new Error(`视频过大（${declared} 字节）`);
  if (!response.body) throw new Error("视频响应为空");

  const writer = Bun.file(destination).writer();
  let received = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength;
      if (received > MAX_VIDEO_BYTES) throw new Error("视频超过大小限制");
      await writer.write(chunk);
    }
    await writer.end();
  } catch (error) {
    try {
      await writer.end();
    } catch {
      // ignore a second failure while closing
    }
    throw error;
  }
  if (received < 1024) throw new Error("视频文件为空");
  return received;
}

export async function downloadWechatVideos(
  videos: WechatVideo[],
  targetDir: string,
  log: (message: string) => void = (message) => console.error(message),
): Promise<WechatVideo[]> {
  mkdirSync(targetDir, { recursive: true });
  const selected = videos.slice(0, MAX_VIDEOS);
  if (selected.length < videos.length) {
    log(`[video] 只下载前 ${MAX_VIDEOS} 个视频，共 ${videos.length} 个`);
  }

  const deadline = Date.now() + DOWNLOAD_DEADLINE_MS;
  const downloaded: WechatVideo[] = [];
  let totalBytes = 0;

  for (const video of selected) {
    if (Date.now() >= deadline) {
      log("[video] 下载超时，跳过剩余视频");
      break;
    }
    if (video.size > MAX_VIDEO_BYTES || totalBytes + video.size > MAX_TOTAL_VIDEO_BYTES) {
      log(`[video] 跳过 ${video.id}：超过大小限制`);
      continue;
    }

    const destination = join(targetDir, `${video.id}.mp4`);
    try {
      const bytes = await downloadOne(video, destination, deadline);
      if (totalBytes + bytes > MAX_TOTAL_VIDEO_BYTES) {
        rmSync(destination, { force: true });
        log("[video] 超过总大小限制，跳过剩余视频");
        break;
      }
      downloaded.push(video);
      totalBytes += bytes;
      log(`[video] 已保存 ${video.id}（${(bytes / 1024).toFixed(0)} KB）`);
    } catch (error) {
      rmSync(destination, { force: true });
      log(`[video] 下载失败 ${video.id}：${messageOf(error)}`);
    }
  }

  return downloaded;
}

/**
 * Replace the serialized WeChat player placeholders with local <video>
 * elements. The script runs inside the archived page and uses the archive
 * route /a/<id>/videos/<file>.
 */
export function injectVideoPlayers(html: string, videos: WechatVideo[]): string {
  if (
    html.includes("data-linkbag-video-player") ||
    (!html.includes("video_iframe") && !html.includes("data-mpvid"))
  ) {
    return html;
  }

  const files = Object.fromEntries(videos.map((video) => [video.id, `${video.id}.mp4`]));
  const script = `<script data-linkbag-video-player>(function(){var files=${JSON.stringify(
    files,
  )};function run(){var nodes=document.querySelectorAll(".video_iframe[data-mpvid]");for(var i=0;i<nodes.length;i++){var el=nodes[i];if(!el.parentNode)continue;var id=el.getAttribute("data-mpvid");var ratio=parseFloat(el.getAttribute("data-ratio")||"");var base=location.pathname;while(base.length>1&&base.charAt(base.length-1)==="/")base=base.slice(0,-1);if(files[id]){var video=document.createElement("video");video.controls=true;video.playsInline=true;video.preload="metadata";video.setAttribute("data-linkbag-video",id);video.style.cssText="display:block;width:100%;height:auto;object-fit:contain;background:#000;";if(ratio>0)video.style.aspectRatio=String(ratio);video.src=base+"/videos/"+encodeURIComponent(files[id]);el.parentNode.replaceChild(video,el);}else{var box=document.createElement("div");box.textContent="视频未能备份";box.style.cssText="display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:"+(ratio>0?ratio:16/9)+";background:#111;color:#ddd;font:14px system-ui,sans-serif;";el.parentNode.replaceChild(box,el);}}}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run);else run();})();</script>`;

  const bodyEnd = html.lastIndexOf("</body>");
  return bodyEnd >= 0 ? html.slice(0, bodyEnd) + script + html.slice(bodyEnd) : html + script;
}
