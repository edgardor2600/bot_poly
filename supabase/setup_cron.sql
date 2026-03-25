-- ═══════════════════════════════════════════════════════════════════════
-- PolyBot v3 — Setup de pg_cron + pg_net en Supabase
-- 
-- ANTES DE EJECUTAR: Reemplaza solo estas 2 variables:
--   1. <TU_ANON_KEY>   → Tu llave "anon public" de Project Settings → API
--   2. <TU_FUNCION_URL> queda igual: usa la URL de la función ya desplegada
--
-- El PROJECT_REF ya está completado: wxgxzklqbarqfqptzatq
-- ═══════════════════════════════════════════════════════════════════════

-- 1. HABILITAR EXTENSIONES (necesarias para hacer HTTP calls desde la DB)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ════════════════════════════════════════════════════════════════
-- ► REEMPLAZA SOLO ESTO: pega tu anon key aquí abajo
-- ════════════════════════════════════════════════════════════════
-- Tu Anon Key la encuentras en:
-- Supabase Dashboard → Project Settings → API → "anon public"

-- Tip: puedes hacer do $$ begin ... end $$ para definirla 1 sola vez:
DO $$
DECLARE
  anon_key TEXT := '<TU_ANON_KEY>';  -- ← PON TU ANON KEY AQUÍ
  fn_url   TEXT := 'https://wxgxzklqbarqfqptzatq.supabase.co/functions/v1/bot-cron';
BEGIN

  -- ─── CRON 1: Rollover diario (cada 1 minuto) ───
  -- Detecta cambio de día y resetea el PNL diario + meta
  PERFORM cron.unschedule('polybot-rollover');
  PERFORM cron.schedule(
    'polybot-rollover',
    '* * * * *',
    format(
      $sql$
        SELECT net.http_post(
          url     := '%s?type=rollover',
          headers := '{"Content-Type":"application/json","Authorization":"Bearer %s"}'::jsonb,
          body    := '{}'::jsonb
        );
      $sql$,
      fn_url, anon_key
    )
  );

  -- ─── CRON 2: Fast Sync (cada 3 minutos) ───
  -- Monitorea precios en vivo y cierra posiciones por SL/TP
  PERFORM cron.unschedule('polybot-sync');
  PERFORM cron.schedule(
    'polybot-sync',
    '*/3 * * * *',
    format(
      $sql$
        SELECT net.http_post(
          url     := '%s?type=sync',
          headers := '{"Content-Type":"application/json","Authorization":"Bearer %s"}'::jsonb,
          body    := '{}'::jsonb
        );
      $sql$,
      fn_url, anon_key
    )
  );

  -- ─── CRON 3: Escaneo completo (cada 30 minutos) ───
  -- Analiza todos los mercados de Polymarket con IA + Tavily
  PERFORM cron.unschedule('polybot-scan');
  PERFORM cron.schedule(
    'polybot-scan',
    '*/30 * * * *',
    format(
      $sql$
        SELECT net.http_post(
          url     := '%s?type=scan',
          headers := '{"Content-Type":"application/json","Authorization":"Bearer %s"}'::jsonb,
          body    := '{}'::jsonb
        );
      $sql$,
      fn_url, anon_key
    )
  );

  RAISE NOTICE '✅ PolyBot Cron Jobs instalados correctamente.';
END $$;

-- ─── VERIFICAR QUE QUEDARON ACTIVOS ───
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'polybot-%';

-- ═══════════════════════════════════════════════════════════════════════
-- COMANDOS ÚTILES (descomenta para usar)
-- ═══════════════════════════════════════════════════════════════════════
-- Ver historial de ejecuciones recientes:
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- Pausar todos los polybot jobs (sin borrarlos):
-- UPDATE cron.job SET active = false WHERE jobname LIKE 'polybot-%';

-- Reactivarlos:
-- UPDATE cron.job SET active = true WHERE jobname LIKE 'polybot-%';

-- Borrarlos completamente:
-- SELECT cron.unschedule('polybot-scan');
-- SELECT cron.unschedule('polybot-sync');
-- SELECT cron.unschedule('polybot-rollover');
