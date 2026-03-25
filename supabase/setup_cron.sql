-- ═══════════════════════════════════════════════════════════════════════
-- PolyBot v3 — Setup de pg_cron + pg_net en Supabase
-- Ejecuta este script en el SQL Editor de tu proyecto de Supabase.
-- ═══════════════════════════════════════════════════════════════════════

-- 1. HABILITAR EXTENSIONES (si no están activas ya)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ═══════════════════════════════════════════════════════════════════════
-- IMPORTANTE: Reemplaza las variables antes de ejecutar:
--   <PROJECT_REF>  → ID de tu proyecto Supabase (ej: wxgxzklqbarqfqptzatq)
--   <ANON_KEY>     → Tu llave anon/service de Supabase
-- ═══════════════════════════════════════════════════════════════════════

-- 2. CRON JOB: Rollover diario (cada 1 minuto)
--    Llama a la Edge Function bot-cron?type=rollover
SELECT cron.schedule(
  'polybot-rollover',        -- nombre único del job
  '* * * * *',               -- cron expression: cada 1 minuto
  $$
    SELECT net.http_post(
      url := 'https://<PROJECT_REF>.supabase.co/functions/v1/bot-cron?type=rollover',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer <ANON_KEY>"}'::jsonb,
      body := '{}'::jsonb
    );
  $$
);

-- 3. CRON JOB: Fast Sync de Trades (cada 3 minutos)
--    Llama a la Edge Function bot-cron?type=sync
SELECT cron.schedule(
  'polybot-sync',            -- nombre único del job
  '*/3 * * * *',             -- cron expression: cada 3 minutos
  $$
    SELECT net.http_post(
      url := 'https://<PROJECT_REF>.supabase.co/functions/v1/bot-cron?type=sync',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer <ANON_KEY>"}'::jsonb,
      body := '{}'::jsonb
    );
  $$
);

-- 4. CRON JOB: Escaneo Completo de Mercados (cada 30 minutos)
--    Llama a la Edge Function bot-cron?type=scan
SELECT cron.schedule(
  'polybot-scan',            -- nombre único del job
  '*/30 * * * *',            -- cron expression: cada 30 minutos
  $$
    SELECT net.http_post(
      url := 'https://<PROJECT_REF>.supabase.co/functions/v1/bot-cron?type=scan',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer <ANON_KEY>"}'::jsonb,
      body := '{}'::jsonb
    );
  $$
);

-- ═══════════════════════════════════════════════════════════════════════
-- CONSULTAS ÚTILES (descomenta para usar)
-- ═══════════════════════════════════════════════════════════════════════

-- Ver todos los cron jobs activos:
-- SELECT * FROM cron.job;

-- Ver el historial de ejecuciones recientes:
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- Eliminar un job si necesitas reconfigurar:
-- SELECT cron.unschedule('polybot-scan');
-- SELECT cron.unschedule('polybot-sync');
-- SELECT cron.unschedule('polybot-rollover');
