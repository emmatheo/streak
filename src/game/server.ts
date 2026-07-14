// STREAK — hi-lo prediction game on real TxLINE match data.
// Track 3 (Consumer & Fan Experiences). Free-to-play: no wallet, no friction.
//
// Two sources, one game:
//   RECORDED: real TxLINE score-stream recordings (data/recordings/*.jsonl)
//             become step-through timelines — playable any time, demo-safe
//             (rules explicitly allow "live or simulated TxLINE data feeds").
//   LIVE:     when a match is on, the same game runs on the live SSE stream.
//
// The round: given the match state after update N, will the NEXT scoring
// event favor HOME or AWAY? Guess, reveal, streak. Defensive parsing:
// recordings' exact payload shape is verified-on-first-run; every extractor
// tries multiple field spellings and the server reports what it could parse.

import express from "express";
import fs from "fs";
import path from "path";
import { CFG } from "../config.js";
import { TxlineClient } from "../txline/client.js";
import { LiveScoreStream } from "../txline/stream.js";

const PORT = Number(process.env.PORT ?? 8789);

interface Step {
  t: number;              // ms
  home: number | null;    // running score if present
  away: number | null;
  side: "home" | "away" | null; // which side this update favored (the answer)
  kind: string;           // what happened, best-effort label (goal/corner/card/update)
}
interface Timeline { fixtureId: number; steps: Step[]; playable: number; }

// ---------- recording -> timeline ----------
function buildTimelines(): Timeline[] {
  const dir = path.join(process.cwd(), "data", "recordings");
  if (!fs.existsSync(dir)) return [];
  const byFixture = new Map<number, Step[]>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      const d = e.data ?? e;
      const f = d.fixtureId ?? d.fixture_id ?? d.fixture?.id;
      if (!f) continue;
      const arr = byFixture.get(Number(f)) ?? [];
      arr.push(extractStep(d, e.receivedAt ?? Date.now()));
      byFixture.set(Number(f), arr);
    }
  }
  const out: Timeline[] = [];
  for (const [fixtureId, raw] of byFixture) {
    // fill sides by score deltas where explicit side missing
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
    if (playable >= 2) out.push({ fixtureId, steps, playable });
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
async function main() {
  const timelines = buildTimelines();
  console.log(`[streak] ${timelines.length} playable recorded match(es); ` +
    (timelines.length ? `best has ${timelines[0].playable} guessable moments` :
     "add real TxLINE recordings (scores-*.jsonl) to data/recordings/"));

  const app = express();
  app.use(express.static(path.join(process.cwd(), "src", "game", "public")));

  app.get("/health", (_q, r) => r.json({
    ok: true, product: "streak-hilo", recordedGames: timelines.length,
    liveFeed: liveStatus, network: CFG.network,
  }));
  app.get("/api/games", (_q, r) => r.json(timelines.map((t) => ({
    fixtureId: t.fixtureId, rounds: t.playable, updates: t.steps.length,
  }))));
  app.get("/api/timeline/:id", (q, r) => {
    const t = timelines.find((x) => x.fixtureId === Number(q.params.id));
    return t ? r.json(t) : r.status(404).json({ error: "unknown game" });
  });

  // live passthrough: the same game, on today's match
  let liveStatus = "connecting";
  const sse = new Set<express.Response>();
  app.get("/live", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders(); sse.add(res); req.on("close", () => sse.delete(res));
  });

  app.listen(PORT, () => console.log(`[streak] serving on :${PORT}`));

  try {
    const client = await new TxlineClient().init();
    const stream = new LiveScoreStream(client, true); // records too — future games
    stream.on("status", (s) => { liveStatus = s; console.log(`[live] ${s}`); });
    stream.on("score", (e) => {
      const step = extractStep(e.data ?? {}, e.receivedAt);
      const f = (e.data ?? {}).fixtureId ?? (e.data ?? {}).fixture_id;
      const payload = `event: step\ndata: ${JSON.stringify({ fixtureId: f, ...step })}\n\n`;
      for (const c of sse) c.write(payload);
    });
    await stream.start();
  } catch (e: any) {
    liveStatus = "offline: " + e.message;
    console.warn(`[live] TxLINE unavailable (${e.message}) — recorded games still fully playable`);
  }
}
main();
