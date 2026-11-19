import { useEffect, useState } from "react";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

const pad = (value: number) => String(value).padStart(2, "0");

export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDateShort(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatDateTime(timestamp: number): string {
  return `${formatDateShort(timestamp)} ${formatClock(timestamp)}`;
}

export function formatRelative(timestamp: number | null | undefined): string {
  if (!timestamp) return "尚未备份";
  const diff = Date.now() - timestamp;
  if (diff < 45_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
  const date = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= startOfToday - 24 * 60 * 60_000) return `昨天 ${formatClock(timestamp)}`;
  if (Date.now() - timestamp < 7 * 24 * 60 * 60_000) return formatDateShort(timestamp);
  return formatDateShort(timestamp);
}

export function formatNext(timestamp: number | null): string {
  if (!timestamp) return "未安排";
  const diff = timestamp - Date.now();
  if (diff <= 0) return "随时可以开始";
  if (diff < 60 * 60_000) return `${Math.max(1, Math.ceil(diff / 60_000))} 分钟后`;
  const date = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTomorrow = startOfToday + 24 * 60 * 60_000;
  if (timestamp < startOfTomorrow) return `今天 ${formatClock(timestamp)}`;
  if (timestamp < startOfTomorrow + 24 * 60 * 60_000) return `明天 ${formatClock(timestamp)}`;
  return formatDateTime(timestamp);
}

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 102_400 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

export function formatUptime(ms: number): string {
  if (ms < 60_000) return "刚刚启动";
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)} 分钟`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))} 小时`;
  return `${Math.floor(ms / (24 * 60 * 60_000))} 天`;
}

export function formatCompact(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= startOfToday) return formatClock(timestamp);
  if (timestamp >= startOfToday - 24 * 60 * 60_000) return "昨天";
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
  return `${String(date.getFullYear()).slice(2)}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function intervalLabel(minutes: number | null, fallback: number): string {
  const value = minutes ?? fallback;
  if (value === 0) return "仅手动";
  if (value % 10080 === 0) return `每 ${value / 10080} 周`;
  if (value % 1440 === 0) return value === 1440 ? "每天" : `每 ${value / 1440} 天`;
  if (value % 60 === 0) return value === 60 ? "每小时" : `每 ${value / 60} 小时`;
  return `每 ${value} 分钟`;
}

export function monogram(domain: string): string {
  const cleaned = domain.replace(/^www\./, "").trim();
  if (!cleaned) return "·";
  const first = [...cleaned][0] ?? "·";
  return first.toUpperCase();
}

export function monogramTone(domain: string): number {
  let hash = 0;
  for (const char of domain) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 5;
}

export const INTERVAL_OPTIONS = [
  { value: null, label: "跟随默认" },
  { value: 360, label: "每 6 小时" },
  { value: 720, label: "每 12 小时" },
  { value: 1440, label: "每天" },
  { value: 4320, label: "每 3 天" },
  { value: 10080, label: "每周" },
  { value: 0, label: "仅手动" },
];

export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

export function statusText(status: string | null | undefined): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "正在备份";
    case "success":
      return "已保存";
    case "failed":
      return "备份失败";
    default:
      return "尚未备份";
  }
}

export function filterCounts(bookmarks: import("../../shared/types").Bookmark[]): {
  all: number;
  backed: number;
  failing: number;
  empty: number;
} {
  return {
    all: bookmarks.length,
    backed: bookmarks.filter((bookmark) => bookmark.backupCount > 0).length,
    failing: bookmarks.filter((bookmark) => bookmark.failureCount > 0).length,
    empty: bookmarks.filter((bookmark) => bookmark.backupCount === 0).length,
  };
}
