import { useEffect, useState } from "react";
import type { Health, PluginInfo, Settings } from "../../../shared/types";
import { ErrorBanner } from "./States";
import { Switch } from "./Bits";
import { CopyIcon, PlayIcon, RefreshIcon } from "../icons";
import { formatUptime } from "../utils";

type Props = {
  settings: Settings | null;
  health: Health | null;
  plugins: PluginInfo[];
  pluginsLoading: boolean;
  loading: boolean;
  error: string | null;
  saving: boolean;
  onSave: (patch: Partial<Settings>) => Promise<void>;
  onTogglePlugin: (id: string, enabled: boolean) => void;
  onReloadPlugins: () => void;
  onReleaseBrowser: () => void;
  onBackupAll: () => void;
  onRefresh: () => void;
  onNotify: (message: string) => void;
};

export function SettingsView({
  settings,
  health,
  plugins,
  pluginsLoading,
  loading,
  error,
  saving,
  onSave,
  onTogglePlugin,
  onReloadPlugins,
  onReleaseBrowser,
  onBackupAll,
  onRefresh,
  onNotify,
}: Props) {
  const [form, setForm] = useState<Settings | null>(settings);
  const [savedSnapshot, setSavedSnapshot] = useState<Settings | null>(settings);

  useEffect(() => {
    if (settings) {
      setForm(settings);
      setSavedSnapshot(settings);
    }
  }, [settings]);

  if (!form) {
    return (
      <div className="page-scroll">
        <div className="page-inner settings-page">
          <header className="page-head">
            <div>
              <p className="page-kicker">服务与备份规则</p>
              <h1>设置</h1>
            </div>
          </header>
          {error ? <ErrorBanner message={error} onRetry={onRefresh} /> : <p className="section-empty">正在读取设置…</p>}
        </div>
      </div>
    );
  }

  const dirty =
    !savedSnapshot ||
    form.autoBackupEnabled !== savedSnapshot.autoBackupEnabled ||
    form.defaultIntervalMinutes !== savedSnapshot.defaultIntervalMinutes ||
    form.retentionCount !== savedSnapshot.retentionCount ||
    form.browserIdleMinutes !== savedSnapshot.browserIdleMinutes;

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const save = async () => {
    if (!form || !dirty) return;
    try {
      await onSave({
        autoBackupEnabled: form.autoBackupEnabled,
        defaultIntervalMinutes: form.defaultIntervalMinutes,
        retentionCount: form.retentionCount,
        browserIdleMinutes: form.browserIdleMinutes,
      });
      setSavedSnapshot(form);
    } catch {
      // App surfaces the error in a toast; the form stays dirty for a retry.
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      onNotify(`${label}已复制`);
    } catch {
      onNotify("复制失败，请手动选择");
    }
  };

  return (
    <div className="page-scroll">
      <div className="page-inner settings-page">
        <header className="page-head">
          <div>
            <p className="page-kicker">服务与备份规则</p>
            <h1>设置</h1>
            <p className="page-lede">设置一次，之后 LinkBag 会按自己的节奏把网页收好。</p>
          </div>
          <div className="page-actions">
            <button type="button" className="btn btn-quiet" onClick={onRefresh} title="刷新服务状态">
              <RefreshIcon size={14} />
              刷新
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? "正在保存" : "保存设置"}
            </button>
          </div>
        </header>

        {error ? <ErrorBanner message={error} onRetry={onRefresh} /> : null}
        {loading && !settings ? <p className="section-empty">正在读取设置…</p> : null}

        <section className="settings-section">
          <div className="settings-label">
            <h2>自动备份</h2>
            <p>决定新收藏默认多久保存一次，以及旧快照保留多少。</p>
          </div>
          <div className="settings-fields">
            <div className="field-row">
              <div className="field-copy">
                <span>允许自动备份</span>
                <small>关闭后，只有你手动触发的备份会执行。</small>
              </div>
              <Switch
                checked={form.autoBackupEnabled}
                onChange={(value) => update("autoBackupEnabled", value)}
                label={form.autoBackupEnabled ? "已开启" : "已暂停"}
              />
            </div>

            <label className="field-row">
              <span className="field-copy">
                <span>默认节奏</span>
                <small>没有单独设置的收藏会使用这个间隔。</small>
              </span>
              <select
                className="field-control"
                value={form.defaultIntervalMinutes}
                onChange={(event) => update("defaultIntervalMinutes", Number(event.target.value))}
              >
                <option value={360}>每 6 小时</option>
                <option value={720}>每 12 小时</option>
                <option value={1440}>每天</option>
                <option value={2880}>每 2 天</option>
                <option value={4320}>每 3 天</option>
                <option value={10080}>每周</option>
              </select>
            </label>

            <label className="field-row">
              <span className="field-copy">
                <span>每份收藏保留</span>
                <small>超出数量的旧快照会自动删除。填 0 表示一直保留。</small>
              </span>
              <span className="number-field">
                <input
                  className="field-control"
                  type="number"
                  min={0}
                  max={500}
                  step={1}
                  value={form.retentionCount}
                  onChange={(event) => update("retentionCount", Number(event.target.value))}
                />
                <span>份</span>
              </span>
            </label>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-label">
            <h2>资源与浏览器</h2>
            <p>LinkBag 只在需要时启动浏览器，备份完成后让它自己退场。</p>
          </div>
          <div className="settings-fields">
            <label className="field-row">
              <span className="field-copy">
                <span>空闲关闭</span>
                <small>没有备份任务后，等多久释放浏览器内存。</small>
              </span>
              <span className="number-field">
                <input
                  className="field-control"
                  type="number"
                  min={1}
                  max={240}
                  step={1}
                  value={form.browserIdleMinutes}
                  onChange={(event) => update("browserIdleMinutes", Number(event.target.value))}
                />
                <span>分钟</span>
              </span>
            </label>

            <div className="field-row">
              <div className="field-copy">
                <span>当前浏览器</span>
                <small className="mono-value" title={health?.chromePath ?? ""}>
                  {health?.chromePath ?? "未找到 Chrome 或 Edge"}
                </small>
                {health?.browserLastError ? <small className="error-text">{health.browserLastError}</small> : null}
              </div>
              <button
                type="button"
                className="btn btn-small"
                onClick={onReleaseBrowser}
                disabled={health?.browserState !== "warm" || health?.running}
                title={health?.running ? "正在备份，完成后才能释放" : "关闭备份用的浏览器"}
              >
                立即释放
              </button>
            </div>

            <div className="field-row">
              <span className="field-copy">
                <span>服务运行时间</span>
                <small>{health ? formatUptime(health.uptimeMs) : "—"}，版本 {health?.version ?? "—"}</small>
              </span>
              <button type="button" className="btn btn-small" onClick={onBackupAll}>
                <PlayIcon size={12} />
                全部备份
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-label">
            <h2>插件</h2>
            <p>快照完成后运行的扩展。插件可以保存额外文件，例如公众号封面图。</p>
          </div>
          <div className="settings-fields">
            {pluginsLoading && plugins.length === 0 ? (
              <p className="section-empty">正在扫描插件…</p>
            ) : plugins.length === 0 ? (
              <p className="section-empty">
                还没有安装插件。把插件目录放到数据目录的 plugins/ 下，然后重新扫描。
              </p>
            ) : (
              plugins.map((plugin) => (
                <div className="plugin-row" key={plugin.id}>
                  <div className="field-copy">
                    <span className="plugin-title">
                      {plugin.name}
                      <span className="plugin-version">v{plugin.version}</span>
                      {plugin.builtin ? <span className="info-badge">内置</span> : null}
                    </span>
                    {plugin.description ? <small>{plugin.description}</small> : null}
                    <small className="plugin-hosts">
                      适用于：{plugin.hosts.length > 0 ? plugin.hosts.join(", ") : "所有网页"}
                    </small>
                    {plugin.error ? <small className="error-text">加载失败：{plugin.error}</small> : null}
                  </div>
                  <Switch
                    checked={plugin.enabled}
                    onChange={(value) => onTogglePlugin(plugin.id, value)}
                    label={plugin.enabled ? "已启用" : "已停用"}
                    disabled={Boolean(plugin.error) || pluginsLoading}
                  />
                </div>
              ))
            )}
            <div className="plugin-footer">
              <button
                type="button"
                className="btn btn-small"
                onClick={onReloadPlugins}
                disabled={pluginsLoading}
              >
                <RefreshIcon size={13} />
                {pluginsLoading ? "扫描中" : "重新扫描插件"}
              </button>
              <span className="plugin-hint">安装目录：数据目录 / plugins</span>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-label">
            <h2>存储与地址</h2>
            <p>备份文件保存在本机。备份站使用独立端口，和界面互相隔离。</p>
          </div>
          <div className="settings-fields info-fields">
            <InfoRow label="备份站地址" value={health?.archiveBaseUrl ?? "—"} onCopy={copy} />
            <InfoRow label="数据目录" value={health?.dataDir ?? "—"} onCopy={copy} />
            <InfoRow label="接口地址" value={health ? `http://127.0.0.1:${health.port}` : "—"} onCopy={copy} />
            <div className="field-row">
              <span className="field-copy">
                <span>备份文件</span>
                <small>每个快照是一个自包含的 HTML，资源已经写进文件里，不依赖原网站。</small>
              </span>
              <span className="info-badge">单文件</span>
            </div>
          </div>
        </section>

        <footer className="settings-footer">
          <p>修改后会立即应用到接下来的备份。已经生成的快照不会被改写。</p>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? "正在保存" : "保存设置"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (value: string, label: string) => void;
}) {
  return (
    <div className="field-row">
      <span className="field-copy">
        <span>{label}</span>
        <small className="mono-value">{value}</small>
      </span>
      <button type="button" className="icon-btn" onClick={() => void onCopy(value, label)} aria-label={`复制${label}`}>
        <CopyIcon size={15} />
      </button>
    </div>
  );
}
