// Proof that the product is actually talking to the live TxLINE API — run this
// wherever outbound network + a funded devnet wallet are available:
//
//   npm run genkey     # once: create + fund a devnet wallet
//   npm run verify     # exercises the full live path and prints PASS/FAIL
//
// It runs the exact onboarding the game server uses (guest JWT -> on-chain
// subscribe -> token/activate) and then pulls real data back, so a green run
// here means the game's live feed will authenticate and stream for real.

import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import fs from "fs";
import { CFG } from "../config.js";
import { getCredentials } from "./auth.js";
import { TxlineClient } from "./client.js";

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const info = (m: string) => console.log(`  · ${m}`);

async function main() {
  console.log("\nSTREAK · TxLINE live-feed verification");
  console.log("─".repeat(44));
  info(`network:   ${CFG.network}`);
  info(`api:       ${CFG.txline.apiOrigin}`);
  info(`program:   ${CFG.txline.programId}`);
  info(`rpc:       ${CFG.solana.rpcUrl}`);
  info(`level:     ${CFG.txline.serviceLevel} (1 = free WC 60s-delay)`);

  // 1) wallet present + funded enough to sign the subscribe tx
  let secret: string;
  try { secret = process.env.KEYPAIR_JSON ?? fs.readFileSync(CFG.keypairPath, "utf8"); }
  catch { throw new Error(`no wallet — run 'npm run genkey' (or set KEYPAIR_JSON) first`); }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  ok(`wallet loaded: ${kp.publicKey.toBase58()}`);
  const conn = new Connection(CFG.solana.rpcUrl, "confirmed");
  const bal = await conn.getBalance(kp.publicKey);
  info(`balance:   ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (bal === 0) throw new Error("wallet has 0 SOL — fund it (npm run genkey / faucet.solana.com)");

  // 2) full onboarding: guest JWT -> on-chain subscribe -> token/activate
  console.log("\n  onboarding (guest → subscribe → activate)…");
  const creds = await getCredentials();
  ok(`guest JWT obtained (${creds.jwt.length} chars)`);
  ok(`api token activated (${String(creds.apiToken).length} chars)`);

  // 3) pull real data back with those credentials
  console.log("\n  fetching live data…");
  const client = await new TxlineClient().init();
  const updates = await client.scoresUpdatesAt(new Date());
  const n = Array.isArray(updates) ? updates.length
    : Array.isArray(updates?.updates) ? updates.updates.length : null;
  ok(`GET /api/scores/updates → ${n ?? "response"} ${n === null ? "" : "update(s)"} this interval`);
  info(`sample: ${JSON.stringify(updates).slice(0, 200)}…`);

  const fixtureArg = process.argv[2];
  if (fixtureArg) {
    const snap = await client.scoresSnapshot(Number(fixtureArg));
    ok(`GET /api/scores/snapshot/${fixtureArg} → ${JSON.stringify(snap).slice(0, 200)}…`);
  }

  console.log("\n\x1b[32mPASS\x1b[0m — live TxLINE feed authenticated and returning data.");
  console.log("The game server (npm run live) will now open rounds from real updates.\n");
}

main().catch((e) => {
  console.error(`\n\x1b[31mFAIL\x1b[0m — ${e.message}`);
  if (e?.response?.data) console.error("  response:", JSON.stringify(e.response.data).slice(0, 300));
  console.error("  (no wallet? run 'npm run genkey'. Network blocked? this host's egress " +
    "policy must allow txline-dev.txodds.com and api.devnet.solana.com.)\n");
  process.exit(1);
});
