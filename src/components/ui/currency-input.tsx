"use client";

import { forwardRef } from "react";
import { Input, type InputProps } from "./input";

export interface CurrencyInputProps
  extends Omit<
    InputProps,
    "inputMode" | "enterKeyHint" | "type" | "className" | "prefix"
  > {
  currencySymbol?: string;
}

export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  function CurrencyInput({ currencySymbol = "€", ...rest }, ref) {
    return (
      <Input
        {...rest}
        ref={ref}
        type="text"
        inputMode="decimal"
        enterKeyHint="done"
        autoComplete="off"
        prefix={currencySymbol}
        className="text-3xl font-semibold tabular-nums tracking-tight"
        containerClassName="w-full"
      />
    );
  },
);
