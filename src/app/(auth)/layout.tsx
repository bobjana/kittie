import type { ReactNode } from "react";

export default function AuthGroupLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-11 place-items-center rounded-card bg-accent text-xl font-extrabold text-white"
          >
            K
          </span>
          <span className="text-2xl font-extrabold tracking-tight text-ink">
            Kittie
          </span>
        </div>
        <main
          id="main"
          tabIndex={-1}
          className="animate-rise rounded-card border border-border bg-surface p-6 shadow-soft"
        >
          {children}
        </main>
        <p className="mt-6 text-center text-sm text-muted">
          Split expenses with friends, exactly to the cent.
        </p>
      </div>
    </div>
  );
}
