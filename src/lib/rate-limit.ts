import { client } from "@/db/client";

export const REGISTER_EMAIL_LIMIT = 5;
export const REGISTER_EMAIL_WINDOW_SECONDS = 60 * 60;
export const REGISTER_IP_LIMIT = 50;
export const REGISTER_IP_WINDOW_SECONDS = 60 * 60;

export async function incrementThrottle(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const now = new Date();
  const windowStartIso = new Date(
    now.getTime() - windowSeconds * 1000,
  ).toISOString();
  const nowIso = now.toISOString();
  const expiresAtIso = new Date(
    now.getTime() + windowSeconds * 1000,
  ).toISOString();

  const rows = await client`
    insert into request_throttle (key, window_start, count, expires_at)
    values (${key}, ${nowIso}, 1, ${expiresAtIso})
    on conflict (key) do update set
      count = case when request_throttle.window_start <= ${windowStartIso}
        then 1 else request_throttle.count + 1 end,
      window_start = case when request_throttle.window_start <= ${windowStartIso}
        then ${nowIso} else request_throttle.window_start end,
      expires_at = case when request_throttle.window_start <= ${windowStartIso}
        then ${expiresAtIso} else request_throttle.expires_at end
    returning count
  `;

  const count = rows[0]?.count ?? 0;
  return count > limit;
}
