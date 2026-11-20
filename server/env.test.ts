import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, parseEnvFile } from "./env";

const touched: string[] = [];
const tempDirs: string[] = [];

function setEnv(key: string, value: string | undefined): void {
  if (!touched.includes(key)) touched.push(key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function tempEnvFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "linkbag-env-"));
  tempDirs.push(dir);
  const path = join(dir, "linkbag.env");
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key];
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("parseEnvFile", () => {
  test("handles comments, export, quotes and inline comments", () => {
    const values = parseEnvFile(`
# comment
LINKBAG_API_ORIGIN=https://api.example.com/linkbag
export LINKBAG_ARCHIVE_ORIGIN="https://archive.example.com"
LINKBAG_NOTE='single # not a comment'
LINKBAG_TRAILING=https://example.com  # 行尾注释
EMPTY=
BAD LINE
`);
    expect(values).toEqual({
      LINKBAG_API_ORIGIN: "https://api.example.com/linkbag",
      LINKBAG_ARCHIVE_ORIGIN: "https://archive.example.com",
      LINKBAG_NOTE: "single # not a comment",
      LINKBAG_TRAILING: "https://example.com",
      EMPTY: "",
    });
  });

  test("decodes escapes inside double quotes", () => {
    const values = parseEnvFile(`LINKBAG_VALUE="line1\\nline2\\t\\"quoted\\""`);
    expect(values.LINKBAG_VALUE).toBe('line1\nline2\t"quoted"');
  });
});

describe("loadEnvFile", () => {
  test("overrides existing LINKBAG values and ignores other keys", () => {
    setEnv("LINKBAG_TEST_ORIGIN", "http://old");
    setEnv("OTHER_TEST_KEY", "keep");
    const path = tempEnvFile(`
LINKBAG_TEST_ORIGIN=https://new
OTHER_TEST_KEY=replaced
LINKBAG_TEST_EMPTY=
`);
    expect(loadEnvFile(path)).toBe(true);
    expect(process.env.LINKBAG_TEST_ORIGIN).toBe("https://new");
    expect(process.env.OTHER_TEST_KEY).toBe("keep");
    expect(process.env.LINKBAG_TEST_EMPTY).toBe("");
    setEnv("LINKBAG_TEST_EMPTY", undefined);
  });

  test("returns false for a missing file", () => {
    expect(loadEnvFile(join(tmpdir(), "linkbag-missing-env-file"))).toBe(false);
  });
});
