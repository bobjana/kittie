import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "accent" | "success" | "danger";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "border-transparent bg-lavender text-accent-strong",
  accent: "border-accent/30 bg-surface text-accent",
  success: "border-success/30 bg-surface text-success",
  danger: "border-danger/30 bg-surface text-danger",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({
  tone = "neutral",
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center gap-1 rounded-pill border px-3 py-1 text-xs font-bold",
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
