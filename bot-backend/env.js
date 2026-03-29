export function getEnv(name, fallback = undefined) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  return raw;
}

export function requireEnv(name) {
  const value = getEnv(name);
  if (value === undefined) {
    throw new Error(`[CONFIG] Missing required env var: ${name}`);
  }
  return value;
}

export function getBooleanEnv(name, fallback = false) {
  const value = getEnv(name);
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

export function getNumberEnv(name, fallback = undefined) {
  const value = getEnv(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`[CONFIG] Env var ${name} must be a valid number`);
  }
  return parsed;
}
