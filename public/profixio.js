// Reads Profixio pages in the browser, through the same-origin relay at /proxy/ (see proxy.js).

const PROXY = '/proxy/';
const MAX_LOAD_MORE = 10;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };

export class ProfixioError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- helpers ----------

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
const kids = (el, selector) => [...(el?.children ?? [])].filter((c) => c.matches(selector));
const parseHtml = (html) => new DOMParser().parseFromString(html, 'text/html');

async function get(path, init = {}) {
  const res = await fetch(PROXY + path, { cache: 'no-store', ...init });
  if (!res.ok) throw new ProfixioError(res.status, `Profixio svarade HTTP ${res.status}`);
  return res;
}

// Profixio embeds JSON in Alpine attributes as JS string literals: JSON.parse('{"a":1}')
function embeddedJson(html, prefix) {
  const m = html.match(new RegExp(prefix + String.raw`JSON\.parse\('((?:[^'\\]|\\.)*)'\)`));
  if (!m) return null;
  try {
    const literal = m[1].replace(/\\'/g, "'").replace(/\\\//g, '/');
    return JSON.parse(JSON.parse(`"${literal}"`));
  } catch {
    return null;
  }
}

function snapshot(doc, componentName) {
  for (const el of doc.querySelectorAll('[wire\\:snapshot]')) {
    try {
      const snap = JSON.parse(el.getAttribute('wire:snapshot'));
      if (snap?.memo?.name === componentName) return { raw: el.getAttribute('wire:snapshot'), data: snap.data };
    } catch { /* not every snapshot parses */ }
  }
  return null;
}

// "Söndag 8 nov 2026" -> "2026-11-08"
function isoDate(text) {
  const m = text?.match(/(\d{1,2}) ([a-zåäö]{3})\w* (\d{4})/i);
  const month = m && MONTHS[m[2].toLowerCase()];
  return month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// ---------- match page (lineups tab) ----------

function parseTeams(doc) {
  const teams = new Map();
  for (const ul of doc.querySelectorAll('ul')) {
    const items = kids(ul, 'li');
    const header = ul.previousElementSibling;
    if (!items.length || !header || !header.textContent.includes('#')) continue;
    // Header row: [avatar] # Namn Mål Bestr.
    const columns = kids(header, 'span').slice(3).map((s) => s.getAttribute('title') || clean(s.textContent));

    let card = ul.parentElement;
    while (card && !card.querySelector('a[href*="/teams/"]')) card = card.parentElement;
    const teamLink = card?.querySelector('a[href*="/teams/"]');
    const name = clean(teamLink?.textContent);
    const id = Number(teamLink?.getAttribute('href').match(/\/teams\/(\d+)/)?.[1]) || null;
    const key = id ?? name;
    if (!name || teams.has(key)) continue; // the lineup is rendered twice (mobile/desktop)

    const players = [];
    const staff = [];
    for (const li of items) {
      const row = kids(li, 'a, div')[0];
      const spans = kids(row, 'span');
      const number = clean(spans[1]?.textContent);
      const nameSpans = kids(spans[2], 'span');
      const personName = clean(nameSpans[0]?.textContent);
      if (!personName) continue;
      const entry = {
        number,
        name: personName,
        tags: nameSpans.slice(1).map((s) => clean(s.textContent)).filter(Boolean),
        stats: spans.slice(3).map((s) => clean(s.textContent)),
      };
      (/^\d+$/.test(number) ? players : staff).push(entry);
    }
    teams.set(key, { id, name, columns, players, staff });
  }
  return [...teams.values()];
}

// The match's events (goals, cards, suspensions, timeouts…) as Profixio's own page seeds them,
// already normalized (side, cls, playerNo, isYellow, expulsionEndSeconds, …). A finished match
// only seeds them on the default tab, so that is fetched as a fallback.
async function matchEvents(id, seed) {
  if (seed.events?.length) return seed.events;
  try {
    const html = await (await get(`lx/match/${id}`)).text();
    return embeddedJson(html, String.raw`matchLive\(`)?.events ?? [];
  } catch {
    return [];
  }
}

// Reverb (Pusher protocol) websocket settings from the page's meta tags; the socket is on /ws.
function realtimeConfig(doc) {
  const meta = (name) => doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
  const key = meta('reverb-key');
  if (!key) return null;
  const scheme = meta('reverb-scheme') === 'http' ? 'ws' : 'wss';
  return { url: `${scheme}://${meta('reverb-host') || 'www.profixio.com'}:${meta('reverb-port') || 443}/ws/app/${key}` };
}

// Which players have been activated (marked present) in the match, per side, from the signed
// live snapshot the match page links to while a match is live. null when unknown (not live,
// link expired…), in which case nobody is greyed out.
async function activatedPlayers(seed) {
  if (!seed.resyncUrl) return null;
  try {
    const url = new URL(seed.resyncUrl);
    if (url.origin !== 'https://www.profixio.com' || !url.pathname.startsWith('/app/')) return null;
    const info = await (await get(url.pathname.slice('/app/'.length) + url.search, { headers: { Accept: 'application/json' } })).json();
    if (!Array.isArray(info.lineup)) return null;
    const sides = { home: new Set(), away: new Set() };
    for (const p of info.lineup) {
      if (p.type !== 'player' || !(p.current || p.played)) continue;
      const side = p.webTeamId === seed.homeWebid ? 'home' : p.webTeamId === seed.awayWebid ? 'away' : null;
      if (side) sides[side].add(String(p.number).trim());
    }
    return { home: [...sides.home], away: [...sides.away] };
  } catch {
    return null;
  }
}

export async function loadMatch(id) {
  const [pageRes, live] = await Promise.all([
    get(`lx/match/${id}?tab=lineups`),
    loadLiveState(id).catch(() => null),
  ]);
  const html = await pageRes.text();
  const doc = parseHtml(html);
  const seed = embeddedJson(html, String.raw`matchLive\(`) || {};
  let gamestate = embeddedJson(html, 'gamestate: ');
  const setup = embeddedJson(html, 'setup: ');

  // live-state carries the freshest score/clock while a match is running.
  if (live?.gamestate) gamestate = { ...gamestate, ...live.gamestate };

  let teams = parseTeams(doc);
  if (seed.homeWebid && seed.awayWebid) {
    const rank = (t) => (t.id === seed.homeWebid ? 0 : t.id === seed.awayWebid ? 1 : 2);
    teams = teams.sort((a, b) => rank(a) - rank(b));
  }

  return {
    id,
    title: snapshot(doc, 'lx.header-info')?.data?.title ?? null,
    kickoff: clean(doc.querySelector('main')?.textContent).match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)?.[0] ?? null,
    state: seed.state ?? null,
    gamestate,
    setup,
    teams,
    ...Object.fromEntries(await Promise.all([
      matchEvents(id, seed).then((v) => ['events', v]),
      activatedPlayers(seed).then((v) => ['activated', v]),
    ])),
    sequence: live?.sequence ?? null, // bumps whenever anything in the match changes
    realtime: realtimeConfig(doc),
  };
}

// Light (~1 KB) score/clock/sequence for one match: { sequence, homegoals, awaygoals, gamestate, setup, … }
export async function loadLiveState(id) {
  return (await loadLiveStates([id]))[id] ?? null;
}

// ---------- team page (schedule tab) ----------

// One <li wire:key="listkamp_<id>"> per match. The date heading is only rendered on the first
// match of each day, so it carries over to the following ones.
function parseSchedule(root) {
  const matches = [];
  let date = null;
  for (const li of root.querySelectorAll('li[wire\\:key^="listkamp_"]')) {
    const heading = li.querySelector('.text-xl.font-bold');
    if (heading) date = clean(heading.textContent);

    const links = li.querySelectorAll('a[href*="/teams/"]');
    const logos = li.querySelectorAll('img[src*="/logos/"]');
    const team = (i) => ({
      id: Number(links[i]?.getAttribute('href').match(/\/teams\/(\d+)/)?.[1]) || null,
      name: clean(links[i]?.textContent),
      logo: logos[i]?.getAttribute('src') ?? null,
    });

    const init = li.querySelector('[x-init]')?.getAttribute('x-init') || '';
    const goals = (side) => init.match(new RegExp(`${side}goals: '(\\d*)'`))?.[1] || null;
    // Kickoff time lives inside Alpine <template>s, whose content isn't part of textContent,
    // so read the text from the serialized HTML instead (innerHTML includes template content).
    const text = clean(li.innerHTML.replace(/<[^>]*>/g, ' '));
    const hasResult = /hasResult: true/.test(init);

    matches.push({
      id: Number(li.getAttribute('wire:key').slice('listkamp_'.length)),
      date,
      isoDate: isoDate(date),
      time: text.match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? null,
      round: text.match(/Omgång \d+/)?.[0] ?? null,
      venue: clean(li.querySelector('a[href*="/facility/"]')?.textContent) || null,
      home: team(0),
      away: team(1),
      homeGoals: goals('home'),
      awayGoals: goals('away'),
      hasResult,
      live: /hasLivescore: true/.test(init) && !hasResult,
    });
  }
  return matches;
}

// The schedule renders 15 matches and loads the rest through Livewire's loadMore(); keep calling
// it (with the page's session cookie + CSRF token) until the list stops growing.
export async function loadTeam(league, teamId) {
  const path = `lx/competition/leagueid${league}/teams/${teamId}`;
  const res = await get(`${path}?t=schedule&f=all`);
  const cookie = res.headers.get('X-Profixio-Set-Cookie') || '';
  const html = await res.text();
  const doc = parseHtml(html);
  let matches = parseSchedule(doc);

  try {
    const csrf = html.match(/data-csrf="([^"]+)"/)?.[1];
    let snap = snapshot(doc, 'lx.team.schedule');
    for (let i = 0; csrf && snap && i < MAX_LOAD_MORE && matches.length >= snap.data.matchesPerPage; i++) {
      const lw = await get('livewire/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Livewire': '1',
          'X-CSRF-TOKEN': csrf,
          'X-Profixio-Cookie': cookie,
          'X-Profixio-Referer': `https://www.profixio.com/app/${path}`,
        },
        body: JSON.stringify({ _token: csrf, components: [{ snapshot: snap.raw, updates: {}, calls: [{ path: '', method: 'loadMore', params: [] }] }] }),
      });
      const component = (await lw.json()).components?.[0];
      const more = parseSchedule(parseHtml(component?.effects?.html || ''));
      if (more.length <= matches.length) break;
      matches = more;
      snap = { raw: component.snapshot, data: JSON.parse(component.snapshot).data };
    }
  } catch (err) {
    console.warn('loadMore failed, showing the first page only', err); // first page is still useful
  }

  const name = snapshot(doc, 'lx.header-info')?.data?.title || clean(doc.title).replace(/\s*-\s*Profixio$/, '');
  const ownMatch = matches.find((m) => m.home.id === Number(teamId) || m.away.id === Number(teamId));
  const own = ownMatch && (ownMatch.home.id === Number(teamId) ? ownMatch.home : ownMatch.away);

  return {
    league,
    teamId: Number(teamId),
    name,
    logo: own?.logo ?? null,
    competition: clean(doc.querySelector(`a[href$="/competition/leagueid${league}"]`)?.textContent) || null,
    url: `https://www.profixio.com/app/${path}?t=schedule`,
    matches,
  };
}

// Profixio server clock minus the device clock, in seconds (the match clock is computed from
// server timestamps). Same approach as Profixio's own timeSync: take the least uncertain of a few samples.
export async function clockOffset(samples = 3) {
  let best = { offset: 0, uncertainty: Infinity };
  for (let i = 0; i < samples; i++) {
    try {
      const sent = Date.now();
      const serverMs = await (await get('api/time')).json();
      const received = Date.now();
      const uncertainty = (received - sent) / 2;
      if (uncertainty < best.uncertainty) best = { offset: (serverMs + uncertainty - received) / 1000, uncertainty };
    } catch { /* keep earlier samples */ }
  }
  return best.offset;
}

// Score/clock for several matches at once: { [id]: { homegoals, awaygoals, hasLivescore, hasResult, gamestate } }
export async function loadLiveStates(ids) {
  if (!ids.length) return {};
  const res = await get(`api/matches/live-state?ids=${ids.join(',')}`);
  return res.json();
}
