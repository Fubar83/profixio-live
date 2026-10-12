import { loadMatch as fetchMatch, clockOffset } from './profixio.js';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('match-form'), input: $('match-input'),
  pollToggle: $('poll-toggle'), pollLabel: $('poll-label'), dot: $('dot'), updatedText: $('updated-text'),
  controls: $('controls'), title: $('title'), clock: $('clock'),
  names: [$('home-name'), $('away-name')], homeGoals: $('home-goals'), awayGoals: $('away-goals'),
  message: $('message'), teams: $('teams'),
};

const store = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

const POLL_MS = 30_000;

const state = {
  matchId: null,
  data: null,
  clockOffset: 0, // Profixio server clock - device clock, seconds
  lastOk: 0,
  failing: false,
  timer: null,
  polling: store.get('polling', '1') === '1', // auto-refresh every POLL_MS
  prevStats: new Map(), // "team|number" -> stats joined, to flash rows that changed
  activeTeam: 0, // the team shown in the swipe carousel on small screens
};

// Full class strings (not built dynamically) so Tailwind picks them up.
const SIDES = [
  {
    border: 'border-home', text: 'text-home', pill: 'bg-home/15 text-home ring-home/30',
    active: 'bg-home/15 text-home ring-2 ring-home md:bg-transparent md:ring-0',
    inactive: 'text-slate-500 md:text-home',
  },
  {
    border: 'border-away', text: 'text-away', pill: 'bg-away/15 text-away ring-away/30',
    active: 'bg-away/15 text-away ring-2 ring-away md:bg-transparent md:ring-0',
    inactive: 'text-slate-500 md:text-away',
  },
];
const PANEL = 'self-start overflow-hidden rounded-2xl border-t-4 bg-slate-900 ring-1 ring-slate-800 md:rounded-3xl';
const SWIPE_MIN_PX = 30; // a short flick is enough to swap team
const SHORT_LABELS = { 'Bestr.': 'Utv.' };

// ---------- helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byName = (a, b) => a.name.localeCompare(b.name, 'sv');

// First name bright (that's what coaches call out), the rest dimmed but readable.
function nameHtml(name) {
  const [first, ...rest] = name.split(' ');
  return rest.length
    ? `${esc(first)} <span class="font-medium text-slate-400">${esc(rest.join(' '))}</span>`
    : esc(first);
}
const isFinished = () => !!state.data?.gamestate?.finished;

function parseMatchId(text) {
  const t = text.trim();
  return t.match(/match\/(\d+)/)?.[1] ?? (/^\d+$/.test(t) ? t : null);
}

function setMessage(text, error = false) {
  els.message.textContent = text;
  els.message.classList.toggle('text-red-400', error);
  els.message.classList.toggle('text-slate-400', !error);
}

// ---------- loading ----------

async function refresh() {
  clearTimeout(state.timer);
  if (!state.matchId) return;
  const id = state.matchId;
  try {
    const body = await fetchMatch(id);
    if (id !== state.matchId) return; // user switched match mid-request
    state.data = body;
    state.lastOk = Date.now();
    state.failing = false;
    setMessage(body.teams.length ? '' : 'Hittade inga laguppställningar för den här matchen ännu.');
    render();
  } catch (err) {
    state.failing = true;
    if (!state.data) setMessage(`Kunde inte hämta matchen: ${err.message}`, true);
    tick();
  } finally {
    // A finished match won't change any more, so polling stops by itself.
    if (state.polling && !isFinished() && id === state.matchId) state.timer = setTimeout(refresh, POLL_MS);
    renderPoll();
  }
}

function loadMatch(id) {
  state.matchId = id;
  state.data = null;
  state.lastOk = 0;
  state.activeTeam = 0;
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

function renderTeam(panel, team, c) {
  const rows = [...team.players].sort(byName).map((p) => {
    const key = `${team.name}|${p.number}`;
    const sig = p.stats.join('/');
    const prev = state.prevStats.get(key);
    state.prevStats.set(key, sig);
    const flash = prev !== undefined && prev !== sig;
    const stats = p.stats.map((v) =>
      `<span class="w-9 shrink-0 text-center text-lg font-bold tabular-nums md:w-11 md:text-2xl lg:w-14 ${v ? 'text-slate-100' : 'text-slate-700'}">${esc(v || '0')}</span>`).join('');
    const tags = p.tags.map((t) =>
      `<span class="ml-1.5 rounded bg-slate-800 px-1 py-px align-middle text-[10px] font-bold text-slate-400 md:ml-2 md:rounded-md md:px-1.5 md:py-0.5 md:text-xs">${esc(t)}</span>`).join('');
    return `<li class="flex items-center gap-2 border-t border-slate-800 px-2.5 py-1 md:min-h-16 md:px-3 md:py-2 ${flash ? 'animate-flash' : ''}">
      <span class="flex h-8 w-10 shrink-0 items-center justify-center rounded-lg text-xl font-black tabular-nums ring-1 md:h-12 md:w-14 md:rounded-xl md:text-3xl ${c.pill}">${esc(p.number)}</span>
      <span class="min-w-0 flex-1 text-base leading-tight font-semibold md:text-lg lg:text-xl">${nameHtml(p.name)}${tags}</span>
      ${stats}
    </li>`;
  }).join('');

  const head = team.columns.map((col) =>
    `<span class="w-9 shrink-0 text-center md:w-11 lg:w-14" title="${esc(col)}">${esc(SHORT_LABELS[col] || col)}</span>`).join('');
  const staff = team.staff.length
    ? `<div class="border-t border-slate-800 px-3 py-2 text-xs text-slate-400 md:px-4 md:py-3 md:text-sm">${team.staff.map((s) =>
        `<span class="mr-3 whitespace-nowrap"><b class="text-slate-200">${esc(s.number)}</b> ${esc(s.name)}</span>`).join('')}</div>`
    : '';

  panel.innerHTML = `
    <h2 class="flex items-center justify-between px-3 pt-2 pb-1 md:px-4 md:pt-3 md:pb-2">
      <span class="truncate text-lg font-bold md:text-xl ${c.text}">${esc(team.name)}</span>
      <span class="shrink-0 text-xs text-slate-500 md:text-sm">${team.players.length} spelare</span>
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
    for (let i = 0; i < count; i++) {
      const section = document.createElement('section');
      els.teams.append(section);
    }
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
// is dimmed and tapping it swipes over); from md both teams are visible, so both stay coloured.
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

// enterFrom: which side the new panel slides in from ('left' | 'right'), for a little motion cue.
function showTeam(i, enterFrom = i > state.activeTeam ? 'right' : 'left') {
  if (i === state.activeTeam || !state.data) return;
  state.activeTeam = i;
  updatePanels(enterFrom);
  renderNames(state.data.teams);
  window.scrollTo({ top: 0 });
}

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

function render() {
  const d = state.data;
  if (!d) return;
  const [home, away] = d.teams;
  const gs = d.gamestate || {};
  const hg = gs.currentScore?.homeGoals ?? 0;
  const ag = gs.currentScore?.awayGoals ?? 0;

  els.controls.hidden = !d.teams.length;
  els.title.textContent = [d.title, d.kickoff].filter(Boolean).join(' · ');
  els.homeGoals.textContent = hg;
  els.awayGoals.textContent = ag;
  document.title = home && away ? `${home.name} ${hg}–${ag} ${away.name}` : 'Profixio Live';

  const sections = panels(d.teams.length);
  d.teams.forEach((t, i) => renderTeam(sections[i], t, SIDES[i % 2]));
  renderNames(d.teams);
  tick();
}

function renderPoll() {
  const finished = isFinished();
  const on = state.polling && !finished;
  const stale = on && (state.failing || (state.lastOk && Date.now() - state.lastOk > POLL_MS * 2 + 15_000));
  els.pollLabel.textContent = finished ? 'Slut' : on ? 'Live' : 'Av';
  els.pollToggle.setAttribute('aria-pressed', String(on));
  els.pollToggle.title = finished
    ? 'Matchen är slut – ingen automatisk uppdatering'
    : on ? 'Uppdaterar var 30:e sekund – tryck för att stänga av' : 'Automatisk uppdatering av – tryck för att slå på';
  els.dot.className = `size-2 rounded-full ${stale ? 'bg-red-500' : on ? 'bg-green-500 animate-pulse' : 'bg-slate-500'}`;
}

// Same rules as Profixio's own match clock (matchStore.js calculateMatchTime).
function clockText() {
  const d = state.data;
  const gs = d?.gamestate;
  if (!gs) return { text: '' };
  if (gs.finished) return { text: 'Slut' };
  if (!gs.clock || !gs.periodStartTime) return { text: gs.headerstate === 'NotStarted' || !gs.headerstate ? 'Ej startad' : gs.headerstate };
  if (gs.timerRunning === false) return { text: `Paus · halvlek ${gs.period ?? ''}`.trim() };

  const periodLen = (gs.periodLength || d.setup?.period_length || 30) * 60;
  const now = Date.now() / 1000 + state.clockOffset;
  let elapsed = Math.floor((gs.periodPausedAt || now) - gs.periodStartTime) - (gs.addSeconds || 0);
  if (!d.setup?.allowExtraTime) elapsed = Math.min(elapsed, periodLen);
  elapsed = Math.max(0, elapsed);
  const shown = d.setup?.countsUp === false ? periodLen - elapsed : elapsed + (gs.elapsedMinutesPreviousPeriods || 0) * 60;
  const mm = Math.floor(shown / 60);
  const ss = String(shown % 60).padStart(2, '0');
  return { text: `${mm}:${ss}${gs.periodPausedAt ? ' (stoppad)' : ''} · halvlek ${gs.period ?? ''}`, running: !gs.periodPausedAt };
}

function tick() {
  const { text, running } = clockText();
  els.clock.textContent = text;
  els.clock.classList.toggle('text-slate-100', !!running);
  els.clock.classList.toggle('text-slate-400', !running);

  if (!state.lastOk) return;
  const ago = Math.round((Date.now() - state.lastOk) / 1000);
  els.updatedText.textContent = state.failing ? `Fel – senast ${ago} s sedan` : `${ago} s sedan`;
  renderPoll();
}
setInterval(tick, 1000);

// ---------- events ----------

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = parseMatchId(els.input.value);
  if (!id) return setMessage('Kunde inte hitta ett match-id i texten.', true);
  els.input.blur();
  loadMatch(id);
});


for (const btn of els.names) btn.addEventListener('click', () => showTeam(Number(btn.dataset.team)));

els.pollToggle.addEventListener('click', () => {
  state.polling = !state.polling;
  store.set('polling', state.polling ? '1' : '0');
  if (state.polling) refresh(); // fetch now; schedules the next one unless the match is over
  else clearTimeout(state.timer);
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
  if (state.polling && !isFinished()) refresh(); // catch up after the phone was locked/backgrounded
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
