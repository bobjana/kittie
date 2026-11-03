"use client";

import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  useId,
} from "react";
import { cx } from "./cx";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label: string;
  hint?: string;
  error?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hint,
    error,
    prefix,
    suffix,
    className,
    containerClassName,
    id,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? `input-${generatedId}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy =
    [hint && !error ? hintId : null, error ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className={cx("flex flex-col", containerClassName)}>
      <label
        htmlFor={inputId}
        className="mb-1.5 text-sm font-semibold text-ink"
      >
        {label}
      </label>
      <div
        className={cx(
          "flex min-h-control items-center gap-2 rounded-input border bg-surface px-4",
          "transition-colors focus-within:border-accent",
          "focus-within:ring-2 focus-within:ring-accent/25",
          error ? "border-danger" : "border-border",
        )}
      >
        {prefix ? (
          <span className="shrink-0 text-base font-semibold text-muted">
            {prefix}
          </span>
        ) : null}
        <input
          {...rest}
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cx(
            "w-full bg-transparent py-2.5 text-base text-ink placeholder:text-muted focus:outline-none",
            "disabled:cursor-not-allowed disabled:text-muted",
            className,
          )}
        />
        {suffix ? (
          <span className="shrink-0 text-base font-semibold text-muted">
            {suffix}
          </span>
        ) : null}
      </div>
      {hint && !error ? (
        <p id={hintId} className="mt-1.5 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="mt-1.5 text-sm font-semibold text-danger"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
});
