// ═══════════════════════════════════════════════════════════════════════
// PolyBot - Supabase Edge Function (Deno Runtime)
// Nombre de la función: bot-cron
//
// Esta función es llamada por Supabase Cron Jobs con diferentes tipos:
//   - type=scan     → dispara el escaneo completo de mercados (cada 30 min)
//   - type=sync     → dispara el sync de trades abiertos (cada 3 min)
//   - type=rollover → dispara el chequeo de cambio de día (cada 1 min)
//
// Para desplegar:
//   supabase functions deploy bot-cron
// ═══════════════════════════════════════════════════════════════════════

const BACKEND_URL = Deno.env.get('BACKEND_URL') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';

// Mapa de tipos a endpoints del backend
const ENDPOINT_MAP: Record<string, string> = {
  scan: '/api/cron/scan',
  sync: '/api/cron/sync',
  rollover: '/api/cron/rollover',
};

Deno.serve(async (req: Request) => {
  // Solo aceptar POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Leer el tipo del querystring o del body
  const url = new URL(req.url);
  let cronType = url.searchParams.get('type');

  if (!cronType) {
    try {
      const body = await req.json();
      cronType = body?.type ?? null;
    } catch {
      cronType = null;
    }
  }

  if (!cronType || !ENDPOINT_MAP[cronType]) {
    return new Response(
      JSON.stringify({ error: `Tipo de cron inválido: "${cronType}". Usa: scan, sync, o rollover.` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!BACKEND_URL) {
    return new Response(
      JSON.stringify({ error: 'BACKEND_URL no configurado en los secrets de Supabase.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const endpoint = `${BACKEND_URL}${ENDPOINT_MAP[cronType]}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CRON_SECRET}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();

    console.log(`[BOT-CRON] ✅ type=${cronType} → ${endpoint} → status=${response.status}`);

    return new Response(
      JSON.stringify({ ok: true, cronType, backendStatus: response.status, data }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[BOT-CRON] ❌ Error llamando ${endpoint}:`, error);
    return new Response(
      JSON.stringify({ ok: false, cronType, error }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
