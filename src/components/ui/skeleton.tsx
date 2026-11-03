import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export function Skeleton({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      aria-hidden="true"
      className={cx("animate-pulse rounded-input bg-lavender", className)}
    />
  );
}
