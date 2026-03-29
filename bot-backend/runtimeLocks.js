const DEFAULT_TTL_SECONDS = 180;
const localLocks = new Map();

export function createRuntimeOwner(lockName = "bot") {
  const pid = typeof process?.pid === "number" ? process.pid : "na";
  return `${lockName}-${pid}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function acquireRuntimeLock({
  supabase,
  lockName,
  owner,
  ttlSeconds = DEFAULT_TTL_SECONDS,
}) {
  const expiresAt = Date.now() + (ttlSeconds * 1000);

  try {
    const { data, error } = await supabase.rpc("try_acquire_runtime_lock", {
      p_lock_name: lockName,
      p_owner: owner,
      p_ttl_seconds: ttlSeconds,
    });

    if (error) {
      throw error;
    }

    return Boolean(data);
  } catch (error) {
    const current = localLocks.get(lockName);
    if (current && current.expiresAt > Date.now() && current.owner !== owner) {
      return false;
    }
    localLocks.set(lockName, { owner, expiresAt });
    return true;
  }
}

export async function releaseRuntimeLock({ supabase, lockName, owner }) {
  try {
    const { error } = await supabase.rpc("release_runtime_lock", {
      p_lock_name: lockName,
      p_owner: owner,
    });

    if (error) {
      throw error;
    }
  } catch {
    const current = localLocks.get(lockName);
    if (current?.owner === owner) {
      localLocks.delete(lockName);
    }
  }
}

export async function withRuntimeLock(options, work) {
  const acquired = await acquireRuntimeLock(options);
  if (!acquired) {
    return { acquired: false, result: null };
  }

  try {
    const result = await work();
    return { acquired: true, result };
  } finally {
    await releaseRuntimeLock(options);
  }
}
