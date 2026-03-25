import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { runFullScan, fastSyncTrades, checkDayRollover, botState, initializeStateFromDB } from './botCore.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── SUPABASE ───
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ─── CONFIGURACIÓN ───
const PORT = process.env.PORT || 4000;
const CRON_SECRET = process.env.CRON_SECRET || 'polybot-cron-secret-2024';

// ─────────────────────────────────────────────────────────
// MIDDLEWARE DE AUTENTICACIÓN PARA ENDPOINTS DE CRON
// Solo Supabase (con el token secreto) puede llamar estos endpoints.
// ─────────────────────────────────────────────────────────
function verifyCronSecret(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${CRON_SECRET}`) {
    console.warn(`[SECURITY] ⚠️ Intento de acceso no autorizado al endpoint cron desde: ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized - Invalid cron secret' });
  }
  next();
}

// ─────────────────────────────────────────────────────────
// ENDPOINTS PÚBLICOS
// ─────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'PolyBot v3 Backend is running 🚀',
    capital: botState.capital,
    scanRunning: botState.scanStatus.running,
    lastScan: botState.scanStatus.lastScan,
    openTrades: botState.trades.filter(t => t.status === 'OPEN').length,
    uptime: process.uptime()
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    capital: botState.capital,
    invested: botState.trades.filter(t => t.status === 'OPEN').reduce((acc, t) => acc + t.cost, 0),
    dailyPnl: botState.dailyPnl,
    goalReached: botState.goalReached,
    trades: botState.trades,
    signals: botState.signals,
    scanStatus: botState.scanStatus,
    logEntries: botState.logEntries.slice(0, 50),
    marketsCount: botState.allMarkets.length,
    allMarkets: botState.allMarkets.slice(0, 300)
  });
});

// ─────────────────────────────────────────────────────────
// ENDPOINTS DE CRON (Solo Supabase puede llamar estos)
// ─────────────────────────────────────────────────────────

/**
 * CRON: Escaneo Principal — se llama cada 30 minutos desde Supabase
 * Este endpoint dispara el análisis completo de mercados + IA
 */
app.post('/api/cron/scan', verifyCronSecret, (req, res) => {
  if (botState.scanStatus.running) {
    console.log('[CRON] ⏭️  Escaneo ya en curso — omitiendo llamada duplicada.');
    return res.status(200).json({ status: 'skipped', reason: 'scan already running' });
  }
  // Responder inmediatamente (antes del await) para no "timeout" a Supabase
  res.status(200).json({ status: 'scan_started', ts: new Date().toISOString() });
  console.log('[CRON] 📡 Escaneo completo disparado por Supabase Cron.');
  runFullScan().catch(err => console.error('[CRON] ❌ Error en runFullScan:', err.message));
});

/**
 * CRON: Fast Sync — se llama cada 3 minutos desde Supabase
 * Monitorea precios en vivo y cierra posiciones en Stop Loss / Take Profit
 */
app.post('/api/cron/sync', verifyCronSecret, (req, res) => {
  res.status(200).json({ status: 'sync_started', ts: new Date().toISOString() });
  console.log('[CRON] 🔄 Fast Sync disparado por Supabase Cron.');
  fastSyncTrades().catch(err => console.error('[CRON] ❌ Error en fastSyncTrades:', err.message));
});

/**
 * CRON: Day Rollover — se llama cada 1 minuto desde Supabase
 * Resetea el PNL diario y la meta al cambiar de jornada
 */
app.post('/api/cron/rollover', verifyCronSecret, (req, res) => {
  res.status(200).json({ status: 'rollover_checked', ts: new Date().toISOString() });
  checkDayRollover();
});

// ─────────────────────────────────────────────────────────
// ARRANQUE DEL SERVIDOR
// ─────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`=========================================`);
  console.log(`🤖 PolyBot Backend Iniciado en puerto ${PORT}`);
  console.log(`=========================================`);

  // 1. CARGAR MEMORIA DESDE SUPABASE (reconstruir capital y trades históricos)
  await initializeStateFromDB();

  // 2. TIMERS LOCALES — Solo activos en desarrollo local (USE_LOCAL_TIMERS=true en .env)
  //    En producción (Render), Supabase Edge Functions llaman a los endpoints de cron.
  if (process.env.USE_LOCAL_TIMERS === 'true') {
    console.log('⏱️  [LOCAL DEV] Timers locales activados (setInterval).');

    setInterval(() => {
      checkDayRollover();
    }, 60 * 1000); // Cada 1 minuto

    setInterval(() => {
      fastSyncTrades().catch(err => console.error('Fast Sync Error:', err.message));
    }, 3 * 60 * 1000); // Cada 3 minutos

    setInterval(() => {
      if (!botState.scanStatus.running) {
        runFullScan().catch(err => console.error('Scan Error:', err.message));
      }
    }, botState.config.autoInterval * 60 * 1000); // Cada 30 minutos

    // Primer escaneo inmediato al iniciar en local
    runFullScan().catch(err => console.error('Initial Scan Error:', err.message));
  } else {
    console.log('🌐 [PRODUCCIÓN] Timers externos activados. Supabase Cron controlará los escaneos.');
    // En producción: primer escaneo diferido 10 segundos para que el servidor se estabilice
    setTimeout(() => {
      runFullScan().catch(err => console.error('Initial Scan Error:', err.message));
    }, 10000);
  }
});
