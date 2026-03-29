import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { runFullScan, fastSyncTrades, checkDayRollover, botState, initializeStateFromDB, BASE_CAPITAL, refreshDbReadiness } from './botCore.js';
import { getNumberEnv, requireEnv } from './env.js';
import { getLiveWalletSnapshot, initPolymarketClient, isRealTradingEnabled } from './polymarketClient.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// â”€â”€â”€ CONFIGURACIÃ“N â”€â”€â”€
const PORT = getNumberEnv('PORT', 4000);
const CRON_SECRET = requireEnv('CRON_SECRET');
const BOOTSTRAP_SCAN_ON_START = process.env.BOOTSTRAP_SCAN_ON_START !== 'false';
const ALLOW_LOCAL_REAL_TRADING = process.env.ALLOW_LOCAL_REAL_TRADING === 'true';
let tradingClientReady = !isRealTradingEnabled();

function isActiveTradeStatus(status) {
  return ["OPEN", "PARTIAL", "PENDING_BUY", "PENDING_SELL"].includes(String(status || "").trim().toUpperCase());
}

function shouldCountTrade(trade) {
  if (!isActiveTradeStatus(trade?.status)) return false;
  if (!isRealTradingEnabled()) return true;
  return String(trade?.executionMode || trade?.execution_mode || "").trim().toUpperCase() === "REAL";
}

function isSimulatedActiveTrade(trade) {
  if (!isActiveTradeStatus(trade?.status)) return false;
  return String(trade?.executionMode || trade?.execution_mode || "").trim().toUpperCase() !== "REAL";
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MIDDLEWARE DE AUTENTICACIÃ“N PARA ENDPOINTS DE CRON
// Solo Supabase (con el token secreto) puede llamar estos endpoints.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function verifyCronSecret(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${CRON_SECRET}`) {
    console.warn(`[SECURITY] âš ï¸ Intento de acceso no autorizado al endpoint cron desde: ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized - Invalid cron secret' });
  }
  next();
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ENDPOINTS PÃšBLICOS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'PolyBot v3 Backend is running ðŸš€',
    baseCapital: BASE_CAPITAL,
    capital: botState.capital,
    withdrawnTotal: botState.withdrawnTotal,
    lastWithdrawalAt: botState.lastWithdrawalAt,
    scanRunning: botState.scanStatus.running,
    lastScan: botState.scanStatus.lastScan,
    openTrades: botState.trades.filter(t => shouldCountTrade(t)).length,
    simulatedActiveTrades: botState.trades.filter(t => isSimulatedActiveTrade(t)).length,
    realTradingEnabled: isRealTradingEnabled(),
    tradingClientReady,
    autoTradeReady: botState.dbReadiness?.autoTradeReady ?? false,
    dbReadiness: botState.dbReadiness,
    uptime: process.uptime()
  });
});

app.get('/api/status', async (req, res) => {
  let walletSnapshot = null;
  let dbReadiness = botState.dbReadiness;
  if (isRealTradingEnabled()) {
    try {
      walletSnapshot = await getLiveWalletSnapshot();
    } catch (walletErr) {
      console.warn(`[TRADING] No se pudo obtener wallet snapshot: ${walletErr.message}`);
    }
    try {
      dbReadiness = await refreshDbReadiness();
    } catch (dbErr) {
      console.warn(`[DB] No se pudo refrescar readiness: ${dbErr.message}`);
    }
  }

  res.json({
    baseCapital: BASE_CAPITAL,
    capital: botState.capital,
    invested: botState.trades.filter(t => shouldCountTrade(t)).reduce((acc, t) => acc + t.cost, 0),
    simulatedActiveTrades: botState.trades.filter(t => isSimulatedActiveTrade(t)).length,
    realTradingEnabled: isRealTradingEnabled(),
    tradingClientReady,
    autoTradeReady: dbReadiness?.autoTradeReady ?? false,
    dbReadiness,
    walletSnapshot,
    dailyPnl: botState.dailyPnl,
    goalReached: botState.goalReached,
    withdrawnTotal: botState.withdrawnTotal,
    lastWithdrawalAt: botState.lastWithdrawalAt,
    config: botState.config,
    withdrawalPolicy: botState.withdrawalPolicy,
    walletActivity: botState.walletActivity.slice(0, 100),
    trades: botState.trades,
    signals: botState.signals,
    scanStatus: botState.scanStatus,
    logEntries: botState.logEntries.slice(0, 50),
    marketsCount: botState.allMarkets.length,
    allMarkets: botState.allMarkets.slice(0, 300)
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ENDPOINTS DE CRON (Solo Supabase puede llamar estos)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * CRON: Escaneo Principal â€” se llama cada 30 minutos desde Supabase
 * Este endpoint dispara el anÃ¡lisis completo de mercados + IA
 */
app.post('/api/cron/scan', verifyCronSecret, (req, res) => {
  if (botState.scanStatus.running) {
    console.log('[CRON] â­ï¸  Escaneo ya en curso â€” omitiendo llamada duplicada.');
    return res.status(200).json({ status: 'skipped', reason: 'scan already running' });
  }
  // Responder inmediatamente (antes del await) para no "timeout" a Supabase
  res.status(200).json({ status: 'scan_started', ts: new Date().toISOString() });
  console.log('[CRON] ðŸ“¡ Escaneo completo disparado por Supabase Cron.');
  runFullScan().catch(err => console.error('[CRON] âŒ Error en runFullScan:', err.message));
});

/**
 * CRON: Fast Sync â€” se llama cada 3 minutos desde Supabase
 * Monitorea precios en vivo y cierra posiciones en Stop Loss / Take Profit
 */
app.post('/api/cron/sync', verifyCronSecret, (req, res) => {
  res.status(200).json({ status: 'sync_started', ts: new Date().toISOString() });
  console.log('[CRON] ðŸ”„ Fast Sync disparado por Supabase Cron.');
  fastSyncTrades().catch(err => console.error('[CRON] âŒ Error en fastSyncTrades:', err.message));
});

/**
 * CRON: Day Rollover â€” se llama cada 1 minuto desde Supabase
 * Resetea el PNL diario y la meta al cambiar de jornada
 */
app.post('/api/cron/rollover', verifyCronSecret, (req, res) => {
  res.status(200).json({ status: 'rollover_checked', ts: new Date().toISOString() });
  checkDayRollover();
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ARRANQUE DEL SERVIDOR
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.listen(PORT, async () => {
  console.log(`=========================================`);
  console.log(`ðŸ¤– PolyBot Backend Iniciado en puerto ${PORT}`);
  console.log(`=========================================`);

  // 1. CARGAR MEMORIA DESDE SUPABASE (reconstruir capital y trades histÃ³ricos)
  await initializeStateFromDB();

  if (isRealTradingEnabled()) {
    console.log('[TRADING] Inicializando cliente real Polymarket (L1/L2)...');
    await initPolymarketClient();
    tradingClientReady = true;
    console.log('[TRADING] Cliente real Polymarket autenticado âœ…');
  } else {
    console.log('[TRADING] REAL_TRADING_ENABLED=false -> modo simulaciÃ³n activo.');
  }

  // 2. TIMERS LOCALES â€” Solo activos en desarrollo local (USE_LOCAL_TIMERS=true en .env)
  //    En producciÃ³n (Render), Supabase Edge Functions llaman a los endpoints de cron.
  const localTimersEnabled = process.env.USE_LOCAL_TIMERS === 'true';
  const unsafeLocalRealTrading = localTimersEnabled && isRealTradingEnabled() && !ALLOW_LOCAL_REAL_TRADING;

  if (unsafeLocalRealTrading) {
    console.warn('[SAFE MODE] Local real trading bloqueado. Define ALLOW_LOCAL_REAL_TRADING=true si realmente quieres timers locales con fondos reales.');
  }

  if (localTimersEnabled && !unsafeLocalRealTrading) {
    console.log('â±ï¸  [LOCAL DEV] Timers locales activados (setInterval).');

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

    // Primer escaneo inmediato al iniciar en local (opcional)
    if (BOOTSTRAP_SCAN_ON_START) {
      runFullScan().catch(err => console.error('Initial Scan Error:', err.message));
    } else {
      console.log('â¸ï¸ [SAFE MODE] BOOTSTRAP_SCAN_ON_START=false -> sin escaneo inicial.');
    }
  } else if (!localTimersEnabled) {
    console.log('ðŸŒ [PRODUCCIÃ“N] Timers externos activados. Supabase Cron controlarÃ¡ los escaneos.');
    // En producciÃ³n: primer escaneo diferido 10 segundos para que el servidor se estabilice (opcional)
    if (BOOTSTRAP_SCAN_ON_START) {
      setTimeout(() => {
        runFullScan().catch(err => console.error('Initial Scan Error:', err.message));
      }, 10000);
    } else {
      console.log('â¸ï¸ [SAFE MODE] BOOTSTRAP_SCAN_ON_START=false -> sin escaneo inicial.');
    }
  } else {
    console.log('â¸ï¸ [SAFE MODE] Timers locales deshabilitados para evitar trading real accidental.');
  }
});


