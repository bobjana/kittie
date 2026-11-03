"use client";

import type { ReactNode } from "react";
import { cx } from "./cx";
import { IconButton } from "./icon-button";

export type ToastTone = "success" | "error" | "info";

const TONE_BORDER: Record<ToastTone, string> = {
  success: "border-success/30",
  error: "border-danger/30",
  info: "border-border",
};

const TONE_DOT: Record<ToastTone, string> = {
  success: "bg-success",
  error: "bg-danger",
  info: "bg-accent",
};

export interface ToastProps {
  tone?: ToastTone;
  title: string;
  children?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}

export function Toast({
  tone = "info",
  title,
  children,
  onDismiss,
  dismissLabel = "Dismiss notification",
}: ToastProps) {
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={cx(
        "pointer-events-auto flex w-full animate-pop items-start gap-3 rounded-card border bg-surface p-4 shadow-soft",
        TONE_BORDER[tone],
      )}
    >
      <span
        aria-hidden="true"
        className={cx("mt-2 size-2.5 shrink-0 rounded-pill", TONE_DOT[tone])}
      />
      <div className="flex-1">
        <p className="text-base font-bold text-ink">{title}</p>
        {children ? (
          <div className="mt-1 text-sm text-muted">{children}</div>
        ) : null}
      </div>
      {onDismiss ? (
        <IconButton
          aria-label={dismissLabel}
          variant="ghost"
          onClick={onDismiss}
        >
          <span aria-hidden="true" className="text-xl leading-none">
            ×
          </span>
        </IconButton>
      ) : null}
    </div>
  );
}

export function ToastViewport({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-24 z-40 flex flex-col gap-3 sm:bottom-6 sm:left-auto sm:right-6 sm:w-96">
      {children}
    </div>
  );
}
