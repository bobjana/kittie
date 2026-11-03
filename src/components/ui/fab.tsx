"use client";

import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cx } from "./cx";

export interface FabProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  "aria-label": string;
  children: ReactNode;
}

export const Fab = forwardRef<HTMLButtonElement, FabProps>(function Fab(
  { className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx(
        "fixed bottom-24 right-4 z-30 inline-flex size-fab items-center justify-center rounded-pill",
        "bg-accent text-2xl text-white shadow-soft",
        "transition-colors hover:bg-accent-strong",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "md:bottom-8 md:right-8",
        className,
      )}
    >
      {children}
    </button>
  );
});
