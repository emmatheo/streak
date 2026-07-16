// STREAK server. Render-ready (uses PORT), zero-config on devnet.
//
// Design goal: the page is ALWAYS playable. The web UI ships a self-contained
// "demo match" (a simulated live feed) so a fan can play instantly — no live
// World Cup fixture, no wallet, no network required. The live TxLINE feed is
// wired in on a best-effort background task: if it can't connect (no creds /
// offline), the server stays up and the demo game still works.
//
//   GET  /health           status + live round count
//   GET  /rounds           open LIVE rounds (one per live fixture)
//   GET  /leaderboard      top players by best streak
//   GET  /me/:name         a player's state
//   POST /guess            { name, fixtureId, dir }         (live rounds)
//   POST /submit           { name, streak, correct, played, points }  (demo runs)
//   POST /mint             { name }  -> stamps the streak on Solana
//   GET  /events           SSE: round | resolved | minted | status
//   GET  /                 the game UI

import express from "express";
import path from "path";
import { CFG } from "../config.js";
import { TxlineClient } from "../txline/client.js";
import { makeStream } from "../txline/stream.js";
import { StreakGame } from "./engine.js";

const PORT = Number(process.env.PORT ?? 8789);

function main() {
  const game = new StreakGame();
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), "src", "game", "public")));

  const clients = new Set<express.Response>();
  const push = (type: string, data: any) => {
    const p = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(p);
  };

  let feed = "demo-only", seen = 0, lastAt = 0;

  game.on("round", (r) => { console.log(`[round] ${r.label} = ${r.current} (fixture ${r.fixtureId})`); push("round", r); });
  game.on("resolved", (x) => {
    console.log(`[resolved] ${x.round.label}: ${x.from} -> ${x.to} (${x.went}); ${x.results.length} guess(es)`);
    push("resolved", x);
  });
  game.on("minted", (m) => push("minted", m));

  app.get("/health", (_q, r) => r.json({
    ok: true, game: "streak", network: CFG.network, feed,
    updatesSeen: seen, secondsSinceUpdate: lastAt ? Math.round((Date.now() - lastAt) / 1000) : null,
    openRounds: game.rounds.size, players: game.players.size,
    mintable: game.canMint(),
  }));
  app.get("/rounds", (_q, r) => r.json([...game.rounds.values()]));
  app.get("/leaderboard", (_q, r) => r.json(game.leaderboard()));
  app.get("/me/:name", (q, r) => r.json(game.player(String(q.params.name).slice(0, 24))));

  app.post("/guess", (q, r) => {
    try {
      const { name, fixtureId, dir } = q.body;
      if (!name || !fixtureId || !["higher", "lower"].includes(dir))
        return r.status(400).json({ error: "need name, fixtureId, dir(higher|lower)" });
      r.json(game.guess(String(name).slice(0, 24), Number(fixtureId), dir));
    } catch (e: any) { r.status(409).json({ error: e.message }); }
  });

  // A finished demo run reports to the shared leaderboard.
  app.post("/submit", (q, r) => {
    try {
      const { name, streak, correct, played, points } = q.body ?? {};
      if (!name) return r.status(400).json({ error: "need name" });
      r.json(game.submitRun(String(name).slice(0, 24), {
        streak: Number(streak) || 0, correct: Number(correct) || 0,
        played: Number(played) || 0, points: Number(points) || 0,
      }));
    } catch (e: any) { r.status(400).json({ error: e.message }); }
  });

  app.post("/mint", async (q, r) => {
    try {
      const { name } = q.body;
      if (!name) return r.status(400).json({ error: "need name" });
      const out = await game.mint(String(name).slice(0, 24));
      r.json({ ...out, explorer: `https://explorer.solana.com/tx/${out.tx}?cluster=${CFG.network}` });
    } catch (e: any) { r.status(400).json({ error: e.message }); }
  });

  app.get("/events", (q, r) => {
    r.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    r.flushHeaders();
    clients.add(r);
    r.write(`event: status\ndata: ${JSON.stringify({ feed })}\n\n`);
    q.on("close", () => clients.delete(r));
  });

  // Serve the UI immediately — the demo game must work no matter what the feed does.
  app.listen(PORT, () => {
    console.log(`[streak] live on :${PORT}  (demo match is always playable)`);
    if (!game.canMint()) console.log("[streak] no wallet configured — play + demo work, on-chain minting disabled");
  });

  // Best-effort: attach the real TxLINE feed in the background. Any failure here
  // is logged and swallowed so the server (and the demo game) stay up.
  connectLiveFeed(game, (s) => { feed = s; push("status", { feed: s }); }, () => { seen++; lastAt = Date.now(); })
    .catch((e) => { feed = `demo-only (live feed unavailable: ${e.message})`; console.warn(`[streak] live feed off: ${e.message}`); });
}

async function connectLiveFeed(game: StreakGame, onStatus: (s: string) => void, onScore: () => void) {
  onStatus("connecting");
  const txline = await new TxlineClient().init();
  const stream = makeStream(txline);
  stream.on("status", (s) => { onStatus(s); console.log(`[stream] ${s}`); });
  stream.on("score", (e) => { onScore(); game.ingest(e); });
  await stream.start();
  console.log("[streak] live TxLINE feed attached — real matches open rounds automatically.");
}

main();
