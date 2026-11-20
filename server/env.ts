import { existsSync, readFileSync } from "node:fs";

const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      const inner = value.slice(1, -1);
      if (quote === "'") return inner;
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  }
  const comment = value.search(/\s+#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = ENV_LINE.exec(trimmed);
    if (!match?.[1] || match[2] === undefined) continue;
    values[match[1]] = unquote(match[2]);
  }
  return values;
}

/**
 * Load a dotenv-style file into process.env. Only LINKBAG_* keys are applied
 * so a config file cannot quietly change Bun or container internals. Values
 * from the file override variables already present in the environment, which
 * lets the data-directory file act as the deployment's source of truth even
 * when Compose also defines defaults.
 */
export function loadEnvFile(path: string): boolean {
  if (!existsSync(path)) return false;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`[env] 无法读取 ${path}: ${(error as Error).message}`);
    return false;
  }
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (!key.startsWith("LINKBAG_")) continue;
    process.env[key] = value;
  }
  return true;
}
