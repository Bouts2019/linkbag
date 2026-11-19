declare module "single-file-cli/lib/cdp-client.js" {
  export function initialize(options: Record<string, unknown>): Promise<void>;
  export function getPageData(options: Record<string, unknown>): Promise<unknown>;
  export function closeBrowser(): Promise<void>;
}

declare module "single-file-cli/options.js" {
  export function getDefaultOptions(): Record<string, unknown>;
}

declare module "single-file-cli/single-file-cli-api.js" {
  export type SingleFileCapture = (
    urls: (string | [string, Record<string, unknown>])[],
  ) => Promise<unknown>;

  export function initialize(options: Record<string, unknown>): Promise<{
    capture: SingleFileCapture;
    finish: () => Promise<unknown>;
  }>;

  export function closeBrowser(): Promise<void>;
}
