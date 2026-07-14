// STREAK — Hi-Lo on live World Cup stats.
//
// A round is: "Spain have 7 corners. Will the NEXT stat update be HIGHER or
// LOWER?" The TxLINE scores stream resolves it — no human, no delay. Streaks
// build; a wrong guess resets. When a run ends, the player can MINT it: the
// streak is stamped on Solana as a Memo transaction, so the leaderboard is
// verifiable rather than a screenshot anyone could fake.
//
// No wallet needed to play (fan accessibility criterion). Wallet only to mint.

import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import crypto from "crypto";
import { CFG } from "../config.js";
import { ScoreEvent } from "../txline/stream.js";

const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TySNcWxMyWCqXgDLGmfcHr");

// Stat keys we play on (soccer-feed): goals, corners, cards. Labels are what
// fans see — never a raw key.
export const STATS: Record<number, string> = {
  1: "home goals", 2: "away goals",
  7: "home corners", 8: "away corners",
  3: "home yellow cards", 4: "away yellow cards",
};

export interface Round {
  id: string;
  fixtureId: number;
  statKey: number;
  label: string;      // "Spain corners"
  current: number;    // value at question time
  openedAt: number;
  closesHint: string; // human hint about resolution
}
export interface Guess { player: string; roundId: string; dir: "higher" | "lower"; at: number; }
export interface Player {
  name: string;
  streak: number;
  best: number;
  correct: number;
  played: number;
  lastPlayedAt: number;
  minted?: { streak: number; tx: string; at: number }[];
}

export class StreakGame extends EventEmitter {
  rounds = new Map<number, Round>();          // one open round per fixture
  private guesses = new Map<string, Guess[]>(); // roundId -> guesses
  players = new Map<string, Player>();
  private lastStat = new Map<string, number>(); // fixture|key -> last value
  private file = path.join(CFG.dataDir, "streak-players.json");
  private conn = new Connection(CFG.solana.rpcUrl, "confirmed");
  private payer: Keypair | null = null;

  constructor() {
    super();
    try {
      this.payer = Keypair.fromSecretKey(Uint8Array.from(
        JSON.parse(process.env.KEYPAIR_JSON ?? fs.readFileSync(CFG.keypairPath, "utf8"))));
    } catch { console.warn("[streak] no wallet — play works, minting disabled"); }
    if (fs.existsSync(this.file)) {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.file, "utf8"))))
        this.players.set(k, v as Player);
    }
  }

  /** Feed the TxLINE score stream in; rounds open and resolve from real updates. */
  ingest(e: ScoreEvent) {
    const d: any = e.data ?? {};
    const f = d.fixtureId ?? d.fixture_id; if (!f) return;
    // Pull whatever stats this update carries.
    const found: [number, number][] = [];
    const h = d.homeScore ?? d.home_score ?? d.score?.home;
    const a = d.awayScore ?? d.away_score ?? d.score?.away;
    if (h != null) found.push([1, Number(h)]);
    if (a != null) found.push([2, Number(a)]);
    for (const s of (d.stats ?? d.statistics ?? [])) {
      const k = Number(s.key ?? s.statKey), v = Number(s.value);
      if (STATS[k] && Number.isFinite(v)) found.push([k, v]);
    }
    for (const [key, val] of found) {
      const sk = `${f}|${key}`;
      const prev = this.lastStat.get(sk);
      this.lastStat.set(sk, val);
      const open = this.rounds.get(f);
      // Resolve an open round when ITS stat moves.
      if (open && open.statKey === key && prev !== undefined && val !== open.current) {
        this.resolve(open, val);
      }
    }
    // Open a fresh round for this fixture if none is live.
    if (!this.rounds.get(f) && found.length) this.openRound(f);
  }

  private openRound(fixtureId: number) {
    // Prefer a stat that actually moves (corners > goals for playability).
    const candidates = [7, 8, 1, 2, 3, 4].filter((k) => this.lastStat.has(`${fixtureId}|${k}`));
    if (!candidates.length) return;
    const statKey = candidates[Math.floor(Math.random() * Math.min(2, candidates.length))];
    const current = this.lastStat.get(`${fixtureId}|${statKey}`)!;
    const r: Round = {
      id: `${fixtureId}-${statKey}-${Date.now()}`,
      fixtureId, statKey, label: STATS[statKey], current,
      openedAt: Date.now(),
      closesHint: "Resolves on the next TxLINE update for this stat",
    };
    this.rounds.set(fixtureId, r);
    this.guesses.set(r.id, []);
    this.emit("round", r);
  }

  guess(player: string, fixtureId: number, dir: "higher" | "lower") {
    const r = this.rounds.get(fixtureId);
    if (!r) throw new Error("no open round for this match");
    const list = this.guesses.get(r.id)!;
    if (list.some((g) => g.player === player)) throw new Error("you already guessed this round");
    list.push({ player, roundId: r.id, dir, at: Date.now() });
    const p = this.player(player);
    this.emit("guessed", { player, roundId: r.id, dir, streak: p.streak });
    return { ok: true, round: r };
  }

  private resolve(r: Round, newVal: number) {
    const went: "higher" | "lower" = newVal > r.current ? "higher" : "lower";
    const list = this.guesses.get(r.id) ?? [];
    const results = list.map((g) => {
      const p = this.player(g.player);
      const won = g.dir === went;
      p.played++;
      if (won) { p.correct++; p.streak++; p.best = Math.max(p.best, p.streak); }
      else p.streak = 0;
      p.lastPlayedAt = Date.now();
      return { player: g.player, won, streak: p.streak, best: p.best };
    });
    this.rounds.delete(r.fixtureId);
    this.save();
    this.emit("resolved", { round: r, went, from: r.current, to: newVal, results });
    this.openRound(r.fixtureId); // next round immediately — keeps the loop tight
  }

  /** Stamp a finished run on Solana. The leaderboard becomes verifiable. */
  async mint(name: string): Promise<{ tx: string; streak: number }> {
    const p = this.player(name);
    const streak = Math.max(p.streak, p.best);
    if (streak < 1) throw new Error("nothing to mint yet — get at least one right");
    if (!this.payer) throw new Error("minting unavailable (no server wallet configured)");
    const payload = {
      t: "streak", player: name, streak, correct: p.correct, played: p.played,
      sha: crypto.createHash("sha256").update(`${name}|${streak}|${p.played}`).digest("hex").slice(0, 16),
    };
    const ix = new TransactionInstruction({
      keys: [{ pubkey: this.payer.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO,
      data: Buffer.from(JSON.stringify(payload), "utf8"),
    });
    const tx = await sendAndConfirmTransaction(this.conn, new Transaction().add(ix), [this.payer]);
    (p.minted ??= []).push({ streak, tx, at: Date.now() });
    this.save();
    this.emit("minted", { player: name, streak, tx });
    return { tx, streak };
  }

  leaderboard() {
    return [...this.players.entries()]
      .map(([name, p]) => ({
        name, best: p.best, streak: p.streak, correct: p.correct, played: p.played,
        accuracy: p.played ? Math.round((p.correct / p.played) * 100) : 0,
        minted: (p.minted ?? []).slice(-1)[0] ?? null,
      }))
      .sort((a, b) => b.best - a.best || b.accuracy - a.accuracy)
      .slice(0, 50);
  }

  player(name: string): Player {
    let p = this.players.get(name);
    if (!p) { p = { name, streak: 0, best: 0, correct: 0, played: 0, lastPlayedAt: 0 }; this.players.set(name, p); }
    return p;
  }
  private save() {
    fs.mkdirSync(CFG.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.players)));
  }
}
