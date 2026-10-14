import { loadTeam, loadLiveStates, ProfixioError } from './profixio.js';

const $ = (id) => document.getElementById(id);
const els = {
  favList: $('fav-list'), addTeam: $('add-team'),
  searchSection: $('search-section'), form: $('team-form'), team: $('team-input'), league: $('league-input'),
  recent: $('recent'), cancel: $('cancel-search'),
  teamHead: $('team-head'), logo: $('team-logo'), name: $('team-name'), competition: $('team-competition'), star: $('star-team'),
  filters: $('filters'), back: $('back-to-favorites'), link: $('profixio-link'),
  message: $('message'), schedule: $('schedule'),
};

const DEFAULT_LEAGUE = '28119';
const MAX_RECENT = 8;
const LIVE_POLL_MS = 30_000;
const TEAM_CACHE_MS = 2 * 60_000; // schedules barely change; avoid refetching on every toggle

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

// Favourite teams live in localStorage: [{ league, team, name, logo, competition }] plus the one
// selected team whose matches are listed. Keys are "league/team". Exactly one team is selected
// whenever there are favourites: the stored one if it still exists, otherwise the first.
const favKey = (f) => `${f.league}/${f.team}`;
const favs = {
  list: () => store.get('favoriteTeams', []),
  selectedKey() {
    const list = favs.list();
    const stored = store.get('selectedTeams', []); // kept as an array for older saved data
    return stored.find((k) => list.some((f) => favKey(f) === k)) ?? (list[0] ? favKey(list[0]) : null);
  },
  selected: () => new Set([favs.selectedKey()].filter(Boolean)),
  has: (league, team) => favs.list().some((f) => f.league === String(league) && f.team === String(team)),
  select: (key) => store.set('selectedTeams', [key]),
  add(t) {
    const entry = { league: String(t.league), team: String(t.teamId), name: t.name, logo: t.logo, competition: t.competition };
    store.set('favoriteTeams', [...favs.list().filter((f) => favKey(f) !== favKey(entry)), entry]);
    favs.select(favKey(entry)); // a newly added team becomes the selected one
  },
  remove(key) {
    store.set('favoriteTeams', favs.list().filter((f) => favKey(f) !== key));
    if (store.get('selectedTeams', []).includes(key)) store.set('selectedTeams', []); // falls back to the first
  },
};

const state = {
  view: 'favorites', // 'favorites' (merged list of selected favourites) | 'team' (one searched team)
  team: null, // the searched team's data in 'team' view
  matches: [], // what's listed
  teamIds: new Set(), // the teams the list is about (bolded, HEMMA/BORTA)
  competitions: new Map(), // teamId -> competition name, for the merged list
  filter: store.get('teamFilter', 'upcoming'),
  liveTimer: null,
  loadId: 0,
};

const cache = new Map(); // "league/team" -> { at, promise }
function cachedTeam(league, team) {
  const key = `${league}/${team}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TEAM_CACHE_MS) return hit.promise;
  const promise = loadTeam(league, team);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

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

function setUrl(params) {
  const url = new URL(location.href);
  url.search = '';
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  history.replaceState(null, '', url);
}

// ---------- favourites ----------

// The chip whose × was tapped shows an inline "Ta bort?" confirmation instead of a browser
// dialog (confirm() is blocked in some embedded browsers and home-screen apps).
let confirmingRemove = null;

function renderFavorites() {
  const list = favs.list();
  const selected = favs.selected();
  els.favList.innerHTML = list.length
    ? list.map((f) => {
      const key = esc(favKey(f));
      if (favKey(f) === confirmingRemove) {
        return `<span class="flex h-12 items-center gap-1.5 rounded-full bg-red-500/15 pr-1 pl-3 ring-2 ring-red-500">
          <span class="max-w-40 truncate text-sm font-semibold">Ta bort ${esc(f.name || `lag ${f.team}`)}?</span>
          <button type="button" data-confirm-remove="${key}" class="h-9 rounded-full bg-red-500 px-3 text-sm font-bold text-slate-950 active:scale-95">Ta bort</button>
          <button type="button" data-cancel-remove class="h-9 rounded-full px-3 text-sm font-semibold text-slate-300 hover:bg-slate-800">Avbryt</button>
        </span>`;
      }
      const on = selected.has(favKey(f));
      return `<span class="flex h-12 items-center rounded-full pr-1 pl-1.5 ring-1 transition ${on ? 'bg-home/15 ring-2 ring-home' : 'bg-slate-900 opacity-60 ring-slate-700'}">
        <button type="button" data-toggle="${esc(favKey(f))}" aria-pressed="${on}" class="flex h-full min-w-0 items-center gap-2 pr-1 text-left" title="Visa lagets matcher">
          ${logoImg(f.logo, 'size-8')}
          <span class="min-w-0 leading-tight"><span class="block max-w-44 truncate text-base font-bold">${esc(f.name || `Lag ${f.team}`)}</span><span class="block max-w-44 truncate text-xs text-slate-400">${esc(f.competition || '')}</span></span>
        </button>
        <button type="button" data-remove="${esc(favKey(f))}" class="flex size-9 items-center justify-center rounded-full text-lg text-slate-500 hover:bg-slate-800 hover:text-slate-200" aria-label="Ta bort ${esc(f.name || '')} från Mina lag" title="Ta bort från Mina lag">×</button>
      </span>`;
    }).join('')
    : '<p class="text-slate-400">Inga lag ännu. Tryck på <b class="text-slate-200">+ Lägg till lag</b>, sök med lag-id och tryck ☆ för att spara laget här.</p>';
}

els.favList.addEventListener('click', (e) => {
  const ask = e.target.closest('[data-remove]');
  const yes = e.target.closest('[data-confirm-remove]');
  const no = e.target.closest('[data-cancel-remove]');
  const toggle = e.target.closest('[data-toggle]');
  if (ask) {
    confirmingRemove = ask.dataset.remove; // first tap on ×: ask
    renderFavorites();
    return;
  }
  if (no) {
    confirmingRemove = null;
    renderFavorites();
    return;
  }
  confirmingRemove = null;
  if (yes) favs.remove(yes.dataset.confirmRemove);
  else if (toggle) favs.select(toggle.dataset.toggle);
  else return renderFavorites();
  renderFavorites();
  showFavorites();
});

// Tapping anywhere else cancels a pending "Ta bort?".
document.addEventListener('click', (e) => {
  // composedPath() is fixed at dispatch time, so a tap inside the list still counts as inside
  // even though the list was re-rendered (and the tapped button detached) by then.
  if (confirmingRemove && !e.composedPath().includes(els.favList)) {
    confirmingRemove = null;
    renderFavorites();
  }
});

// ---------- recent searches ----------

function remember(d) {
  const list = store.get('recentTeams', []).filter((r) => !(r.league === d.league && Number(r.team) === d.teamId));
  list.unshift({ league: d.league, team: String(d.teamId), name: d.name, logo: d.logo, competition: d.competition });
  store.set('recentTeams', list.slice(0, MAX_RECENT));
  renderRecent();
}

function renderRecent() {
  const list = store.get('recentTeams', []);
  els.recent.innerHTML = list.length
    ? `<h3 class="mb-2 text-xs font-bold tracking-wide text-slate-400 uppercase">Senast sökta</h3>
       <div class="flex flex-wrap gap-2">${list.map((r) => `
         <button type="button" data-league="${esc(r.league)}" data-team="${esc(r.team)}"
           class="flex h-11 items-center gap-2 rounded-full bg-slate-950 pr-4 pl-1.5 ring-1 ring-slate-700 transition hover:ring-home active:scale-[0.98]">
           ${logoImg(r.logo, 'size-8')}<span class="max-w-44 truncate text-sm font-semibold">${esc(r.name || `Lag ${r.team}`)}</span>
         </button>`).join('')}</div>`
    : '';
}

els.recent.addEventListener('click', (e) => {
  const b = e.target.closest('[data-team]');
  if (b) showTeam(b.dataset.league, b.dataset.team);
});

function showSearch(show) {
  els.searchSection.hidden = !show;
  if (show) els.team.focus();
}

// ---------- loading ----------

function startLoading(text) {
  clearTimeout(state.liveTimer);
  state.matches = [];
  render();
  setMessage(text);
  return ++state.loadId; // later loads win over earlier ones still in flight
}

// Merged list of all selected favourites. A match between two favourites is listed once.
async function showFavorites() {
  state.view = 'favorites';
  state.team = null;
  els.teamHead.hidden = true;
  document.title = 'Mina lag – Profixio Live';
  setUrl({});

  const selected = favs.list().filter((f) => favs.selected().has(favKey(f)));
  state.teamIds = new Set(selected.map((f) => Number(f.team)));
  if (!selected.length) {
    startLoading('');
    return;
  }

  const loadId = startLoading(`Hämtar matcher för ${selected.length === 1 ? selected[0].name || 'laget' : `${selected.length} lag`}…`);
  const results = await Promise.allSettled(selected.map((f) => cachedTeam(f.league, f.team)));
  if (loadId !== state.loadId) return;

  const byId = new Map();
  const failed = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return failed.push(selected[i].name || `lag ${selected[i].team}`);
    state.competitions.set(r.value.teamId, r.value.competition);
    for (const m of r.value.matches) if (!byId.has(m.id)) byId.set(m.id, { ...m, competition: r.value.competition });
  });
  state.matches = [...byId.values()].sort((a, b) => `${a.isoDate} ${a.time}`.localeCompare(`${b.isoDate} ${b.time}`));
  setMessage(failed.length ? `Kunde inte hämta: ${failed.join(', ')}` : (state.matches.length ? '' : 'Inga matcher.'), failed.length > 0);
  render();
  pollLive();
}

// One searched team, with a star to add it to (or remove it from) Mina lag.
async function showTeam(league, team) {
  state.view = 'team';
  els.team.value = team;
  els.league.value = league;
  store.set('league', league);
  setUrl({ team, league });
  showSearch(false);
  els.teamHead.hidden = true;

  const loadId = startLoading('Hämtar matcher…');
  try {
    const d = await cachedTeam(league, team);
    if (loadId !== state.loadId) return;
    state.team = d;
    state.matches = d.matches;
    state.teamIds = new Set([d.teamId]);
    remember(d);
    renderTeamHead();
    setMessage(d.matches.length ? '' : 'Laget har inga matcher.');
    render();
    pollLive();
  } catch (err) {
    if (loadId !== state.loadId) return;
    showSearch(true);
    setMessage(err instanceof ProfixioError && err.status === 404
      ? 'Hittade inget lag med det id:t i den ligan. Kontrollera liga-id.'
      : `Kunde inte hämta matcherna: ${err.message}`, true);
  }
}

function renderTeamHead() {
  const d = state.team;
  els.teamHead.hidden = false;
  els.name.textContent = d.name || `Lag ${d.teamId}`;
  els.competition.textContent = d.competition || '';
  els.logo.innerHTML = logoImg(d.logo, 'size-12 sm:size-14');
  els.link.href = d.url;
  document.title = `${d.name || 'Lag'} – matcher`;
  const starred = favs.has(d.league, d.teamId);
  els.star.textContent = starred ? '★ I Mina lag' : '☆ Lägg till';
  els.star.classList.toggle('text-away', starred);
  els.star.setAttribute('aria-pressed', String(starred));
}

els.star.addEventListener('click', () => {
  const d = state.team;
  if (!d) return;
  if (favs.has(d.league, d.teamId)) favs.remove(`${d.league}/${d.teamId}`);
  else favs.add(d);
  renderTeamHead();
  renderFavorites();
});

// Today's matches (and anything already live) get score updates without reloading the page.
async function pollLive() {
  clearTimeout(state.liveTimer);
  const loadId = state.loadId;
  const watch = state.matches.filter((m) => m.live || (m.isoDate === today() && !m.hasResult));
  if (!watch.length) return;
  try {
    const states = await loadLiveStates(watch.map((m) => m.id));
    if (loadId !== state.loadId) return;
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

function renderMatch(m, isNext) {
  const ours = (t) => state.teamIds.has(t.id);
  // HEMMA/BORTA only makes sense when exactly one of "our" teams plays.
  const side = ours(m.home) && !ours(m.away) ? 'home' : ours(m.away) && !ours(m.home) ? 'away' : null;
  const hasScore = m.homeGoals != null && m.awayGoals != null;
  // One line per team (logo, name, goals) so long names fit on a phone.
  const line = (t, goals) => `
    <span class="flex items-center gap-2.5">
      ${logoImg(t.logo, 'size-7')}
      <span class="min-w-0 flex-1 truncate ${ours(t) ? 'font-extrabold text-slate-50' : 'font-medium text-slate-300'}">${esc(t.name)}</span>
      ${hasScore ? `<span class="w-8 shrink-0 text-right text-xl font-black tabular-nums ${m.live ? 'text-red-300' : ''}">${esc(goals)}</span>` : ''}
    </span>`;
  const badges = [
    m.live ? `<span class="flex items-center gap-1.5 rounded-full bg-red-500 px-2.5 py-0.5 text-xs font-black text-slate-950"><span class="size-2 animate-pulse rounded-full bg-slate-950"></span>LIVE${m.period ? ` · ${m.period}:a halvlek` : ''}</span>` : '',
    !m.live && isNext ? '<span class="rounded-full bg-away px-2.5 py-0.5 text-xs font-black text-slate-950">NÄSTA</span>' : '',
    side ? `<span class="rounded-full px-2 py-0.5 text-xs font-bold ${side === 'home' ? 'bg-home/15 text-home' : 'bg-slate-800 text-slate-400'}">${side === 'home' ? 'HEMMA' : 'BORTA'}</span>` : '',
  ].join('');
  // In the merged list the teams can be in different competitions, so say which.
  const meta = [state.view === 'favorites' && state.teamIds.size > 1 ? m.competition : null, m.round, m.venue].filter(Boolean).join(' · ');
  const ring = m.live ? 'ring-2 ring-red-500' : isNext ? 'ring-2 ring-away' : 'ring-1 ring-slate-800';

  return `<a class="mb-3 flex items-center gap-3 rounded-2xl bg-slate-900 p-3 transition hover:bg-slate-800 active:scale-[0.99] sm:gap-4 sm:p-4 ${ring}" href="index.html?match=${m.id}">
    <span class="w-14 shrink-0 self-start pt-0.5 text-xl font-bold tabular-nums sm:w-16 sm:text-2xl">${esc(m.time || '')}</span>
    <span class="min-w-0 flex-1 space-y-1.5 text-lg">
      ${line(m.home, m.homeGoals)}
      ${line(m.away, m.awayGoals)}
      <span class="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-sm text-slate-500">${badges}<span class="min-w-0 truncate">${esc(meta)}</span></span>
    </span>
    <svg class="size-6 shrink-0 text-slate-600" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7"/></svg>
  </a>`;
}

function render() {
  for (const b of els.filters.querySelectorAll('[data-filter]')) b.classList.toggle('active', b.dataset.filter === state.filter);
  els.filters.hidden = !state.matches.length; // nothing to filter yet
  if (!state.matches.length) {
    els.schedule.innerHTML = '';
    return;
  }

  // "Kommande" = live, today's and future matches (today's stay until the day is over).
  const isUpcoming = (m) => !m.hasResult || m.live || m.isoDate === today();
  const isPlayed = (m) => m.hasResult && !m.live;
  const counts = { upcoming: state.matches.filter(isUpcoming).length, played: state.matches.filter(isPlayed).length, all: state.matches.length };
  for (const el of els.filters.querySelectorAll('[data-count]')) el.textContent = counts[el.dataset.count];

  const nextId = state.matches.find((m) => !m.hasResult && !m.live)?.id;
  const shown = state.matches.filter((m) =>
    state.filter === 'all' ? true : state.filter === 'played' ? isPlayed(m) : isUpcoming(m));
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
    html += renderMatch(m, m.id === nextId);
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
  showTeam(ids.league, ids.team);
});

els.addTeam.addEventListener('click', () => showSearch(els.searchSection.hidden));
els.cancel.addEventListener('click', () => showSearch(false));
els.back.addEventListener('click', () => showFavorites());
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollLive(); });

// ---------- start ----------

renderFavorites();
renderRecent();
const params = new URL(location.href).searchParams;
els.league.value = params.get('league') || store.get('league', DEFAULT_LEAGUE);
if (params.get('team')) showTeam(els.league.value, params.get('team'));
else {
  showFavorites();
  if (!favs.list().length) showSearch(true);
}
