# 🚀 Plan Maestro de Migración a Dinero Real (PolyBot)

Este documento detalla el paso a paso exacto para conectar tu IA (Llama 3/Groq) a la blockchain de Polygon y tradear con dólares reales (USDC) en Polymarket de manera automática y sin intervención manual.

---

## 🛑 CONSIDERACIONES INICIALES PARA TUS $10 USD
Dado que vamos a empezar con **10 dólares (USDC)** para probar el sistema:
1. **Riesgo por Trade (Tamaño de Posición):** El bot tiene un límite de inversión por operación. Como tienes $10, comprar agresivamente grandes porciones puede liquidar tu capital si fallan dos. Ajustaremos la configuración para que haga compras en "micro-órdenes" de entre **$0.50 y $1.00 USD**. Así podrás ver a la IA hacer varios trades sin gastar todo de golpe.
2. **Gasolina (Gas Fees):** Necesitaremos ejecutar transacciones en la red de Polygon. Debes tener **1 POL (antes llamado MATIC, unos ~$0.40 USD)** en la billetera para poder pagarle a la red por procesar las compras. Sin esto, el bot lanzará error por "fondos insuficientes para gas".

---

## 📦 FASE 1: Configuración de la "Bóveda" Segura (Tu Wallet)
1. **Crear Billetera Exclusiva:** 
   - Abre tu Metamask y crea una **NUEVA CUENTA**. No uses tu cuenta personal de ahorros ni conectes tu Ledger. Ésta será la cuenta exclusiva del Bot.
   - Extrae la **Llave Privada (Private Key)** de esa nueva cuenta.
2. **El Fondeo:**
   - Envía **exactamente 10 USDC** a esa dirección (en la red Polygon).
   - Envía **1 POL** a esa dirección para pagar las comisiones de red.
3. **Tu Archivo .env:**
   - Agregaremos tu llave privada a tu archivo `.env` en `bot-backend`. Quedará oculto así:
     `POLYMARKET_PRIVATE_KEY="0x..."`
   *(¡Jamás subas este archivo a servidores públicos, GitHub o me lo muestres a mí en el chat!)*

## ⚙️ FASE 2: Instalación del Motor Industrial (Librerías Oficiales)
Para que Node.js hable con la máquina financiera de Polymarket, necesitamos su código oficial.
1. Ejecutaremos en tu consola de `bot-backend`:
   `npm install @polymarket/clob-client ethers@5`
2. Esto instalará la caja de herramientas oficial (CLOB = Central Limit Order Book) y la librería encriptadora `ethers` para poder firmar las compras.

## 🔐 FASE 3: Programar Autenticación Blockchain (Nivel 2)
Modificaremos tu archivo `botCore.js` para que el bot inicie sesión automáticamente al encender.
1. Polymarket requiere que primero verifiquemos tu llave con una firma digital en cadena o "EIP-712".
2. Programaremos un pequeño fragmento que tomará la llave, pedirá permiso al servidor de Polymarket y obtendrá unos secretos temporales ("API Credentials/HMAC") con los que el bot operará a máxima velocidad sin re-firmar todo el tiempo.

## 🟢 FASE 4: Re-Escribir la Función de Compra (`BUY`)
Aquí entra la magia. Tu código actual (línea 350+ en `botCore.js`) solo finge la compra y anota el ID en tu BBDD.
1. Reemplazaremos esa zona con el comando de **Orden Límite (`createOrder`)**.
2. Cuando la IA analice, por ejemplo, los partidos de Básquetbol y decida `BUY_YES`, le diremos al bot que invierta $1.00 USDC.
3. El bot mandará la orden directa a la blockchain. Solo si recibe confirmación exitosa de la red Polygon, dejará constancia en tu archivo de registro de Supabase de que se compró de forma verídica.

## 🔴 FASE 5: Re-Escribir el Piloto Automático de Venta (`SELL`)
Para evitar que se te queden estancadas las acciones de Polymarket:
1. Re-codificaremos tu actual función `fastSyncTrades()` (la que evalúa si subió el Stop Loss o Take Profit).
2. Si tocamos tu umbral sagrado (+18%), armaremos una contramedida: una orden de venta de esas mismas acciones. 
3. Se firma, se manda al mercado y Polymarket te devolverá tus $1.18 USDC de vuelta directo a tu MetaMask automáticamente.

## 🧪 FASE 6: El Primer Examen ("Testeo de Céntimos")
Antes de soltarlo 24/7 sin supervisión:
- Activaremos el bot bajo supervisión para que haga solo **un trade de $0.50 USD**.
- Yo (tú) verificaré desde el navegador en mi cuenta de Polymarket que la acción fue comprada correctamente. 
- Veremos los cobros en la red (Scan) para comprobar que la lógica no falló.
- ¡Si funciona, desbloqueamos la autonomía libre!

---
*Este plan será nuestra brújula absoluta para no cometer un solo error financiero.*
