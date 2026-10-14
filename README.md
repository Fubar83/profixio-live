# profixio-live

Helper screen for registering live handball events in Profixio, built mobile-first for a phone or tablet.
Shows both teams' rosters with shirt numbers, goals and suspensions, plus score and match clock, and
refreshes every 30 seconds while the match is on.

The main use: a coach tells you a name, you type a few letters and see the number.

## How it's built

- `public/` is a static front-end. It uses plain HTML/JS and Tailwind CSS, and reads Profixio's pages
  in the browser (`public/profixio.js`).
- Profixio doesn't allow cross-site requests (no CORS headers), so the page talks to Profixio through
  a small same-origin relay at `/proxy/*` (`proxy.js`). The relay only allows the handful of Profixio
  paths the app needs.
- In production, a single **Cloudflare Worker** (`worker.js`, `wrangler.jsonc`) serves `public/` and
  runs the relay, on Cloudflare's free plan.
- Locally, `server.js` does the same thing with Node, so no Cloudflare account is needed for development.

## Deploy

Live at **https://profixio-live.fubar.workers.dev**.

### Automatically, from GitHub

Every push to `main` deploys through GitHub Actions (`.github/workflows/deploy.yml`). You can also run
it by hand: Actions → "Deploy to Cloudflare" → Run workflow. It needs two repository secrets
(Settings → Secrets and variables → Actions):

- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account id (shown in the dashboard URL and on the Workers overview page).
- `CLOUDFLARE_API_TOKEN`: create it in the Cloudflare dashboard → My Profile → API Tokens → Create Token
  → template **"Edit Cloudflare Workers"**.

Without the token the workflow still builds, but skips the deploy with a warning.

### By hand, from your computer

```bash
npm install
npx wrangler login
npm run deploy
```

`wrangler login` opens the browser to authorize your Cloudflare account. `npm run deploy` builds the
CSS and deploys.

## Run locally

```bash
npm start
```

Open http://localhost:5173 (or `http://<computer's IP>:5173` from a tablet on the same Wi-Fi).
Other scripts:

- `npm run dev` restarts the server on file changes.
- `npm run watch:css` rebuilds the CSS while you edit styles.
- `npm run dev:worker` runs the real Worker locally with Wrangler.

## Pages

**Mina lag** (`team.html`): your teams and their matches. Reached from the footer on every page.
- **Mina lag**: favourite teams, stored on the device (localStorage). One team is selected at a time:
  tap a team to show its matches. A newly added team becomes the selected one. × removes a team (with
  a confirmation in the chip); removing the selected team selects the first remaining one.
- **+ Lägg till lag**: search by team id (e.g. `1584383`) and league id (default `28119`, remembered), or
  paste the team's Profixio link. The team's matches are shown with **☆ Lägg till** to add it to Mina lag
  (★ again removes it). Recent searches are listed in the search panel. `team.html?team=<id>&league=<id>`
  opens a team directly.
- Matches are listed as **Kommande** (live, today's and future), **Spelade** (history, latest first) or
  **Alla**, with club logos, a HEMMA/BORTA tag when one of your teams plays, and the competition when
  several teams are selected.
- Today's and tomorrow's matches are labelled "Idag" / "Imorgon", and the next match is highlighted.
- Today's matches get live score updates every 30 s (until they're finished). Tap a match to open it.

**Match** (`index.html?match=<id>`): rosters for both teams. Mobile-first:
- On a phone one team is shown at a time. A short swipe (about 30 px) in either direction swaps to
  the other team; you can also tap the other team's name
  in the header. From tablet width up, both teams are side by side.
- A fixed header stays on top: both team names (the team in view is highlighted), result, the match
  clock with the current half, running 2-minute suspensions and timeouts per team as countdowns
  (`#13 1:42`, `TIMEOUT 0:45`).
- Tap the clock to switch between total match time (2nd half continues from 25:00) and time within the
  half (2nd half restarts at 0:00). The choice is remembered.
- Players are always sorted by name, with shirt number, goals (Mål) and suspensions (Utv.). Rows are
  compact on phones so a whole team fits on one screen.
- In the list: while the match is on, the last goal scorer is highlighted green with a **MÅL** badge;
  yellow/red cards show as
  small cards after the name, and a suspended player's row turns red with a countdown.
- Under each scorer's name: one icon per goal in match order. White dot = goal, green 7 = 7-m goal,
  red struck-through 7 = missed 7-m (only when Profixio registered the shooter; misses without a
  player are ignored).
- The screen is kept awake while a match is open (Screen Wake Lock: Chrome/Android, iOS Safari 16.4+;
  needs HTTPS, which the deployed Worker has).
- Rows flash green when a player's stats change.
- Live updates (footer button, on/off):
  - **Websocket first:** the browser connects directly to Profixio's own live push (Reverb/Pusher,
    channel `emp.<matchId>`). Every event (goal, card, suspension, correction) triggers a refetch, so
    changes show within a second or two. Green dot.
  - **live-state as backup:** `/app/api/matches/live-state` (~1 KB) is polled every 5 s while the
    websocket is down (amber dot) and every 30 s while it's up; the roster is only refetched when its
    `sequence` changes.
  - The dot turns red if updates keep failing. When the match is finished the button shows **Slut** and
    everything stops. **Av** turns live updates off.
- The match clock uses Profixio's own server time, so it matches Profixio even if the tablet's clock is off.

The scraping depends on Profixio's page markup. If they change it, `public/profixio.js` is the place to fix.
