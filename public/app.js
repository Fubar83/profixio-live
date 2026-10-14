import { loadMatch as fetchMatch, loadLiveState, clockOffset } from './profixio.js';
import { connectMatch } from './realtime.js';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('match-form'), input: $('match-input'),
  pollToggle: $('poll-toggle'), pollLabel: $('poll-label'), dot: $('dot'), updatedText: $('updated-text'),
  controls: $('controls'), clockToggle: $('clock-toggle'), clock: $('clock'), period: $('period'),
  names: [$('home-name'), $('away-name')], chips: [$('home-chips'), $('away-chips')],
  homeGoals: $('home-goals'), awayGoals: $('away-goals'),
  message: $('message'), teams: $('teams'),
};

const store = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

// Updates: Profixio's websocket pushes every event (goal, card, suspension…) and triggers a
// refetch. live-state (~1 KB) is the backup: polled often while the socket is down, rarely
// while it's up, and the full roster is only refetched when its `sequence` changes.
const LIVE_STATE_MS_FALLBACK = 5_000;
const LIVE_STATE_MS_WITH_SOCKET = 30_000;
const EVENT_REFETCH_DELAY_MS = 400; // coalesce bursts of events into one refetch

const state = {
  matchId: null,
  data: null,
  sequence: null,
  clockOffset: 0, // Profixio server clock - device clock, seconds
  lastOk: 0,
  failing: false,
  loading: false,
  reloadQueued: false,
  refetchTimer: null,
  liveTimer: null,
  socket: null,
  socketStatus: 'off', // off | connecting | connected | disconnected
  polling: store.get('polling', '1') === '1',
  clockPerHalf: store.get('clockPerHalf', '0') === '1', // false: 2nd half continues from 25:00, true: restarts at 0:00
  prevStats: new Map(), // "team|number" -> stats joined, to flash rows that changed
  activeTeam: 0, // the team shown on small screens
};

// Full class strings (not built dynamically) so Tailwind picks them up.
const SIDES = [
  {
    key: 'home', border: 'border-home', text: 'text-home', pill: 'bg-home/15 text-home ring-home/30',
    active: 'bg-home/15 text-home ring-2 ring-home md:bg-transparent md:ring-0',
    inactive: 'text-slate-500 md:text-home',
  },
  {
    key: 'away', border: 'border-away', text: 'text-away', pill: 'bg-away/15 text-away ring-away/30',
    active: 'bg-away/15 text-away ring-2 ring-away md:bg-transparent md:ring-0',
    inactive: 'text-slate-500 md:text-away',
  },
];
const PANEL = 'self-start overflow-hidden rounded-2xl border-t-4 bg-slate-900 ring-1 ring-slate-800 md:rounded-3xl';
const SWIPE_MIN_PX = 30; // a short flick is enough to swap team
const SHORT_LABELS = { 'Bestr.': 'Utv.' };

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byName = (a, b) => a.name.localeCompare(b.name, 'sv');
const isFinished = () => !!state.data?.gamestate?.finished;
const nowServer = () => Date.now() / 1000 + state.clockOffset;
const mmss = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
// Countdowns always mm:ss so their width never changes.
const mmss2 = (secs) => `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
const playerKey = (side, number) => `${side}|${number}`;

// First name bright (that's what coaches call out), the rest dimmed but readable.
function nameHtml(name) {
  const [first, ...rest] = name.split(' ');
  return rest.length
    ? `${esc(first)} <span class="font-medium text-slate-400">${esc(rest.join(' '))}</span>`
    : esc(first);
}

function parseMatchId(text) {
  const t = text.trim();
  return t.match(/match\/(\d+)/)?.[1] ?? (/^\d+$/.test(t) ? t : null);
}

function setMessage(text, error = false) {
  els.message.textContent = text;
  els.message.classList.toggle('text-red-400', error);
  els.message.classList.toggle('text-slate-400', !error);
}

// ---------- clock & countdowns (same rules as Profixio's own match page) ----------

const periodLength = () => (state.data?.gamestate?.periodLength || state.data?.setup?.period_length || 30) * 60;

// Game clock each finished period ended on, read off the period-end events.
function periodEndSeconds(period) {
  const ended = state.data?.events?.find((e) => e.endsPeriod && e.period === period && e.periodEndSeconds != null);
  return ended ? ended.periodEndSeconds : periodLength();
}

// Seconds played in the current period, or null when there is no running clock.
function elapsedInPeriod() {
  const gs = state.data?.gamestate;
  if (!gs?.clock || !gs.periodStartTime) return null;
  if (gs.timerRunning === false) return gs.period != null ? periodEndSeconds(gs.period) : 0; // break between halves
  let elapsed = Math.floor((gs.periodPausedAt || nowServer()) - gs.periodStartTime) - (gs.addSeconds || 0);
  if (!state.data.setup?.allowExtraTime) elapsed = Math.min(elapsed, periodLength());
  return Math.max(0, elapsed);
}

function clockInfo() {
  const gs = state.data?.gamestate;
  if (!gs) return { clock: '', period: '' };
  if (gs.finished) return { clock: 'Slut', period: '' };
  const half = gs.period ? `${gs.period}:a halvlek` : '';
  if (!gs.clock || !gs.periodStartTime) return { clock: '–:––', period: gs.headerstate === 'NotStarted' || !gs.headerstate ? 'Ej startad' : half };
  if (gs.timerRunning === false) return { clock: 'Paus', period: half };
  const elapsed = elapsedInPeriod();
  const previous = state.clockPerHalf ? 0 : (gs.elapsedMinutesPreviousPeriods || 0) * 60;
  const countsUp = state.data.setup?.countsUp !== false;
  const running = !gs.periodPausedAt;
  let shown = countsUp ? elapsed + previous : periodLength() - elapsed;

  // A sync can land a second or two "behind" what is already on screen (rounding, network
  // delay). Don't step a running clock backwards for that; hold until real time catches up.
  // Larger differences are real corrections and are shown as-is.
  const last = state.lastClock;
  const same = last && last.period === gs.period && last.perHalf === state.clockPerHalf && last.countsUp === countsUp;
  if (running && same) {
    const behind = countsUp ? last.secs - shown : shown - last.secs;
    if (behind > 0 && behind <= 2) shown = last.secs;
  }
  state.lastClock = { period: gs.period, perHalf: state.clockPerHalf, countsUp, secs: shown };

  return { clock: mmss(shown), period: gs.periodPausedAt ? `${half} · stoppad` : half, running };
}

// A suspension's end is given on the clock of the period it was handed out in; one that runs
// over a break carries its balance into the next period.
function suspensionSecondsLeft(e) {
  const gs = state.data?.gamestate;
  if (e.isFullTimeExpulsion || e.penaltyServed || e.expulsionEndSeconds == null || gs?.period == null || e.period > gs.period) return 0;
  let end = e.expulsionEndSeconds;
  for (let p = e.period; p < gs.period; p++) end -= periodEndSeconds(p);
  const elapsed = elapsedInPeriod();
  return elapsed == null ? 0 : Math.max(0, end - elapsed);
}

function timeoutSecondsLeft(e) {
  const gs = state.data?.gamestate;
  if (e.timeoutEndsAt == null || (gs?.period != null && e.period !== gs.period)) return 0;
  return Math.max(0, Math.floor(e.timeoutEndsAt - nowServer()));
}

// Profixio's "7-m miss" event (a missed penalty throw). Only shown when it names the shooter.
const isPenaltyMiss = (e) => !e.isGoal && /7-?m/i.test(e.name || '') && /miss/i.test(e.name || '');

// Per-player facts from the event list: cards, suspensions, goals and 7-m throws in order, and
// who scored last. Events without a player (e.g. a 7-m miss with no shooter) are ignored.
function eventFacts() {
  const events = [...(state.data?.events ?? [])].sort((a, b) => a.id - b.id); // oldest first
  const players = new Map();
  const of = (e) => {
    const key = playerKey(e.side, e.playerNo);
    if (!players.has(key)) players.set(key, { yellow: 0, red: 0, suspensions: [], shots: [] });
    return players.get(key);
  };
  for (const e of events) {
    if (!e.playerNo || (e.side !== 'home' && e.side !== 'away')) continue;
    if (e.isYellow) of(e).yellow++;
    if (e.isRed || e.isFullTimeExpulsion) of(e).red++;
    if (e.cls === 'expulsion') of(e).suspensions.push(e);
    if (e.isGoal && !e.isShootoutRound) of(e).shots.push({ kind: e.isPenalty ? 'penaltyGoal' : 'goal', time: e.time });
    if (isPenaltyMiss(e)) of(e).shots.push({ kind: 'penaltyMiss', time: e.time });
  }
  const lastGoal = events.filter((e) => e.isGoal && !e.isShootoutRound).at(-1) ?? null;
  return { players, lastGoal };
}

// ---------- loading ----------

async function refresh() {
  if (!state.matchId) return;
  if (state.loading) { state.reloadQueued = true; return; }
  state.loading = true;
  const id = state.matchId;
  try {
    const body = await fetchMatch(id);
    if (id !== state.matchId) return; // user switched match mid-request
    state.data = body;
    if (body.sequence != null) state.sequence = body.sequence;
    state.lastOk = Date.now();
    state.failing = false;
    setMessage(body.teams.length ? '' : 'Hittade inga laguppställningar för den här matchen ännu.');
    render();
  } catch (err) {
    state.failing = true;
    if (!state.data) setMessage(`Kunde inte hämta matchen: ${err.message}`, true);
  } finally {
    state.loading = false;
    if (id === state.matchId) {
      updateLive();
      renderPoll();
      if (state.reloadQueued) { state.reloadQueued = false; refresh(); }
    }
  }
}

// Start/stop the websocket and the live-state backup to match the toggle and match state.
function updateLive() {
  const wanted = state.polling && state.data && !isFinished();
  if (!wanted) {
    state.socket?.close();
    state.socket = null;
    clearTimeout(state.liveTimer);
    return;
  }
  if (!state.socket && state.data.realtime) {
    const id = state.matchId;
    state.socket = connectMatch(state.data.realtime, id, {
      onEvent: (_name, payload) => {
        if (id !== state.matchId) return;
        // Show the new score at once; the refetch brings rosters, cards and clock.
        if (payload?.gamestate?.currentScore && state.data) {
          state.data.gamestate = { ...state.data.gamestate, currentScore: payload.gamestate.currentScore };
          renderScore();
        }
        clearTimeout(state.refetchTimer);
        state.refetchTimer = setTimeout(refresh, EVENT_REFETCH_DELAY_MS);
      },
      onStatus: (s) => {
        const wasUp = state.socketStatus === 'connected';
        state.socketStatus = s;
        renderPoll();
        if (s === 'connected' && !wasUp) refresh(); // catch up on anything missed while down
        if (s !== 'connected') scheduleLiveState(); // fall back to frequent live-state polling
      },
    });
  }
  scheduleLiveState();
}

function scheduleLiveState() {
  clearTimeout(state.liveTimer);
  if (!state.polling || !state.data || isFinished()) return;
  const delay = state.socketStatus === 'connected' ? LIVE_STATE_MS_WITH_SOCKET : LIVE_STATE_MS_FALLBACK;
  state.liveTimer = setTimeout(checkLiveState, delay);
}

async function checkLiveState() {
  const id = state.matchId;
  try {
    const live = await loadLiveState(id);
    if (id !== state.matchId || !live) return;
    state.lastOk = Date.now();
    state.failing = false;
    if (live.sequence != null && live.sequence !== state.sequence) {
      state.sequence = live.sequence;
      return refresh(); // something happened: fetch rosters and events
    }
    if (live.gamestate && state.data) {
      state.data.gamestate = { ...state.data.gamestate, ...live.gamestate };
      renderScore();
    }
  } catch {
    state.failing = true;
  } finally {
    renderPoll();
    if (id === state.matchId) scheduleLiveState();
  }
}

function loadMatch(id) {
  state.socket?.close();
  state.socket = null;
  state.socketStatus = 'off';
  clearTimeout(state.liveTimer);
  clearTimeout(state.refetchTimer);
  Object.assign(state, { matchId: id, data: null, sequence: null, lastOk: 0, activeTeam: 0 });
  state.prevStats.clear();
  els.teams.innerHTML = '';
  els.controls.hidden = true;
  els.form.hidden = true;
  setMessage('Laddar…');
  const url = new URL(location.href);
  url.searchParams.set('match', id);
  history.replaceState(null, '', url);
  store.set('match', id);
  refresh();
  keepAwake();
}

// ---------- rendering ----------

// One small icon per goal / penalty goal / missed penalty, in match order.
const SHOT_ICONS = {
  goal: (t) => `<span class="inline-block size-2.5 rounded-full bg-slate-200 md:size-3" title="Mål ${t}"></span>`,
  penaltyGoal: (t) => `<span class="inline-flex size-3.5 items-center justify-center rounded-full bg-green-500 text-[9px] leading-none font-black text-slate-950 md:size-4 md:text-[10px]" title="Mål 7-m ${t}">7</span>`,
  penaltyMiss: (t) => `<span class="inline-flex size-3.5 items-center justify-center rounded-full text-[9px] leading-none font-black text-red-400 line-through ring-1 ring-red-500 md:size-4 md:text-[10px]" title="7-m miss ${t}">7</span>`,
};
function shotIcons(f) {
  if (!f?.shots.length) return '';
  return `<span class="mt-0.5 flex flex-wrap items-center gap-0.5 md:mt-1 md:gap-1">${f.shots.map((s) => SHOT_ICONS[s.kind](esc(s.time))).join('')}</span>`;
}

function cardIcons(f) {
  if (!f) return '';
  const card = (cls, title) => `<span class="ml-1 inline-block h-3.5 w-2.5 rounded-[2px] align-[-1px] ${cls}" title="${title}"></span>`;
  return card('bg-yellow-400', 'Gult kort').repeat(f.yellow) + card('bg-red-500', 'Rött kort').repeat(f.red);
}

function renderTeam(panel, team, c, facts) {
  // Activated (marked present) players, when Profixio's live snapshot says so; otherwise null.
  const activated = state.data.activated ? new Set(state.data.activated[c.key]) : null;
  const rows = [...team.players].sort(byName).map((p) => {
    const key = `${team.name}|${p.number}`;
    const sig = p.stats.join('/');
    const prev = state.prevStats.get(key);
    state.prevStats.set(key, sig);
    const flash = prev !== undefined && prev !== sig;

    const f = facts.players.get(playerKey(c.key, p.number));
    const suspension = f?.suspensions.find((e) => suspensionSecondsLeft(e) > 0);
    // Last-goal highlight only while the match is on; once it's over it's no longer useful.
    const lastScorer = !isFinished() && facts.lastGoal && facts.lastGoal.side === c.key && facts.lastGoal.playerNo === p.number;

    const stats = p.stats.map((v) =>
      `<span class="w-9 shrink-0 text-center text-lg font-bold tabular-nums md:w-11 md:text-2xl lg:w-14 ${v ? 'text-slate-100' : 'text-slate-700'}">${esc(v || '0')}</span>`).join('');
    const tags = p.tags.map((t) =>
      `<span class="ml-1.5 rounded bg-slate-800 px-1 py-px align-middle text-[10px] font-bold text-slate-400 md:ml-2 md:rounded-md md:px-1.5 md:py-0.5 md:text-xs">${esc(t)}</span>`).join('');
    const timer = suspension
      ? `<span data-suspension="${suspension.id}" class="ml-1.5 rounded bg-red-500 px-1.5 py-px align-middle text-xs font-black tabular-nums text-slate-950">${fixedTime(mmss2(suspensionSecondsLeft(suspension)))}</span>`
      : '';
    const goalBadge = lastScorer
      ? '<span class="ml-1.5 rounded bg-green-500 px-1 py-px align-middle text-[10px] font-black text-slate-950" title="Senaste mål">MÅL</span>'
      : '';
    const inactive = activated && !activated.has(p.number);
    const rowTone = suspension ? 'bg-red-500/10' : lastScorer ? 'bg-green-500/10' : '';
    const pill = inactive ? 'bg-transparent text-slate-500 ring-slate-700' : `${c.pill} ${lastScorer ? 'ring-2 ring-green-400' : ''}`;

    return `<li class="flex items-center gap-2 border-t border-slate-800 px-2.5 py-1 md:min-h-16 md:px-3 md:py-2 ${rowTone} ${inactive ? 'opacity-40 grayscale' : ''} ${flash ? 'animate-flash' : ''}"${inactive ? ' title="Inte aktiverad i matchen"' : ''}>
      <span class="flex h-8 w-10 shrink-0 items-center justify-center rounded-lg text-xl font-black tabular-nums ring-1 md:h-12 md:w-14 md:rounded-xl md:text-3xl ${pill}">${esc(p.number)}</span>
      <span class="min-w-0 flex-1 text-base leading-tight font-semibold md:text-lg lg:text-xl ${suspension ? 'opacity-70' : ''}">${nameHtml(p.name)}${tags}${cardIcons(f)}${goalBadge}${timer}${shotIcons(f)}</span>
      ${stats}
    </li>`;
  }).join('');

  const head = team.columns.map((col) =>
    `<span class="w-9 shrink-0 text-center md:w-11 lg:w-14" title="${esc(col)}">${esc(SHORT_LABELS[col] || col)}</span>`).join('');
  const staff = team.staff.length
    ? `<div class="border-t border-slate-800 px-3 py-2 text-xs text-slate-400 md:px-4 md:py-3 md:text-sm">${team.staff.map((s) =>
        `<span class="mr-3 whitespace-nowrap"><b class="text-slate-200">${esc(s.number)}</b> ${esc(s.name)}${cardIcons(facts.players.get(playerKey(c.key, s.number)))}</span>`).join('')}</div>`
    : '';

  panel.innerHTML = `
    <h2 class="flex items-center justify-between px-3 pt-2 pb-1 md:px-4 md:pt-3 md:pb-2">
      <span class="truncate text-lg font-bold md:text-xl ${c.text}">${esc(team.name)}</span>
      <span class="shrink-0 text-xs text-slate-500 md:text-sm">${activated
        ? `${team.players.filter((p) => activated.has(p.number)).length}/${team.players.length} aktiverade`
        : `${team.players.length} spelare`}</span>
    </h2>
    <div class="flex items-center gap-2 px-2.5 pb-1 text-[10px] font-semibold tracking-wide text-slate-500 uppercase md:px-3 md:text-xs">
      <span class="w-10 text-center md:w-14">#</span><span class="flex-1">Namn</span>${head}
    </div>
    <ul>${rows}</ul>
    ${staff}`;
}

// The panels are created once per match and only their contents re-rendered, so a refresh
// doesn't restart the swap animation. Below md only the active team's panel is shown.
function panels(count) {
  if (els.teams.children.length !== count) {
    els.teams.innerHTML = '';
    for (let i = 0; i < count; i++) els.teams.append(document.createElement('section'));
    updatePanels();
  }
  return [...els.teams.children];
}

function updatePanels(enterFrom = null) {
  [...els.teams.children].forEach((section, i) => {
    const active = i === state.activeTeam;
    const anim = active && enterFrom ? (enterFrom === 'right' ? 'max-md:animate-from-right' : 'max-md:animate-from-left') : '';
    section.className = `${PANEL} ${SIDES[i % 2].border} ${active ? '' : 'max-md:hidden'} ${anim}`;
  });
}

// Team names in the fixed header. On small screens the team in view is highlighted (the other
// is dimmed and tapping it swaps over); from md both teams are visible, so both stay coloured.
function renderNames(teams) {
  els.names.forEach((btn, i) => {
    const t = teams[i];
    btn.hidden = !t;
    if (!t) return;
    const active = i === state.activeTeam;
    btn.className = `min-w-0 rounded-xl px-2 py-1.5 text-base leading-tight font-bold transition md:text-2xl ${i === 0 ? 'text-right' : 'text-left'} ${active ? SIDES[i].active : SIDES[i].inactive}`;
    btn.setAttribute('aria-pressed', String(active));
    btn.innerHTML = `<span class="line-clamp-2">${esc(t.name)}</span>`;
  });
}

function renderScore() {
  const d = state.data;
  if (!d) return;
  const [home, away] = d.teams;
  const hg = d.gamestate?.currentScore?.homeGoals ?? 0;
  const ag = d.gamestate?.currentScore?.awayGoals ?? 0;
  els.homeGoals.textContent = hg;
  els.awayGoals.textContent = ag;
  document.title = home && away ? `${home.name} ${hg}–${ag} ${away.name}` : 'Profixio Live';
  tick();
}

// Running suspensions and timeouts under each team's name in the header.
function renderChips() {
  const events = state.data?.events ?? [];
  SIDES.forEach((side, i) => {
    const suspensions = events.filter((e) => e.side === side.key && e.cls === 'expulsion' && suspensionSecondsLeft(e) > 0);
    const timeouts = events.filter((e) => e.side === side.key && e.cls === 'timeout' && timeoutSecondsLeft(e) > 0);
    els.chips[i].innerHTML =
      suspensions.map((e) => `<span class="rounded-md bg-red-500 px-1.5 py-0.5 text-xs font-black tabular-nums text-slate-950">#${esc(e.playerNo ?? '?')} <span data-suspension="${e.id}">${fixedTime(mmss2(suspensionSecondsLeft(e)))}</span></span>`).join('') +
      timeouts.map((e) => `<span class="rounded-md bg-sky-400 px-1.5 py-0.5 text-xs font-black tabular-nums text-slate-950">TIMEOUT <span data-timeout="${e.id}">${fixedTime(mmss2(timeoutSecondsLeft(e)))}</span></span>`).join('');
  });
}

function render() {
  const d = state.data;
  if (!d) return;
  els.controls.hidden = !d.teams.length;
  const facts = eventFacts();
  const sections = panels(d.teams.length);
  d.teams.forEach((t, i) => renderTeam(sections[i], t, SIDES[i % 2], facts));
  renderNames(d.teams);
  renderChips();
  renderScore();
}

// Status button in the footer: green = live push, amber = backup polling only, red = failing.
function renderPoll() {
  const finished = isFinished();
  const on = state.polling && !finished;
  const pushing = on && state.socketStatus === 'connected';
  els.pollLabel.textContent = finished ? 'Slut' : on ? 'Live' : 'Av';
  els.pollToggle.setAttribute('aria-pressed', String(on));
  els.pollToggle.title = finished ? 'Matchen är slut – ingen automatisk uppdatering'
    : pushing ? 'Direktuppdatering från Profixio – tryck för att stänga av'
    : on ? 'Uppdaterar var 5:e sekund (direktuppdatering ej ansluten) – tryck för att stänga av'
    : 'Automatisk uppdatering av – tryck för att slå på';
  const dot = !on ? 'bg-slate-500' : state.failing ? 'bg-red-500' : pushing ? 'bg-green-500 animate-pulse' : 'bg-amber-400 animate-pulse';
  els.dot.className = `size-2 rounded-full ${dot}`;
}

// Every second: match clock, countdowns, "updated x s ago". Re-renders when a countdown ends.
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

// Clock text with every character in its own fixed-width box, so it can't shift sideways as the
// digits change, whatever font the device uses ("Slut"/"Paus" are left as plain text).
function fixedTime(text) {
  if (!/^\d/.test(text)) return esc(text);
  return [...text].map((ch) => /\d/.test(ch)
    ? `<span class="inline-block w-[0.62em] text-center">${ch}</span>`
    : `<span class="inline-block w-[0.32em] text-center">${esc(ch)}</span>`).join('');
}
const setTime = (el, text) => {
  if (el.dataset.t === text) return;
  el.dataset.t = text;
  el.innerHTML = fixedTime(text);
};

function tick() {
  const { clock, period, running } = clockInfo();
  setTime(els.clock, clock);
  setText(els.period, period);
  els.clock.classList.toggle('text-slate-50', !!running);
  els.clock.classList.toggle('text-slate-400', !running);

  const events = state.data?.events ?? [];
  let expired = false;
  for (const el of document.querySelectorAll('[data-suspension]')) {
    const e = events.find((x) => String(x.id) === el.dataset.suspension);
    const left = e ? suspensionSecondsLeft(e) : 0;
    if (left <= 0) expired = true;
    setTime(el, mmss2(left));
  }
  for (const el of document.querySelectorAll('[data-timeout]')) {
    const e = events.find((x) => String(x.id) === el.dataset.timeout);
    const left = e ? timeoutSecondsLeft(e) : 0;
    if (left <= 0) expired = true;
    setTime(el, mmss2(left));
  }
  if (expired) render();

  if (state.lastOk) {
    const ago = Math.round((Date.now() - state.lastOk) / 1000);
    setText(els.updatedText, state.failing ? `Fel – senast ${ago} s sedan` : `${ago} s sedan`);
  }
}
// Tick right after each whole second on Profixio's clock, so the display changes exactly when
// the second changes (a free-running 1 s interval drifts against it and makes the clock stutter).
function scheduleTick() {
  const msIntoSecond = (nowServer() * 1000) % 1000;
  setTimeout(() => { tick(); scheduleTick(); }, 1000 - msIntoSecond + 15);
}
scheduleTick();

// ---------- events ----------

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = parseMatchId(els.input.value);
  if (!id) return setMessage('Kunde inte hitta ett match-id i texten.', true);
  els.input.blur();
  loadMatch(id);
});

// enterFrom: which side the new panel slides in from ('left' | 'right'), for a little motion cue.
function showTeam(i, enterFrom = i > state.activeTeam ? 'right' : 'left') {
  if (i === state.activeTeam || !state.data) return;
  state.activeTeam = i;
  updatePanels(enterFrom);
  renderNames(state.data.teams);
  window.scrollTo({ top: 0 });
}

for (const btn of els.names) btn.addEventListener('click', () => showTeam(Number(btn.dataset.team)));

els.clockToggle.addEventListener('click', () => {
  state.clockPerHalf = !state.clockPerHalf;
  store.set('clockPerHalf', state.clockPerHalf ? '1' : '0');
  tick();
});

// Any short horizontal swipe swaps to the other team, whichever way it goes.
// touch-pan-y on #teams leaves vertical scrolling to the browser and hands horizontal moves to us.
const swipe = { x: 0, y: 0, active: false };
els.teams.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  Object.assign(swipe, { x: e.clientX, y: e.clientY, active: true });
});
els.teams.addEventListener('pointercancel', () => { swipe.active = false; });
els.teams.addEventListener('pointerup', (e) => {
  if (!swipe.active) return;
  swipe.active = false;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  const teams = state.data?.teams.length ?? 0;
  if (teams < 2 || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) return;
  if (matchMedia('(min-width: 48rem)').matches) return; // both teams already visible
  showTeam((state.activeTeam + 1) % teams, dx < 0 ? 'right' : 'left');
});

els.pollToggle.addEventListener('click', () => {
  state.polling = !state.polling;
  store.set('polling', state.polling ? '1' : '0');
  if (state.polling) refresh(); // fetch now, then reconnect live updates
  else updateLive();
  renderPoll();
});

// Keep the screen on while a match is open (Screen Wake Lock; needs HTTPS or localhost).
// The browser drops the lock whenever the page is hidden, so it's requested again on return,
// and on the first tap for browsers that only grant it after user interaction.
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.hidden || !state.matchId || (wakeLock && !wakeLock.released)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not allowed right now (e.g. battery saver); try again on next tap/visibility change */ }
}
document.addEventListener('pointerdown', keepAwake, { passive: true });

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.matchId) return;
  if (state.polling && !isFinished()) {
    state.socket?.ensure(); // the socket may have died while the phone was locked
    refresh();
  }
  keepAwake();
});

// ---------- start ----------

clockOffset().then((offset) => { state.clockOffset = offset; tick(); });

const initial = new URL(location.href).searchParams.get('match') || store.get('match', null);
if (initial) {
  els.input.value = `https://www.profixio.com/app/lx/match/${initial}`;
  loadMatch(initial);
} else {
  els.form.hidden = false;
}
