export const POST_AUTH_REDIRECT = "/tally";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email) && email.length <= 254;
}

const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function isSafeNextPath(value: string | null | undefined): boolean {
  if (!value) {
    return true;
  }
  if (value.startsWith("//") || value.startsWith("/\\")) {
    return false;
  }
  if (ABSOLUTE_URL_PATTERN.test(value)) {
    return false;
  }
  return value.startsWith("/");
}

const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/;

export function isSafeInviteToken(value: string | null | undefined): boolean {
  if (!value) {
    return true;
  }
  return INVITE_TOKEN_PATTERN.test(value);
}

export function computeRedirectTo(
  next: string | null | undefined,
  invite: string | null | undefined,
): string {
  if (invite && isSafeInviteToken(invite)) {
    return `/invite/${invite}`;
  }
  if (next && isSafeNextPath(next)) {
    return next;
  }
  return POST_AUTH_REDIRECT;
}

export function buildResetRedirectTo(
  next: string | null | undefined,
  invite: string | null | undefined,
): string {
  const params = new URLSearchParams();
  if (next && isSafeNextPath(next)) {
    params.set("next", next);
  }
  if (invite && isSafeInviteToken(invite)) {
    params.set("invite", invite);
  }
  const query = params.toString();
  return query ? `/welcome/password?${query}` : "/welcome/password";
}
