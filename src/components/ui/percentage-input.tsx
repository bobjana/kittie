"use client";

import { forwardRef } from "react";
import { Input, type InputProps } from "./input";

export interface PercentageInputProps
  extends Omit<
    InputProps,
    "inputMode" | "enterKeyHint" | "type" | "className" | "suffix"
  > {
  suffixText?: string;
}

export const PercentageInput = forwardRef<
  HTMLInputElement,
  PercentageInputProps
>(function PercentageInput({ suffixText = "%", ...rest }, ref) {
  return (
    <Input
      {...rest}
      ref={ref}
      type="text"
      inputMode="decimal"
      enterKeyHint="next"
      autoComplete="off"
      suffix={suffixText}
      className="text-2xl font-semibold tabular-nums tracking-tight"
      containerClassName="w-full"
    />
  );
});
