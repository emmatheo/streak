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

## How a round works
1. TxLINE sends a stat update for a live fixture (goals, corners, cards).
2. STREAK opens a round: "home corners = 7. Higher or lower?"
3. Players guess (one guess each, locked in).
4. The next TxLINE update for that stat resolves it — winners' streaks grow.
5. A new round opens instantly. The loop runs as long as the match does.

## TxLINE endpoints used
- `POST /auth/guest/start` → on-chain `subscribe` (free tier) → `POST /api/token/activate`
- `GET /api/scores/stream` (SSE) — opens and resolves every round

## API
`GET /health` · `GET /rounds` · `GET /leaderboard` · `GET /me/:name` ·
`POST /guess {name,fixtureId,dir}` · `POST /mint {name}` · `GET /events` (SSE)

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
