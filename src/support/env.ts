// Small readers for configuration. Everything is read at call time so tests
// and hosts can change the environment without re-importing modules.

export function envString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** "true"/"1"/"yes" is true, "false"/"0"/"no" is false, anything else is the fallback. */
export function envFlag(name: string, fallback: boolean): boolean {
  const value = envString(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  return fallback;
}

/** True in a production deployment (NODE_ENV=production). */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
