"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

type NavIconProps = { className?: string };

function TallyIcon({ className }: NavIconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className={className}
    >
      <path d="M6 3v18M12 3v18M18 3v18M3 8h18M3 16h18" />
    </svg>
  );
}

function EventsIcon({ className }: NavIconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="3" y="5" width="18" height="16" rx="4" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function ProfileIcon({ className }: NavIconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

const NAV_ITEMS = [
  {
    href: "/tally",
    label: "Tally",
    hint: "Who owes whom",
    Icon: TallyIcon,
  },
  {
    href: "/events",
    label: "Events",
    hint: "Your trips and dinners",
    Icon: EventsIcon,
  },
  {
    href: "/profile",
    label: "Profile",
    hint: "Account and preferences",
    Icon: ProfileIcon,
  },
] as const;

function isActiveHref(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className={cx(
          "grid place-items-center rounded-card bg-accent font-extrabold text-white",
          compact ? "size-10 text-lg" : "size-11 text-xl",
        )}
      >
        K
      </span>
      <span className="text-xl font-extrabold tracking-tight text-ink">
        Kittie
      </span>
    </span>
  );
}

export interface AppShellProps {
  children: ReactNode;
  title?: string;
  action?: ReactNode;
}

export function AppShell({ children, title, action }: AppShellProps) {
  const pathname = usePathname();
  const activeItem = NAV_ITEMS.find((item) =>
    isActiveHref(pathname, item.href),
  );
  const heading = title ?? activeItem?.label ?? "Kittie";

  return (
    <div className="flex min-h-dvh flex-col md:grid md:grid-cols-[var(--spacing-sidebar)_1fr]">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <aside className="hidden border-r border-border bg-surface px-4 py-6 md:flex md:flex-col md:gap-6">
        <div className="px-2">
          <BrandMark />
        </div>
        <nav aria-label="Primary" className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const active = isActiveHref(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex min-h-control items-center gap-3 rounded-input px-3 text-base font-semibold",
                  "transition-colors",
                  active
                    ? "bg-lavender text-accent-strong"
                    : "text-ink hover:bg-lavender",
                )}
              >
                <item.Icon className="size-6" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border bg-surface/95 px-4 py-3 backdrop-blur md:px-8 md:py-5">
          <div className="md:hidden">
            <BrandMark compact />
          </div>
          <p className="hidden text-2xl font-extrabold tracking-tight text-ink md:block">
            {heading}
          </p>
          {action}
        </header>

        <main
          id="main"
          tabIndex={-1}
          className="flex-1 px-4 pb-28 pt-4 md:px-8 md:pb-12 md:pt-6"
        >
          {children}
        </main>
      </div>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="flex">
          {NAV_ITEMS.map((item) => {
            const active = isActiveHref(pathname, item.href);
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "flex min-h-14 flex-col items-center justify-center gap-1 px-2 py-2 text-xs font-bold",
                    "transition-colors",
                    active ? "text-accent-strong" : "text-muted",
                  )}
                >
                  <item.Icon className="size-6" />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
