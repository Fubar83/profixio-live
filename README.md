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

**Hitta match** (`team.html`): enter a team id (e.g. `1584383`) and league id (default `28119`, remembered),
or paste the team's Profixio link.
- Shows the team's logo and age class, and lists matches as Kommande / Spelade / Alla, with club logos
  and a HEMMA/BORTA tag.
- Today's and tomorrow's matches are labelled "Idag" / "Imorgon", and the next match is highlighted.
- Today's matches get live score updates every 30 s (until they're finished).
- Recently used teams are shown as cards. Tap a match to open it.

**Match** (`index.html?match=<id>`): rosters for both teams. Mobile-first:
- On a phone one team is shown at a time. A short swipe (about 30 px) in either direction swaps to
  the other team; you can also tap the other team's name
  in the header. From tablet width up, both teams are side by side.
- A fixed header stays on top: result, both team names (the team in view is highlighted), match
  title and clock.
- Players are always sorted by name, with shirt number, goals (Mål) and suspensions (Utv.). Rows are
  compact on phones so a whole team fits on one screen.
- The screen is kept awake while a match is open (Screen Wake Lock: Chrome/Android, iOS Safari 16.4+;
  needs HTTPS, which the deployed Worker has).
- Rows flash green when a player's stats change.
- Auto-refresh is a single on/off button in the top bar: **Live** (green dot) refreshes every 30 s,
  **Av** is off. The dot turns red if refreshes keep failing. When the match is finished the button
  shows **Slut** and polling stops by itself. The match clock still ticks every second between refreshes.
- The match clock uses Profixio's own server time, so it matches Profixio even if the tablet's clock is off.

The scraping depends on Profixio's page markup. If they change it, `public/profixio.js` is the place to fix.
