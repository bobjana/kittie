import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";

// Every route in this group reads the session at request time and renders the
// client-side AppShell (usePathname), so it may block on the server instead of
// prerendering a static shell. Next 16 cacheComponents: opt out of instant
// navigation validation here rather than per dynamic page.
export const instant = false;

export default function AppGroupLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <AppShell>{children}</AppShell>;
}
