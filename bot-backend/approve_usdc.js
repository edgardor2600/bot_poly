/**
 * approve_usdc.js
 * Approves ALL Polymarket contracts to spend USDC.e.
 * Run ONCE before starting the bot.
 */
import pkg from "ethers";
const { Wallet, providers: ethersProviders, Contract, BigNumber } = pkg;
import dotenv from "dotenv";
dotenv.config();

const USDCE_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// ALL Polymarket contracts that may spend USDC.e
const POLYMARKET_SPENDERS = [
  { name: "CTF Exchange",        addr: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" },
  { name: "NegRisk Adapter",     addr: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" },
  { name: "NegRisk CTF Exchange",addr: "0xC5d563A36AE78145C45a50134d48A1215220f80a" },
];

const MAX_ALLOWANCE = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const POLYGON_RPCS = [
  "https://polygon.llamarpc.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon-rpc.com",
];

async function getProvider() {
  for (const rpc of POLYGON_RPCS) {
    try {
      const p = new ethersProviders.JsonRpcProvider(rpc);
      await p.getNetwork();
      console.log("✅ Conectado a Polygon via:", rpc);
      return p;
    } catch (e) {
      console.warn("⚠️  RPC falló:", rpc);
    }
  }
  throw new Error("Todos los endpoints de Polygon fallaron. Verifica tu internet.");
}

async function main() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) { console.error("Falta POLYMARKET_PRIVATE_KEY en .env"); process.exit(1); }

  const provider = await getProvider();
  const wallet = new Wallet(privateKey, provider);
  console.log("Cartera:", wallet.address);

  const usdc = new Contract(USDCE_ADDRESS, ERC20_ABI, wallet);
  const decimals = Number(await usdc.decimals());
  const balance = await usdc.balanceOf(wallet.address);
  console.log(`\nUSDC.e en cartera: ${(Number(balance) / 10**decimals).toFixed(4)}`);

  const gasPrice = (await provider.getGasPrice()).mul(2);

  for (const spender of POLYMARKET_SPENDERS) {
    const currentAllowance = await usdc.allowance(wallet.address, spender.addr);
    const allowanceNum = Number(currentAllowance) / 10**decimals;
    console.log(`\n[${spender.name}] Permiso actual: ${allowanceNum.toFixed(2)} USDC.e`);

    if (allowanceNum > 1_000_000) {
      console.log(`  ✅ Ya tiene permiso suficiente.`);
      continue;
    }

    console.log(`  Enviando approve() para ${spender.name}...`);
    try {
      const tx = await usdc.approve(spender.addr, MAX_ALLOWANCE, { gasPrice });
      console.log(`  Tx: ${tx.hash}`);
      const receipt = await tx.wait(1);
      console.log(`  ✅ APROBADO en bloque ${receipt.blockNumber}`);
    } catch (e) {
      console.error(`  ❌ Error aprobando ${spender.name}:`, e.message);
    }
  }

  console.log("\n✅ Todos los permisos listos. Ahora corre: npm start");
}

main().catch(e => { console.error("Error fatal:", e.message); process.exit(1); });
