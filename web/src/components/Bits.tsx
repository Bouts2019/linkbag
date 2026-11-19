import { useMemo } from "react";
import type { Backup } from "../../../shared/types";
import { monogram, monogramTone } from "../utils";

export function Monogram({ domain, size = "small" }: { domain: string; size?: "small" | "large" }) {
  const tone = useMemo(() => monogramTone(domain), [domain]);
  const letter = useMemo(() => monogram(domain), [domain]);
  return (
    <span className={`monogram tone-${tone} monogram-${size}`} aria-hidden="true">
      {letter}
    </span>
  );
}

export function BackupStrip({ backups, limit = 9 }: { backups: Backup[]; limit?: number }) {
  const ordered = useMemo(() => {
    const successes = backups.filter((backup) => backup.status === "success");
    const active = backups.filter((backup) => backup.status === "queued" || backup.status === "running");
    const failures = backups.filter((backup) => backup.status === "failed");
    const list = [...active, ...failures, ...successes].slice(0, limit).reverse();
    return list;
  }, [backups, limit]);

  if (ordered.length === 0) {
    return (
      <span className="backup-strip is-empty" aria-label="还没有备份">
        <span className="bar bar-empty" />
      </span>
    );
  }

  return (
    <span className="backup-strip" aria-label={`${backups.length} 条备份记录`}>
      {ordered.map((backup) => (
        <span
          key={backup.id}
          className={`bar bar-${backup.status}`}
          title={
            backup.status === "success"
              ? `${new Date(backup.finishedAt ?? backup.createdAt).toLocaleString("zh-CN")} · ${backup.status === "success" && backup.sameAsPrevious ? "内容未变化" : "已保存"}`
              : backup.status === "failed"
                ? "备份失败"
                : "正在进行"
          }
        />
      ))}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`switch ${checked ? "is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
      <span className="switch-label">{label}</span>
    </button>
  );
}
