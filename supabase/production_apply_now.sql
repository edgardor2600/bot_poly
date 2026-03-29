-- PolyBot production patch for real trading operation.
-- Safe to run multiple times.

-- 1) Real-trading schema
ALTER TABLE IF EXISTS public.user_trades
  ADD COLUMN IF NOT EXISTS condition_id text,
  ADD COLUMN IF NOT EXISTS token_id text,
  ADD COLUMN IF NOT EXISTS execution_mode text,
  ADD COLUMN IF NOT EXISTS buy_order_id text,
  ADD COLUMN IF NOT EXISTS buy_order_status text,
  ADD COLUMN IF NOT EXISTS buy_tx_hashes text,
  ADD COLUMN IF NOT EXISTS sell_order_id text,
  ADD COLUMN IF NOT EXISTS sell_order_status text,
  ADD COLUMN IF NOT EXISTS sell_tx_hashes text,
  ADD COLUMN IF NOT EXISTS close_reason text,
  ADD COLUMN IF NOT EXISTS pnl numeric,
  ADD COLUMN IF NOT EXISTS current_price numeric,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS stop_loss numeric,
  ADD COLUMN IF NOT EXISTS take_profit numeric,
  ADD COLUMN IF NOT EXISTS break_even_armed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_hold_at timestamptz;

ALTER TABLE IF EXISTS public.ai_signals
  ADD COLUMN IF NOT EXISTS condition_id text,
  ADD COLUMN IF NOT EXISTS yes_token_id text,
  ADD COLUMN IF NOT EXISTS no_token_id text;

CREATE TABLE IF NOT EXISTS public.order_events (
  id bigserial PRIMARY KEY,
  trade_id text NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_trade_id
  ON public.order_events(trade_id);

CREATE INDEX IF NOT EXISTS idx_order_events_created_at
  ON public.order_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_trades_status_max_hold_at
  ON public.user_trades(status, max_hold_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_events_trade_event_created
  ON public.order_events(trade_id, event_type, created_at DESC);

-- 2) Runtime locks used by scan/sync
CREATE TABLE IF NOT EXISTS public.bot_runtime_locks (
  lock_name text PRIMARY KEY,
  owner text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.try_acquire_runtime_lock(
  p_lock_name text,
  p_owner text,
  p_ttl_seconds integer DEFAULT 180
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  INSERT INTO public.bot_runtime_locks(lock_name, owner, expires_at, updated_at)
  VALUES (
    p_lock_name,
    p_owner,
    v_now + make_interval(secs => GREATEST(30, COALESCE(p_ttl_seconds, 180))),
    v_now
  )
  ON CONFLICT (lock_name) DO UPDATE
  SET owner = EXCLUDED.owner,
      expires_at = EXCLUDED.expires_at,
      updated_at = v_now
  WHERE public.bot_runtime_locks.expires_at <= v_now
     OR public.bot_runtime_locks.owner = EXCLUDED.owner;

  RETURN EXISTS (
    SELECT 1
    FROM public.bot_runtime_locks
    WHERE lock_name = p_lock_name
      AND owner = p_owner
      AND expires_at > v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_runtime_lock(
  p_lock_name text,
  p_owner text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.bot_runtime_locks
  WHERE lock_name = p_lock_name
    AND owner = p_owner;

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.try_acquire_runtime_lock(text, text, integer)
  TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.release_runtime_lock(text, text)
  TO anon, authenticated, service_role;
