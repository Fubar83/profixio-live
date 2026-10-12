import { loadTeam, loadLiveStates, ProfixioError } from './profixio.js';

const $ = (id) => document.getElementById(id);
const els = {
  searchSection: $('search-section'), form: $('team-form'), team: $('team-input'), league: $('league-input'),
  recent: $('recent'), cancel: $('cancel-search'),
  head: $('schedule-head'), logo: $('team-logo'), name: $('team-name'), competition: $('team-competition'),
  link: $('profixio-link'), change: $('change-team'), filters: $('filters'),
  message: $('message'), schedule: $('schedule'),
};

const DEFAULT_LEAGUE = '28119';
const MAX_RECENT = 8;
const LIVE_POLL_MS = 30_000;

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

const state = {
  data: null,
  filter: store.get('teamFilter', 'upcoming'),
  liveTimer: null,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => localIso(new Date());
const tomorrow = () => localIso(new Date(Date.now() + 86_400_000));

function setMessage(text, error = false) {
  els.message.textContent = text;
  els.message.classList.toggle('text-red-400', error);
  els.message.classList.toggle('text-slate-400', !error);
}

const logoImg = (src, size) => src
  ? `<img src="${esc(src)}" alt="" class="${size} shrink-0 rounded-lg bg-white object-contain p-0.5" loading="lazy">`
  : `<span class="${size} shrink-0 rounded-lg bg-slate-800"></span>`;

// Accepts a bare team id, or a pasted team link (which also carries the league id).
function readInputs() {
  const raw = els.team.value.trim();
  const fromUrl = raw.match(/leagueid(\d+)\/teams\/(\d+)/);
  if (fromUrl) return { league: fromUrl[1], team: fromUrl[2] };
  const team = raw.match(/^\d+$/)?.[0];
  const league = els.league.value.trim().replace(/^leagueid/, '') || DEFAULT_LEAGUE;
  return team && /^\d+$/.test(league) ? { league, team } : null;
}

function showSearch(show) {
  els.searchSection.hidden = !show;
  els.cancel.hidden = !state.data;
  if (show) els.team.focus();
}

// ---------- recent teams ----------

function remember(d) {
  const list = store.get('recentTeams', []).filter((r) => !(r.league === d.league && Number(r.team) === d.teamId));
  list.unshift({ league: d.league, team: String(d.teamId), name: d.name, logo: d.logo, competition: d.competition });
  store.set('recentTeams', list.slice(0, MAX_RECENT));
  renderRecent();
}

function renderRecent() {
  const list = store.get('recentTeams', []);
  els.recent.innerHTML = list.length
    ? `<h2 class="mb-3 text-sm font-bold tracking-wide text-slate-400 uppercase">Senaste lag</h2>
       <div class="grid gap-3 sm:grid-cols-2">${list.map((r) => `
         <button type="button" data-league="${esc(r.league)}" data-team="${esc(r.team)}"
           class="flex min-h-18 items-center gap-3 rounded-2xl bg-slate-900 p-3 text-left ring-1 ring-slate-800 transition hover:ring-home active:scale-[0.98]">
           ${logoImg(r.logo, 'size-11')}
           <span class="min-w-0">
             <span class="block truncate text-lg font-bold">${esc(r.name || `Lag ${r.team}`)}</span>
             <span class="block truncate text-sm text-slate-400">${esc(r.competition || `Liga ${r.league}`)}</span>
           </span>
         </button>`).join('')}</div>`
    : '';
}

els.recent.addEventListener('click', (e) => {
  const b = e.target.closest('[data-team]');
  if (b) load(b.dataset.league, b.dataset.team);
});

// ---------- loading ----------

async function load(league, team) {
  els.team.value = team;
  els.league.value = league;
  store.set('league', league);
  const url = new URL(location.href);
  url.searchParams.set('team', team);
  url.searchParams.set('league', league);
  history.replaceState(null, '', url);

  clearTimeout(state.liveTimer);
  setMessage('Hämtar matcher…');
  els.schedule.innerHTML = '';
  els.head.hidden = true;
  showSearch(false);
  try {
    state.data = await loadTeam(league, team);
    remember(state.data);
    setMessage(state.data.matches.length ? '' : 'Laget har inga matcher.');
    render();
    pollLive();
  } catch (err) {
    state.data = null;
    showSearch(true);
    setMessage(err instanceof ProfixioError && err.status === 404
      ? 'Hittade inget lag med det id:t i den ligan. Kontrollera liga-id.'
      : `Kunde inte hämta matcherna: ${err.message}`, true);
  }
}

// Today's matches (and anything already live) get score updates without reloading the page.
async function pollLive() {
  clearTimeout(state.liveTimer);
  const d = state.data;
  if (!d) return;
  const watch = d.matches.filter((m) => m.live || (m.isoDate === today() && !m.hasResult));
  if (!watch.length) return;
  try {
    const states = await loadLiveStates(watch.map((m) => m.id));
    if (d !== state.data) return;
    for (const m of watch) {
      const s = states[m.id];
      if (!s) continue;
      m.homeGoals = s.homegoals ?? s.gamestate?.currentScore?.homeGoals ?? m.homeGoals;
      m.awayGoals = s.awaygoals ?? s.gamestate?.currentScore?.awayGoals ?? m.awayGoals;
      m.hasResult = !!s.hasResult || !!s.gamestate?.finished;
      m.live = !!s.hasLivescore && !m.hasResult;
      m.period = s.gamestate?.period ?? null;
    }
    render();
  } catch { /* try again next round */ }
  state.liveTimer = setTimeout(pollLive, LIVE_POLL_MS);
}

// ---------- rendering ----------

function dayLabel(m) {
  if (m.isoDate === today()) return 'Idag';
  if (m.isoDate === tomorrow()) return 'Imorgon';
  return m.date || '';
}

function renderMatch(m, teamId, isNext) {
  const isHome = m.home.id === teamId;
  const hasScore = m.homeGoals != null && m.awayGoals != null;
  // One line per team (logo, name, goals) so long names fit on a phone.
  const line = (t, goals) => `
    <span class="flex items-center gap-2.5">
      ${logoImg(t.logo, 'size-7')}
      <span class="min-w-0 flex-1 truncate ${t.id === teamId ? 'font-extrabold text-slate-50' : 'font-medium text-slate-300'}">${esc(t.name)}</span>
      ${hasScore ? `<span class="w-8 shrink-0 text-right text-xl font-black tabular-nums ${m.live ? 'text-red-300' : ''}">${esc(goals)}</span>` : ''}
    </span>`;
  const badges = [
    m.live ? `<span class="flex items-center gap-1.5 rounded-full bg-red-500 px-2.5 py-0.5 text-xs font-black text-slate-950"><span class="size-2 animate-pulse rounded-full bg-slate-950"></span>LIVE${m.period ? ` · ${m.period}:a halvlek` : ''}</span>` : '',
    !m.live && isNext ? '<span class="rounded-full bg-away px-2.5 py-0.5 text-xs font-black text-slate-950">NÄSTA</span>' : '',
    `<span class="rounded-full px-2 py-0.5 text-xs font-bold ${isHome ? 'bg-home/15 text-home' : 'bg-slate-800 text-slate-400'}">${isHome ? 'HEMMA' : 'BORTA'}</span>`,
  ].join('');
  const ring = m.live ? 'ring-2 ring-red-500' : isNext ? 'ring-2 ring-away' : 'ring-1 ring-slate-800';

  return `<a class="mb-3 flex items-center gap-3 rounded-2xl bg-slate-900 p-3 transition hover:bg-slate-800 active:scale-[0.99] sm:gap-4 sm:p-4 ${ring}" href="index.html?match=${m.id}">
    <span class="w-14 shrink-0 self-start pt-0.5 text-xl font-bold tabular-nums sm:w-16 sm:text-2xl">${esc(m.time || '')}</span>
    <span class="min-w-0 flex-1 space-y-1.5 text-lg">
      ${line(m.home, m.homeGoals)}
      ${line(m.away, m.awayGoals)}
      <span class="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-sm text-slate-500">${badges}<span class="min-w-0 truncate">${esc([m.round, m.venue].filter(Boolean).join(' · '))}</span></span>
    </span>
    <svg class="size-6 shrink-0 text-slate-600" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7"/></svg>
  </a>`;
}

function render() {
  const d = state.data;
  if (!d) return;
  els.head.hidden = false;
  els.name.textContent = d.name || `Lag ${d.teamId}`;
  els.competition.textContent = d.competition || '';
  els.logo.innerHTML = logoImg(d.logo, 'size-12 sm:size-14');
  els.link.href = d.url;
  document.title = `${d.name || 'Lag'} – matcher`;
  for (const b of els.filters.querySelectorAll('[data-filter]')) b.classList.toggle('active', b.dataset.filter === state.filter);

  // "Upcoming" keeps all of today's matches, so a match doesn't jump away the moment it ends.
  const isUpcoming = (m) => !m.hasResult || m.live || m.isoDate === today();
  const nextId = d.matches.find((m) => !m.hasResult && !m.live)?.id;
  const shown = d.matches.filter((m) =>
    state.filter === 'all' ? true : state.filter === 'played' ? m.hasResult && !m.live : isUpcoming(m));
  const ordered = state.filter === 'played' ? [...shown].reverse() : shown; // latest result first

  if (!ordered.length) {
    els.schedule.innerHTML = `<div class="py-10 text-center text-lg text-slate-400">Inga ${state.filter === 'played' ? 'spelade' : 'kommande'} matcher.</div>`;
    return;
  }

  let html = '';
  let lastDate = null;
  for (const m of ordered) {
    if (m.date !== lastDate) {
      const isToday = m.isoDate === today();
      html += `<h2 class="mt-6 mb-2 text-sm font-bold tracking-wide uppercase ${isToday ? 'text-away' : 'text-slate-400'}">${esc(dayLabel(m))}${isToday || m.isoDate === tomorrow() ? ` <span class="font-normal normal-case text-slate-500">${esc(m.date)}</span>` : ''}</h2>`;
      lastDate = m.date;
    }
    html += renderMatch(m, d.teamId, m.id === nextId);
  }
  els.schedule.innerHTML = html;
}

// ---------- events ----------

els.filters.addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  state.filter = b.dataset.filter;
  store.set('teamFilter', state.filter);
  render();
});

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const ids = readInputs();
  if (!ids) return setMessage('Ange ett lag-id (siffror) eller klistra in länken till laget.', true);
  load(ids.league, ids.team);
});

els.change.addEventListener('click', () => showSearch(true));
els.cancel.addEventListener('click', () => showSearch(false));
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollLive(); });

// ---------- start ----------

renderRecent();
const params = new URL(location.href).searchParams;
els.league.value = params.get('league') || store.get('league', DEFAULT_LEAGUE);
if (params.get('team')) load(els.league.value, params.get('team'));
else showSearch(true);
