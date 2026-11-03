import type { ReactNode } from "react";
import { cx } from "./cx";

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-center gap-3 rounded-card border border-dashed border-border bg-surface px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="grid size-14 place-items-center rounded-pill bg-lavender text-2xl text-accent-strong"
        >
          {icon}
        </span>
      ) : null}
      <p className="text-lg font-bold text-ink">{title}</p>
      {description ? (
        <p className="max-w-sm text-base text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
