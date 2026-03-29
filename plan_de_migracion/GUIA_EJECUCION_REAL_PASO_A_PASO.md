# Guía de Ejecución Real Paso a Paso (PolyBot)

Objetivo: pasar del MVP simulado actual a un bot que opere en Polymarket con dinero real de forma controlada, auditable y segura.

Estado actual confirmado:
- El bot analiza mercados y genera señales.
- El bot "compra" y "cierra" en simulación (sin órdenes reales CLOB).
- Ya tienes instalada la librería oficial `@polymarket/clob-client`.

---

## Fase 0: Cierre de riesgos críticos (hacer esto primero)

Checklist:
- [ ] Rotar inmediatamente secretos expuestos o débiles.
- [ ] Cambiar `CRON_SECRET` por uno largo y aleatorio en entorno.
- [ ] Verificar que no haya llaves reales hardcodeadas en SQL, código o commits.
- [ ] Confirmar que `.env` nunca se sube al repo.

Acciones concretas:
1. Generar nuevos secretos y reemplazar en Render/Supabase.
2. Revocar/rotar cualquier llave que haya pasado por archivos versionados.
3. Confirmar que backend nunca arranca con secretos por defecto.

Criterio de "Done":
- No existe secreto sensible activo dentro del repositorio.
- El backend falla al iniciar si faltan secretos críticos.

---

## Fase 1: Definir modo de wallet y autenticación real

Debes decidir 1 modo:
1. `EOA` (signatureType `0`): wallet propia, pagas gas con POL.
2. `Proxy wallet` (signatureType `1` o `2`): depende del tipo de cuenta Polymarket.

Variables de entorno recomendadas:
- `POLYMARKET_PRIVATE_KEY`
- `POLYMARKET_HOST=https://clob.polymarket.com`
- `POLYMARKET_CHAIN_ID=137`
- `POLYMARKET_SIGNATURE_TYPE=0|1|2`
- `POLYMARKET_FUNDER=0x...`

Implementación:
- Crear un módulo dedicado de cliente CLOB (ejemplo: `bot-backend/polymarketClient.js`).
- Inicializar `ClobClient` de dos pasos:
1. Cliente temporal para `createOrDeriveApiKey()`.
2. Cliente final con `creds`, `signatureType`, `funder`.

Criterio de "Done":
- Existe función `initPolymarketClient()` que devuelve cliente autenticado L2 funcionando.
- Se valida conexión con `getOk()` al arrancar.

---

## Fase 2: Normalización de mercado para operar (token IDs reales)

Problema actual:
- El flujo usa `marketId` para análisis, pero para trading necesitas `tokenID` (YES/NO).

Implementación:
1. En cada mercado, extraer y guardar:
- `clobTokenIds[0]` como token YES
- `clobTokenIds[1]` como token NO
2. Al generar señal:
- `BUY_YES` -> usar token YES
- `BUY_NO` -> usar token NO
3. Guardar en la señal y en el trade:
- `condition_id`
- `token_id`
- `outcome` (`YES`/`NO`)

Criterio de "Done":
- Cada trade OPEN tiene su `token_id` correcto y verificable.

---

## Fase 3: Preparar prechecks de fondos y allowance

Antes de cada BUY/SELL debes validar:
- Balance disponible.
- Allowance suficiente para el asset que corresponda.

SDK útil:
- `getBalanceAllowance({ asset_type: COLLATERAL })` para compra.
- `getBalanceAllowance({ asset_type: CONDITIONAL, token_id })` para venta.
- `updateBalanceAllowance(...)` cuando falte aprobación.

Regla operativa:
- Si no hay balance/allowance suficiente, no se envía orden.
- Se registra evento con causa exacta de bloqueo.

Criterio de "Done":
- Ninguna orden se intenta sin pasar prechecks.

---

## Fase 4: Migrar BUY de simulado a real

Archivo impactado principal actual:
- `bot-backend/botCore.js`

Reemplazo del bloque de compra:
1. Mantener el cálculo de monto y riesgo.
2. Convertir monto USDC a `size` en shares.
3. Obtener `tickSize` y `negRisk` del mercado/token.
4. Enviar orden real con `createAndPostOrder(...)`:
- `side: BUY`
- `tokenID: ...`
- `price: ...`
- `size: ...`
- `orderType: GTC` (o FOK/FAK para ejecución inmediata)
5. Persistir respuesta real:
- `orderID`
- `status`
- `created_at`

Importante:
- Si la orden es rechazada, NO descontar capital local.
- Solo marcar ejecutado cuando exista fill/confirmación real.

Criterio de "Done":
- El bot crea órdenes BUY reales y guarda `orderID` en DB.

---

## Fase 5: Migrar SELL automático real (TP/SL)

Problema actual:
- El cierre en `fastSyncTrades()` es virtual.

Nuevo flujo:
1. Detectar trigger TP/SL.
2. Crear orden `SELL` para el mismo `token_id`.
3. Manejar fill parcial:
- `OPEN` -> `CLOSING` -> `PARTIAL` o `CLOSED`
4. Confirmar trade final consultando:
- `getOrder(orderID)`
- `getTrades(...)` del usuario/asset
5. Calcular PnL con datos de ejecución real.

Criterio de "Done":
- Los cierres ocurren por órdenes SELL reales y PnL usa fills reales.

---

## Fase 6: Rediseño mínimo de base de datos (auditoría real)

Tu tabla actual sirve para simulación; para real necesitas trazabilidad.

Campos mínimos nuevos para `user_trades`:
- `condition_id`
- `token_id`
- `buy_order_id`
- `sell_order_id`
- `buy_status`
- `sell_status`
- `filled_size`
- `avg_entry_price`
- `avg_exit_price`
- `close_reason` (`TAKE_PROFIT`, `STOP_LOSS`, `MANUAL`, etc)
- `tx_hash_buy`
- `tx_hash_sell`

Tabla adicional recomendada: `order_events`
- `id`, `trade_id`, `order_id`, `event_type`, `payload_json`, `created_at`

Criterio de "Done":
- Puedes reconstruir cualquier trade real completo con evidencia de orden/estado/hash.

---

## Fase 7: Control de riesgo productivo (obligatorio)

Límites recomendados para empezar con $10:
- `max_usdc_per_trade`: 0.50 a 1.00
- `max_open_trades`: 2 o 3
- `max_exposure_total`: 40% del capital
- `max_daily_loss_usdc`: 1.50 a 2.00
- `max_same_market_exposure`: 1 trade por market

Circuit breakers:
- Si hay 3 errores seguidos de orden -> pausar autotrade.
- Si falla auth/allowance repetido -> pausar.
- Si spread o liquidez fuera de umbral -> no entrar.

Criterio de "Done":
- El bot puede auto-pausarse por riesgo sin intervención manual.

---

## Fase 8: Idempotencia y recuperación tras reinicio

Necesario porque usas cron:
- Evitar duplicar órdenes en reintentos.
- Recuperar estado real al reiniciar backend.

Implementación:
1. Lock por ciclo (`scan` y `sync`) en DB o memoria distribuida.
2. `client_order_ref` único por señal (si aplica).
3. En arranque:
- Cargar trades OPEN/CLOSING desde DB.
- Reconciliar con `getOpenOrders()` y `getTrades()`.

Criterio de "Done":
- Un reinicio no duplica compras ni "pierde" trades abiertos.

---

## Fase 9: Pruebas por etapas (sin saltarse pasos)

Etapa A:
- [ ] Paper mode con mismas funciones reales, pero bandera `DRY_RUN=true`.

Etapa B:
- [ ] 1 compra real de $0.50 manualmente disparada.
- [ ] Confirmación de `orderID`, fill, y registro DB.

Etapa C:
- [ ] 1 venta real (forzada o por TP/SL).
- [ ] Confirmación de PnL con ejecución real.

Etapa D:
- [ ] Autotrade activado por ventana corta (2-4 horas) con monitoreo.

Etapa E:
- [ ] Operación continua con alertas.

Criterio de "Done":
- 5 trades completos (BUY+SELL) sin inconsistencias de estado/DB.

---

## Fase 10: Orden recomendado de commits (para hacerlo paso a paso)

1. `chore(security): remove defaults and rotate secrets`
2. `feat(trading): add polymarket authenticated client module`
3. `feat(markets): map condition to YES/NO token ids`
4. `feat(risk): add balance and allowance prechecks`
5. `feat(execution): replace simulated BUY with createAndPostOrder`
6. `feat(execution): replace simulated SELL with real close orders`
7. `feat(db): extend user_trades and add order_events`
8. `feat(recovery): startup reconciliation for open orders`
9. `test(prod): run 0.50 USDC real trade checklist`

---

## Fase 11: Runbook diario de operación

Antes de activar:
- [ ] Backend healthy
- [ ] CLOB auth ok
- [ ] Balance USDC/POL correcto
- [ ] Allowance ok
- [ ] Cron activo

Durante:
- [ ] Revisar logs cada 30-60 min
- [ ] Vigilar errores repetidos
- [ ] Confirmar que no hay trades "colgados" en `CLOSING`

Después:
- [ ] Reconciliación de PnL real vs DB
- [ ] Guardar reporte diario

---

## Lista de archivos actuales que vamos a tocar primero

- `C:\Users\EDGARDO\Downloads\poly\bot-backend\botCore.js`
- `C:\Users\EDGARDO\Downloads\poly\bot-backend\server.js`
- `C:\Users\EDGARDO\Downloads\poly\bot-backend\package.json`
- `C:\Users\EDGARDO\Downloads\poly\supabase\setup_cron.sql`

Archivos nuevos recomendados:
- `C:\Users\EDGARDO\Downloads\poly\bot-backend\polymarketClient.js`
- `C:\Users\EDGARDO\Downloads\poly\bot-backend\tradeExecutor.js`
- `C:\Users\EDGARDO\Downloads\poly\bot-backend\riskGuards.js`
- `C:\Users\EDGARDO\Downloads\poly\supabase\migrations\*.sql`

---

## Criterio de salida final (migración completa)

La migración se considera terminada solo cuando:
- El 100% de BUY/SELL ocurre por órdenes reales CLOB.
- El estado en DB refleja estados reales de órdenes/trades.
- Hay reconciliación automática tras reinicios.
- Los límites de riesgo y pausas automáticas funcionan.
- Ya corriste varios ciclos con micro-órdenes sin errores críticos.

---

## Referencias oficiales usadas

- https://docs.polymarket.com/trading/overview
- https://docs.polymarket.com/quickstart
- https://docs.polymarket.com/trading/orders/overview
- https://docs.polymarket.com/concepts/order-lifecycle
- https://docs.polymarket.com/market-data/fetching-markets
