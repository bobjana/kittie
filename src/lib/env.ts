import { type Env, parseEnv } from "./env-parser";

// Fail-fast: throws at import time if the environment is incomplete.
export const env: Env = parseEnv(process.env);

export { parseEnv };
export type { Env };
