"use client";

import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "lg";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white shadow-soft hover:bg-accent-strong active:bg-accent-strong",
  secondary: "border border-border bg-surface text-ink hover:bg-lavender",
  ghost: "bg-transparent text-ink hover:bg-lavender",
  danger: "bg-danger text-white shadow-soft hover:bg-danger/90",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  md: "min-h-control px-5 text-base",
  lg: "min-h-button px-6 text-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      fullWidth = false,
      loading = false,
      className,
      disabled,
      children,
      type = "button",
      ...rest
    },
    ref,
  ) {
    return (
      <button
        {...rest}
        ref={ref}
        type={type}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cx(
          "inline-flex items-center justify-center gap-2 rounded-pill font-semibold",
          "transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-50",
          VARIANT_CLASS[variant],
          SIZE_CLASS[size],
          fullWidth && "w-full",
          className,
        )}
      >
        {loading ? (
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-pill border-2 border-current border-t-transparent"
          />
        ) : null}
        {children}
      </button>
    );
  },
);
