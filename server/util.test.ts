import { describe, expect, test } from "bun:test";
import {
  accession,
  bookmarkKey,
  displayDomain,
  extractPageMeta,
  intervalLabel,
  normalizeUrl,
  parseInterval,
  sanitizeFilename,
} from "./util";

describe("normalizeUrl", () => {
  test("adds https and a trailing slash", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
  });

  test("keeps query strings but drops fragments and credentials", () => {
    expect(normalizeUrl("https://user:pass@example.com/a?b=1#top")).toBe("https://example.com/a?b=1");
  });

  test("accepts localhost and IP addresses", () => {
    expect(normalizeUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(normalizeUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/");
  });

  test("rejects unsupported or incomplete addresses", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("ftp://example.com/file")).toBeNull();
    expect(normalizeUrl("not a host")).toBeNull();
    expect(normalizeUrl("https://example.com/" + "a".repeat(5000))).toBeNull();
  });
});

describe("bookmarkKey", () => {
  test("normalizes host case and default ports while keeping the path", () => {
    expect(bookmarkKey("https://Example.COM:443/Path?a=1#x")).toBe("https://example.com/Path?a=1");
    expect(bookmarkKey("http://example.com:80")).toBe("http://example.com/");
    expect(bookmarkKey("http://example.com:8080/a")).toBe("http://example.com:8080/a");
  });
});

describe("labels and names", () => {
  test("displayDomain strips www", () => {
    expect(displayDomain("https://www.example.com/a")).toBe("example.com");
    expect(displayDomain("https://news.ycombinator.com/")).toBe("news.ycombinator.com");
  });

  test("accession uses four digits", () => {
    expect(accession(1)).toBe("LB-0001");
    expect(accession(42)).toBe("LB-0042");
    expect(accession(12345)).toBe("LB-12345");
  });

  test("sanitizeFilename removes filesystem-reserved characters", () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(sanitizeFilename("   ")).toBe("archive");
  });
});

describe("parseInterval", () => {
  test("distinguishes unset, manual, and valid values", () => {
    expect(parseInterval(undefined)).toBeUndefined();
    expect(parseInterval(null)).toBeNull();
    expect(parseInterval(0)).toBe(0);
    expect(parseInterval("60")).toBe(60);
    expect(parseInterval(60.9)).toBe(60);
  });

  test("rejects out-of-range values", () => {
    expect(parseInterval(1)).toBeUndefined();
    expect(parseInterval(-5)).toBeUndefined();
    expect(parseInterval(60 * 24 * 366)).toBeUndefined();
    expect(parseInterval("nope")).toBeUndefined();
  });
});

describe("intervalLabel", () => {
  test("uses the largest whole unit", () => {
    expect(intervalLabel(0, 1440)).toBe("仅手动");
    expect(intervalLabel(null, 1440)).toBe("每 1 天");
    expect(intervalLabel(120, 1440)).toBe("每 2 小时");
    expect(intervalLabel(20160, 1440)).toBe("每 2 周");
    expect(intervalLabel(45, 1440)).toBe("每 45 分钟");
  });
});

describe("extractPageMeta", () => {
  test("reads title and description", () => {
    const html = `<html><head><title> A &amp; B </title>
      <meta name="description" content="First &quot;line&quot;"></head></html>`;
    expect(extractPageMeta(html)).toEqual({ title: "A & B", excerpt: 'First "line"' });
  });

  test("falls back to og:title and og:description", () => {
    const html = `<meta property="og:title" content="Open Graph">
      <meta property="og:description" content="Summary">`;
    expect(extractPageMeta(html)).toEqual({ title: "Open Graph", excerpt: "Summary" });
  });

  test("returns empty strings when metadata is missing", () => {
    expect(extractPageMeta("<body>plain</body>")).toEqual({ title: "", excerpt: "" });
  });
});
