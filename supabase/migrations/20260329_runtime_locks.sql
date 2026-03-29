-- Runtime locks for PolyBot critical loops.
-- Prevent duplicate scan/sync execution across instances.

CREATE TABLE IF NOT EXISTS public.bot_runtime_locks (
  lock_name text PRIMARY KEY,
  owner text NOT NULL,
  locked_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_runtime_locks_locked_until
  ON public.bot_runtime_locks(locked_until DESC);

CREATE OR REPLACE FUNCTION public.try_acquire_runtime_lock(
  p_lock_name text,
  p_owner text,
  p_ttl_seconds integer DEFAULT 180
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_until timestamptz := now() + make_interval(secs => GREATEST(1, COALESCE(p_ttl_seconds, 180)));
BEGIN
  INSERT INTO public.bot_runtime_locks (lock_name, owner, locked_until, updated_at)
  VALUES (p_lock_name, p_owner, v_until, now())
  ON CONFLICT (lock_name) DO UPDATE
    SET owner = EXCLUDED.owner,
        locked_until = EXCLUDED.locked_until,
        updated_at = now()
  WHERE public.bot_runtime_locks.locked_until <= now()
     OR public.bot_runtime_locks.owner = p_owner;

  RETURN EXISTS (
    SELECT 1
    FROM public.bot_runtime_locks
    WHERE lock_name = p_lock_name
      AND owner = p_owner
      AND locked_until > now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_runtime_lock(
  p_lock_name text,
  p_owner text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.bot_runtime_locks
  WHERE lock_name = p_lock_name
    AND owner = p_owner;
END;
$$;

GRANT EXECUTE ON FUNCTION public.try_acquire_runtime_lock(text, text, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_runtime_lock(text, text) TO anon, authenticated, service_role;
