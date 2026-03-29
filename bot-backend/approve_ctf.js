/**
 * approve_ctf.js
 * Approves ALL Polymarket exchange contracts to transfer your conditional tokens (shares).
 * Run ONCE. This is required to be able to SELL positions.
 */
import pkg from "ethers";
const { Wallet, providers: ethersProviders, Contract } = pkg;
import dotenv from "dotenv";
dotenv.config();

// CTF (Conditional Token Framework) contract on Polygon - holds your shares
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

// All Polymarket contracts that need to be approved as operators
const OPERATORS = [
  { name: "CTF Exchange",         addr: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" },
  { name: "NegRisk Adapter",      addr: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" },
  { name: "NegRisk CTF Exchange", addr: "0xC5d563A36AE78145C45a50134d48A1215220f80a" },
];

const CTF_ABI = [
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
];

const POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon-rpc.com",
];

async function getProvider() {
  for (const rpc of POLYGON_RPCS) {
    try {
      const p = new ethersProviders.JsonRpcProvider(rpc);
      await p.getNetwork();
      console.log("✅ Conectado via:", rpc);
      return p;
    } catch (e) {
      console.warn("⚠️  RPC falló:", rpc);
    }
  }
  throw new Error("Todos los RPCs fallaron.");
}

async function main() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) { console.error("Falta POLYMARKET_PRIVATE_KEY"); process.exit(1); }

  const provider = await getProvider();
  const wallet = new Wallet(privateKey, provider);
  console.log("Cartera:", wallet.address);

  const ctf = new Contract(CTF_ADDRESS, CTF_ABI, wallet);
  const gasPrice = (await provider.getGasPrice()).mul(2);

  for (const op of OPERATORS) {
    const isApproved = await ctf.isApprovedForAll(wallet.address, op.addr);
    console.log(`\n[${op.name}] Aprobado: ${isApproved}`);

    if (isApproved) {
      console.log("  ✅ Ya está aprobado.");
      continue;
    }

    console.log(`  Enviando setApprovalForAll...`);
    try {
      const tx = await ctf.setApprovalForAll(op.addr, true, { gasPrice });
      console.log(`  Tx: ${tx.hash}`);
      const receipt = await tx.wait(1);
      console.log(`  ✅ APROBADO en bloque ${receipt.blockNumber}`);
    } catch (e) {
      console.error(`  ❌ Error:`, e.message);
    }
  }

  console.log("\n✅ CTF aprobado para todos los contratos. Ahora puedes vender shares.");
  console.log("Reinicia el bot: Ctrl+C -> npm start");
}

main().catch(e => { console.error("Error fatal:", e.message); process.exit(1); });
