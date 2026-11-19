import type { Health, Stats } from "../../../shared/types";
import { BrandMark, SettingsIcon } from "../icons";
import { cx } from "../utils";

type Props = {
  health: Health | null;
  stats: Stats | null;
  view: "library" | "activity" | "settings" | "bookmark";
  onNavigate: (hash: string) => void;
  onOpenSettings: () => void;
};

function browserLabel(health: Health | null, stats: Stats | null): { text: string; short: string; tone: string } {
  if (!health) return { text: "正在连接服务", short: "连接中", tone: "cold" };
  if (health.browserState === "error") return { text: "浏览器未就绪", short: "错误", tone: "error" };
  if (stats?.running) return { text: "正在备份", short: "备份中", tone: "busy" };
  if (health.browserState === "starting") return { text: "正在启动浏览器", short: "启动中", tone: "busy" };
  if (health.browserState === "warm") {
    if (stats && stats.queue > 0) return { text: `队列 ${stats.queue} 份`, short: "队列", tone: "busy" };
    return { text: "浏览器已就绪", short: "就绪", tone: "warm" };
  }
  if (stats && stats.queue > 0) return { text: `队列 ${stats.queue} 份`, short: "队列", tone: "busy" };
  return { text: "浏览器待机", short: "待机", tone: "cold" };
}

export function Header({ health, stats, view, onNavigate, onOpenSettings }: Props) {
  const status = browserLabel(health, stats);
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <a
          className="brand"
          href="#/"
          onClick={(event) => {
            event.preventDefault();
            onNavigate("#/");
          }}
          aria-label="LinkBag 首页"
        >
          <BrandMark size={25} />
          <span className="brand-word">LinkBag</span>
        </a>

        <nav className="main-nav" aria-label="主导航">
          <a
            href="#/"
            className={cx("nav-link", (view === "library" || view === "bookmark") && "is-active")}
            onClick={(event) => {
              event.preventDefault();
              onNavigate("#/");
            }}
          >
            收藏
          </a>
          <a
            href="#/activity"
            className={cx("nav-link", view === "activity" && "is-active")}
            onClick={(event) => {
              event.preventDefault();
              onNavigate("#/activity");
            }}
          >
            活动
          </a>
        </nav>

        <div className="masthead-right">
          <div
            className={cx("browser-status", `is-${status.tone}`)}
            title={health?.browserLastError ?? "备份用的浏览器会按需启动，空闲后自动释放"}
          >
            <span className="status-dot" aria-hidden="true" />
            <span className="status-text">{status.text}</span>
            <span className="status-text-short">{status.short}</span>
          </div>
          <button
            type="button"
            className={cx("icon-btn", "settings-btn", view === "settings" && "is-active")}
            aria-label="设置"
            title="设置"
            onClick={onOpenSettings}
          >
            <SettingsIcon size={17} />
          </button>
        </div>
      </div>
    </header>
  );
}
