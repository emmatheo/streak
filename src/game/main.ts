// STREAK server. Render-ready (uses PORT), zero-config on devnet.
//
// Two ways to play, one leaderboard:
//   REAL MATCHES  — real TxLINE score-stream recordings (data/recordings/*.jsonl)
//                   become step-through timelines: "after this update, does the
//                   NEXT moment favour HOME or AWAY?" Playable any time; a live
//                   match is auto-recorded so it shows up here too.
//   DEMO (Hi-Lo)  — a self-contained simulated match so the page is ALWAYS
//                   playable with no feed and no wallet (Higher or Lower on a
//                   live-feeling stat). Runs entirely in the browser.
//
// The server boots the HTTP layer FIRST, then best-effort attaches the live
// TxLINE feed to RECORD new matches. Any feed/wallet failure is logged and
// swallowed, so both game modes keep working.
//
//   GET  /health              status: recorded games, live feed, mintable
//   GET  /api/games           list of recorded real matches (real mode)
//   GET  /api/timeline/:id     the step timeline for one recorded match
//   GET  /leaderboard         top players by best streak
//   GET  /me/:name            a player's state
//   POST /submit              { name, streak, correct, played, points }
//   POST /mint                { name } -> stamps the streak on Solana
//   GET  /                    the game UI

import express from "express";
import fs from "fs";
import path from "path";
import { CFG } from "../config.js";
import { TxlineClient } from "../txline/client.js";
import { LiveScoreStream } from "../txline/stream.js";
import { StreakGame } from "./engine.js";

const PORT = Number(process.env.PORT ?? 8789);

// ---------- recording -> timeline (real match mode) ----------
interface Step {
  t: number;                     // ms
  home: number | null;           // running score if present
  away: number | null;
  side: "home" | "away" | null;  // which side this update favoured (the answer)
  kind: string;                  // goal | corner | card | update (best-effort)
}
interface Timeline { fixtureId: number; homeTeam: string; awayTeam: string; steps: Step[]; playable: number; }

const RECORDINGS_DIR = path.join(CFG.dataDir, "recordings");

function buildTimelines(): Timeline[] {
  if (!fs.existsSync(RECORDINGS_DIR)) return [];
  const byFixture = new Map<number, Step[]>();
  const teams = new Map<number, { home: string; away: string }>();
  for (const file of fs.readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(RECORDINGS_DIR, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      const d = e.data ?? e;
      const f = d.fixtureId ?? d.fixture_id ?? d.fixture?.id;
      if (!f) continue;
      const fid = Number(f);
      const arr = byFixture.get(fid) ?? [];
      arr.push(extractStep(d, e.receivedAt ?? Date.now()));
      byFixture.set(fid, arr);
      // capture team names from whatever spelling the feed used
      const hn = d.homeTeam ?? d.home_team ?? d.home?.name ?? d.teams?.home;
      const an = d.awayTeam ?? d.away_team ?? d.away?.name ?? d.teams?.away;
      if (hn || an) teams.set(fid, { home: hn ?? teams.get(fid)?.home ?? "Home", away: an ?? teams.get(fid)?.away ?? "Away" });
    }
  }
  const out: Timeline[] = [];
  for (const [fixtureId, raw] of byFixture) {
    // fill sides by score deltas where an explicit side is missing
    let ph = 0, pa = 0;
    const steps = raw.map((s) => {
      if (s.side === null && s.home !== null && s.away !== null) {
        if (s.home > ph) s.side = "home";
        else if (s.away > pa) s.side = "away";
        if (s.side) s.kind = "goal";
      }
      if (s.home !== null) ph = s.home;
      if (s.away !== null) pa = s.away;
      return s;
    });
    const playable = steps.filter((s) => s.side).length;
    const t = teams.get(fixtureId);
    if (playable >= 2) out.push({ fixtureId, homeTeam: t?.home ?? "Home", awayTeam: t?.away ?? "Away", steps, playable });
  }
  return out.sort((a, b) => b.playable - a.playable);
}

function extractStep(d: any, t: number): Step {
  const home = num(d.homeScore ?? d.home_score ?? d.score?.home);
  const away = num(d.awayScore ?? d.away_score ?? d.score?.away);
  // explicit stat events: TxLINE ScoreStat keys are odd=P1(home), even=P2(away)
  const key = num(d.key ?? d.statKey ?? d.stat?.key);
  let side: Step["side"] = null, kind = "update";
  if (key !== null && key >= 1 && key <= 8) {
    side = key % 2 === 1 ? "home" : "away";
    kind = key <= 2 ? "goal" : key <= 6 ? "card" : "corner";
  }
  return { t, home, away, side, kind };
}
const num = (x: any) => (x === undefined || x === null || isNaN(Number(x)) ? null : Number(x));

// ---------- server ----------
function main() {
  const game = new StreakGame();
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), "src", "game", "public")));

  let feed = "recording off";

  app.get("/health", (_q, r) => r.json({
    ok: true, game: "streak", network: CFG.network, feed,
    recordedGames: buildTimelines().length,
    players: game.players.size,
    mintable: game.canMint(),
  }));

  // real-match mode: recorded TxLINE matches, rebuilt each call so live
  // recordings appear without a restart.
  app.get("/api/games", (_q, r) => r.json(buildTimelines().map((t) => ({
    fixtureId: t.fixtureId, homeTeam: t.homeTeam, awayTeam: t.awayTeam,
    rounds: t.playable, updates: t.steps.length,
  }))));
  app.get("/api/timeline/:id", (q, r) => {
    const t = buildTimelines().find((x) => x.fixtureId === Number(q.params.id));
    return t ? r.json(t) : r.status(404).json({ error: "unknown game" });
  });

  app.get("/leaderboard", (_q, r) => r.json(game.leaderboard()));
  app.get("/me/:name", (q, r) => r.json(game.player(String(q.params.name).slice(0, 24))));

  // a finished run (either mode) reports to the shared leaderboard
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

  // Serve the UI immediately — both game modes must work no matter what the feed does.
  app.listen(PORT, () => {
    const n = buildTimelines().length;
    console.log(`[streak] live on :${PORT}  (demo always playable · ${n} recorded match${n === 1 ? "" : "es"})`);
    if (!game.canMint()) console.log("[streak] no wallet configured — play works, on-chain minting disabled");
  });

  // Best-effort: attach the live TxLINE feed to RECORD new matches into
  // data/recordings so they become playable real matches. Non-fatal.
  recordLiveMatches((s) => { feed = s; }).catch((e) => {
    feed = `recording off (live feed unavailable: ${e.message})`;
    console.warn(`[streak] live recording off: ${e.message} — recorded + demo games still fully playable`);
  });
}

async function recordLiveMatches(onStatus: (s: string) => void) {
  onStatus("connecting");
  const client = await new TxlineClient().init();
  const stream = new LiveScoreStream(client, true); // records to data/recordings/*.jsonl
  stream.on("status", (s) => { onStatus(s); console.log(`[live] ${s}`); });
  await stream.start();
  console.log("[streak] recording live TxLINE matches — they appear under Real Matches automatically.");
}

main();
