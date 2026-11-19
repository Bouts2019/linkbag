export function normalizeUrl(raw: string): string | null {
  let input = raw.trim();
  if (!input || input.length > 4096) return null;
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)) {
    input = "https://" + input;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || (!url.hostname.includes(".") && url.hostname !== "localhost" && !isIp(url.hostname))) {
    return null;
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  url.hash = "";
  return url.href;
}

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

export function bookmarkKey(url: string): string {
  const parsed = new URL(url);
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const defaultPort =
    (protocol === "http:" && parsed.port === "80") || (protocol === "https:" && parsed.port === "443");
  const port = parsed.port && !defaultPort ? `:${parsed.port}` : "";
  const path = parsed.pathname || "/";
  return `${protocol}//${host}${port}${path}${parsed.search}`;
}

export function displayDomain(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function accession(id: number): string {
  return `LB-${String(id).padStart(4, "0")}`;
}

export function sanitizeFilename(name: string, fallback = "archive"): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function extractPageMeta(html: string): { title: string; excerpt: string } {
  const titleMatch =
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
  const title = titleMatch ? decodeEntities(titleMatch[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 500) : "";

  let excerpt = "";
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const name =
      tag.match(/\b(?:name|property)=["'](?:description|og:description)["']/i) &&
      tag.match(/\bcontent=["']([^"']*)["']/i);
    if (name?.[1]) {
      excerpt = decodeEntities(name[1]).replace(/\s+/g, " ").trim().slice(0, 600);
      break;
    }
  }
  return { title, excerpt };
}

export function clampText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseInterval(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (n === 0) return 0;
  if (n < 15 || n > 60 * 24 * 365) return undefined;
  return Math.floor(n);
}

export function intervalLabel(minutes: number | null, fallback: number): string {
  const value = minutes ?? fallback;
  if (value === 0) return "仅手动";
  if (value % 10080 === 0) return `每 ${value / 10080} 周`;
  if (value % 1440 === 0) return `每 ${value / 1440} 天`;
  if (value % 60 === 0) return `每 ${value / 60} 小时`;
  return `每 ${value} 分钟`;
}
