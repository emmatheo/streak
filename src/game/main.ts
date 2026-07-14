// STREAK server. Render-ready (uses PORT), zero-config on devnet.
//   GET  /health           status + live round count
//   GET  /rounds           open rounds (one per live fixture)
//   GET  /leaderboard      top players by best streak
//   GET  /me/:name         a player's state
//   POST /guess            { name, fixtureId, dir: "higher"|"lower" }
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

async function main() {
  const txline = await new TxlineClient().init();
  const game = new StreakGame();
  const stream = makeStream(txline);

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), "src", "game", "public")));

  const clients = new Set<express.Response>();
  const push = (type: string, data: any) => {
    const p = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(p);
  };

  let feed = "starting", seen = 0, lastAt = 0;
  stream.on("status", (s) => { feed = s; console.log(`[stream] ${s}`); push("status", { feed: s }); });
  stream.on("score", (e) => { seen++; lastAt = Date.now(); game.ingest(e); });

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
  }));
  app.get("/rounds", (_q, r) => r.json([...game.rounds.values()]));
  app.get("/leaderboard", (_q, r) => r.json(game.leaderboard()));
  app.get("/me/:name", (q, r) => r.json(game.player(q.params.name)));

  app.post("/guess", (q, r) => {
    try {
      const { name, fixtureId, dir } = q.body;
      if (!name || !fixtureId || !["higher", "lower"].includes(dir))
        return r.status(400).json({ error: "need name, fixtureId, dir(higher|lower)" });
      r.json(game.guess(String(name).slice(0, 24), Number(fixtureId), dir));
    } catch (e: any) { r.status(409).json({ error: e.message }); }
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
    q.on("close", () => clients.delete(r));
  });

  app.listen(PORT, () => console.log(`[streak] live on :${PORT}`));
  await stream.start();
  console.log("[streak] running. Rounds open automatically when a match goes live.");
}

main().catch((e) => { console.error("[streak] fatal:", e.message); process.exit(1); });
