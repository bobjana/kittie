import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  children?: ReactNode;
}

export function Card({
  as: Tag = "div",
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <Tag
      {...rest}
      className={cx(
        "rounded-card border border-border bg-surface p-5 shadow-soft",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  as?: "h2" | "h3" | "h4";
}

export function CardTitle({
  as: Tag = "h3",
  className,
  children,
  ...rest
}: CardTitleProps) {
  return (
    <Tag {...rest} className={cx("text-lg font-bold text-ink", className)}>
      {children}
    </Tag>
  );
}

export function CardText({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p {...rest} className={cx("text-base text-muted", className)}>
      {children}
    </p>
  );
}
