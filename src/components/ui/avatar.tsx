import { cx } from "./cx";

export type AvatarSize = "sm" | "md" | "lg";

const SIZE_CLASS: Record<AvatarSize, string> = {
  sm: "size-8 text-xs",
  md: "size-11 text-sm",
  lg: "size-16 text-lg",
};

const TONE_CLASS = [
  "bg-lavender text-accent-strong",
  "bg-mint text-ink",
  "bg-accent text-white",
];

export interface AvatarProps {
  name: string;
  size?: AvatarSize;
  className?: string;
}

export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  const first = parts[0]?.charAt(0) ?? "";
  const last =
    parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

function toneIndexForName(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
  }
  return hash % TONE_CLASS.length;
}

export function Avatar({ name, size = "md", className }: AvatarProps) {
  return (
    <span
      role="img"
      aria-label={name}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-pill font-bold",
        SIZE_CLASS[size],
        TONE_CLASS[toneIndexForName(name)],
        className,
      )}
    >
      {initialsFromName(name)}
    </span>
  );
}
