// One-shot devnet wallet bootstrap for the TxLINE live feed.
//   npm run genkey
// Generates a keypair at ./keypair.json (unless one already exists), then makes
// a best-effort devnet airdrop so it can pay the fee for the on-chain
// `subscribe` instruction. Fund it further at https://faucet.solana.com if the
// airdrop is rate-limited. The free World Cup tier needs no TxL tokens — only a
// tiny amount of devnet SOL to sign the subscribe tx.

import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import fs from "fs";
import { CFG } from "../config.js";

async function main() {
  const p = CFG.keypairPath;
  let kp: Keypair;
  if (fs.existsSync(p)) {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
    console.log(`[genkey] using existing wallet at ${p}`);
  } else {
    kp = Keypair.generate();
    fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
    console.log(`[genkey] new wallet written to ${p}`);
  }
  console.log(`[genkey] public key: ${kp.publicKey.toBase58()}`);
  console.log(`[genkey] network:    ${CFG.network}  (${CFG.solana.rpcUrl})`);

  const conn = new Connection(CFG.solana.rpcUrl, "confirmed");
  let bal = await conn.getBalance(kp.publicKey);
  console.log(`[genkey] balance:    ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  if (CFG.network === "devnet" && bal < 0.05 * LAMPORTS_PER_SOL) {
    try {
      console.log("[genkey] requesting 1 SOL devnet airdrop…");
      const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
      bal = await conn.getBalance(kp.publicKey);
      console.log(`[genkey] airdrop ok — balance now ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    } catch (e: any) {
      console.warn(`[genkey] airdrop failed (${e.message}). Fund manually at ` +
        `https://faucet.solana.com (paste the public key above), then re-run npm run verify.`);
    }
  }

  console.log("\nNext:");
  console.log("  • Local:  npm run verify   (proves the live TxLINE feed end-to-end)");
  console.log("  • Deploy: set KEYPAIR_JSON on Render to the contents of keypair.json");
  console.log("            (the array of numbers) so the live feed can authenticate.");
}

main().catch((e) => { console.error("[genkey] fatal:", e.message); process.exit(1); });
