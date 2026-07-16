# STREAK — Higher or Lower, live from the World Cup
### Track: Consumer & Fan Experiences (TxODDS World Cup Hackathon)

A World Cup match is live. Spain have 7 corners. **Higher or lower on the next
update?** Guess right, your streak grows. Guess wrong, back to zero. Every round
is opened and resolved by the **live TxLINE feed** — no human, no delay, no
waiting for someone to update a spreadsheet.

**No wallet needed to play.** Type a name, tap HIGHER or LOWER. That's it.

**But the leaderboard is verifiable.** When your run ends, mint it: the streak is
stamped on Solana as a transaction. Screenshots can be faked; a chain record
can't. Every top-3 player carries an "on-chain ↗" link a judge (or a rival) can
click.

## Why it fits the criteria
- **Fan accessibility:** one tap per round, zero crypto knowledge, zero setup.
- **Real-time responsiveness:** the game *is* the feed — each TxLINE stat update
  resolves the open round and immediately opens the next one.
- **Originality:** not a repackaged scoreboard — a live-data game loop, with a
  provable leaderboard, which no screenshot-based fan game can offer.
- **Monetization:** sponsored streak challenges, premium private leagues,
  paid-entry pools with on-chain settled prizes (the rails already exist).
- **Completeness:** deliberately small scope, fully executed end to end.

## Two ways to play, one leaderboard
**REAL MATCHES** — real TxLINE score-stream recordings become step-through
timelines: after each update, *does the next moment favour HOME or AWAY?*
Playable any time; a live match is auto-recorded so it shows up here too.

**DEMO (Higher or Lower)** — a self-contained simulated match so the page is
always playable with no feed and no wallet. Higher or lower on a live-feeling
stat, entirely in the browser.

Both modes share the streak/multiplier/points HUD, the on-chain mint, and the
verifiable leaderboard.

### How a real round works
1. TxLINE streams stat updates for a live fixture (goals, corners, cards). The
   server records every event to `data/recordings/scores-*.jsonl`.
2. STREAK turns a recording into an ordered timeline of moments.
3. After each update, the player calls the next moment: **HOME or AWAY**.
4. The next event in the tape resolves it — winners' streaks grow, a wrong call
   resets to zero.

Drop your own real TxLINE recordings into `data/recordings/` and they appear
under **Real Matches** automatically. A small sample match ships in the repo so
the mode is playable out of the box.

## TxLINE endpoints used
- `POST /auth/guest/start` → on-chain `subscribe` (free tier) → `POST /api/token/activate`
- `GET /api/scores/stream` (SSE) — recorded to `data/recordings/*.jsonl`

## API
`GET /health` · `GET /api/games` · `GET /api/timeline/:id` · `GET /leaderboard` ·
`GET /me/:name` · `POST /submit {name,streak,correct,played,points}` ·
`POST /mint {name}`

## Run
```bash
npm install
# put a funded devnet wallet at keypair.json (or set KEYPAIR_JSON env)
npm start          # http://localhost:8789
```

## Deploy (Render)
Web Service → this repo → Build `npm install` → Start `npm start`.
Env: `NETWORK=devnet`, `TXORACLE_IDL=./idls/txoracle.json`,
`KEYPAIR_JSON=<contents of keypair.json>`.
Add an UptimeRobot ping on `/health` so the free tier never sleeps during a match.

## Honest notes
- Stat availability depends on what the free World Cup tier streams; the engine
  plays on whatever keys arrive (goals always; corners/cards when present) and
  logs what it sees.
- Player identity is a name, not an account — deliberate: the lowest possible
  barrier for a mainstream fan. Minting is what makes a claim provable.
