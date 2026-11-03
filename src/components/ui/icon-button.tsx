"use client";

import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cx } from "./cx";

export type IconButtonVariant = "ghost" | "secondary" | "primary";

const VARIANT_CLASS: Record<IconButtonVariant, string> = {
  ghost: "bg-transparent text-ink hover:bg-lavender",
  secondary: "border border-border bg-surface text-ink hover:bg-lavender",
  primary: "bg-accent text-white shadow-soft hover:bg-accent-strong",
};

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  "aria-label": string;
  variant?: IconButtonVariant;
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { variant = "ghost", className, children, type = "button", ...rest },
    ref,
  ) {
    return (
      <button
        {...rest}
        ref={ref}
        type={type}
        className={cx(
          "inline-flex size-control shrink-0 items-center justify-center rounded-pill",
          "transition-colors duration-200",
          "disabled:cursor-not-allowed disabled:opacity-50",
          VARIANT_CLASS[variant],
          className,
        )}
      >
        {children}
      </button>
    );
  },
);
