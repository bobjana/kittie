import { cx } from "./cx";

export type AmountSize = "sm" | "md" | "lg" | "xl";
export type AmountTone = "default" | "success" | "danger" | "muted";

const SIZE_CLASS: Record<AmountSize, string> = {
  sm: "text-sm",
  md: "text-lg",
  lg: "text-2xl",
  xl: "text-4xl",
};

const TONE_CLASS: Record<AmountTone, string> = {
  default: "text-ink",
  success: "text-success",
  danger: "text-danger",
  muted: "text-muted",
};

export interface AmountProps {
  minorUnits: number;
  currency?: string;
  locale?: string;
  size?: AmountSize;
  tone?: AmountTone;
  className?: string;
}

export function formatMinorUnits(
  minorUnits: number,
  currency: string,
  locale?: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minorUnits / 100);
}

export function Amount({
  minorUnits,
  currency = "EUR",
  locale,
  size = "md",
  tone = "default",
  className,
}: AmountProps) {
  return (
    <span
      className={cx(
        "tabular-nums font-semibold",
        SIZE_CLASS[size],
        TONE_CLASS[tone],
        className,
      )}
    >
      {formatMinorUnits(minorUnits, currency, locale)}
    </span>
  );
}
