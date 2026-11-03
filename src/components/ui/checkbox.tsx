"use client";

import { forwardRef, type InputHTMLAttributes, useId } from "react";
import { cx } from "./cx";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  hint?: string;
  error?: string;
  containerClassName?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox(
    { label, hint, error, className, containerClassName, id, ...rest },
    ref,
  ) {
    const generatedId = useId();
    const inputId = id ?? `checkbox-${generatedId}`;
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
          className="flex min-h-control cursor-pointer items-center gap-3 rounded-input"
        >
          <input
            {...rest}
            ref={ref}
            id={inputId}
            type="checkbox"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={cx(
              "size-6 shrink-0 rounded-md border-border accent-accent",
              "disabled:cursor-not-allowed disabled:opacity-50",
              className,
            )}
          />
          <span className="text-base font-medium text-ink">{label}</span>
        </label>
        {hint && !error ? (
          <p id={hintId} className="text-sm text-muted">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="text-sm font-semibold text-danger"
          >
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
