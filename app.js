/* Hitster-träning – PWA för att öva på att placera låtar i tidsordning.
 * Spotify Web API (PKCE) + Web Playback SDK för uppspelning,
 * MusicBrainz (ISRC → first-release-date) för låtens år, Spotify-albumets år som reserv.
 */
'use strict';

// ---------- Konstanter ----------
const WIN_CARDS = 10;                 // 10 kort i tidslinjen inkl. startkortet
const SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',   // Web Playback SDK
  'user-modify-playback-state',                          // starta låt på spelaren
  'playlist-read-private', 'playlist-read-collaborative' // läsa spellistor
].join(' ');
const LS = {
  clientId: 'ht_client_id',
  tokens: 'ht_tokens',
  verifier: 'ht_pkce_verifier',
  state: 'ht_pkce_state',
  years: 'ht_year_cache',
  games: 'ht_games',
  current: 'ht_current_game',
  lastPlaylist: 'ht_last_playlist',
};
const DEMO = new URLSearchParams(location.search).has('demo');
if (DEMO) { LS.games = 'ht_demo_games'; LS.current = 'ht_demo_current_game'; LS.lastPlaylist = 'ht_demo_last_playlist'; }

// ---------- Hjälpfunktioner ----------
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked */ }
}
function lsDel(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

let toastTimer;
function toast(msg, ms = 4000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function loading(on, text = 'Laddar…') {
  $('#loading').hidden = !on;
  $('#loading-text').textContent = text;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Skärmar ----------
const SCREENS = ['setup', 'login', 'playlist', 'game', 'result', 'stats', 'settings'];
let currentScreen = null;
let previousScreen = null;
function show(name) {
  if (currentScreen && currentScreen !== name && !['stats', 'settings'].includes(currentScreen)) {
    previousScreen = currentScreen;
  }
  currentScreen = name;
  for (const s of SCREENS) $('#screen-' + s).hidden = s !== name;
  window.scrollTo(0, 0);
}
function goBack() {
  show(previousScreen || 'playlist');
  if (previousScreen === 'game') renderGame();
}

// ---------- Spotify-autentisering (PKCE) ----------
function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(len = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const vals = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(vals, (v) => chars[v % chars.length]).join('');
}

async function login() {
  const clientId = lsGet(LS.clientId);
  if (!clientId) { show('setup'); return; }
  const verifier = randomString(64);
  const state = randomString(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  lsSet(LS.verifier, verifier);
  lsSet(LS.state, state);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state,
  });
  location.assign('https://accounts.spotify.com/authorize?' + params);
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || 'Tokenfel ' + res.status);
  const old = lsGet(LS.tokens, {});
  const tokens = {
    access: data.access_token,
    refresh: data.refresh_token || old.refresh,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  lsSet(LS.tokens, tokens);
  return tokens;
}

async function handleAuthCallback() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  history.replaceState(null, '', redirectUri());
  if (q.has('error')) { toast('Inloggningen avbröts: ' + q.get('error')); return; }
  if (q.get('state') !== lsGet(LS.state)) { toast('Inloggningen kunde inte verifieras (state). Försök igen.'); return; }
  try {
    await tokenRequest({
      client_id: lsGet(LS.clientId),
      grant_type: 'authorization_code',
      code: q.get('code'),
      redirect_uri: redirectUri(),
      code_verifier: lsGet(LS.verifier),
    });
  } catch (e) {
    toast('Inloggning misslyckades: ' + e.message, 7000);
  } finally {
    lsDel(LS.verifier); lsDel(LS.state);
  }
}

let refreshing = null;
async function getToken() {
  const t = lsGet(LS.tokens);
  if (!t) throw new Error('Inte inloggad');
  if (Date.now() < t.expiresAt - 60_000) return t.access;
  if (!refreshing) {
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: lsGet(LS.clientId) })
      .finally(() => { refreshing = null; });
  }
  return (await refreshing).access;
}
function isLoggedIn() { return !!lsGet(LS.tokens)?.refresh; }

async function api(path, { method = 'GET', body, retry = true } = {}) {
  const url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + await getToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) {
    const t = lsGet(LS.tokens); if (t) { t.expiresAt = 0; lsSet(LS.tokens, t); }
    return api(path, { method, body, retry: false });
  }
  if (res.status === 429 && retry) {
    await sleep((Number(res.headers.get('Retry-After')) || 2) * 1000);
    return api(path, { method, body, retry: false });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || 'Spotify-fel ' + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- Spellistor ----------
function parsePlaylistId(input) {
  const s = input.trim();
  const m = s.match(/playlist[/:]([A-Za-z0-9]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{10,}$/.test(s)) return s;
  return null;
}

async function loadMyPlaylists() {
  const list = $('#playlists');
  if (DEMO) { list.innerHTML = '<li><button type="button" data-pl="demo"><span class="ph"></span><span class="meta"><span class="name">Demolista</span><span class="muted">utan Spotify</span></span></button></li>'; return; }
  list.innerHTML = '<li class="muted">Laddar…</li>';
  try {
    const me = await api('/me');
    const out = [];
    let url = '/me/playlists?limit=50';
    while (url && out.length < 500) {
      const page = await api(url);
      out.push(...page.items.filter(Boolean));
      url = page.next;
    }
    const usable = out.filter((p) => p.owner?.id === me.id || p.collaborative);
    if (!usable.length) { list.innerHTML = '<li class="muted">Hittade inga spellistor som du äger eller samarbetar på.</li>'; return; }
    list.innerHTML = usable.map((p) => {
      const img = p.images?.length ? p.images[p.images.length - 1].url : '';
      const count = p.items?.total ?? p.tracks?.total;
      return `<li><button type="button" data-pl="${esc(p.id)}">
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
        <span class="meta"><span class="name">${esc(p.name)}</span>
        <span class="muted">${count != null ? count + ' låtar' : ''}${p.collaborative ? ' · samarbete' : ''}</span></span>
      </button></li>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<li class="muted">Kunde inte hämta spellistor: ${esc(e.message)}</li>`;
  }
}

function toTrack(t) {
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name || '',
    spotifyYear: parseInt(t.album?.release_date, 10) || null,
    isrc: t.external_ids?.isrc || null,
  };
}

async function loadPlaylistTracks(playlistId) {
  if (playlistId === 'demo') return { name: 'Demolista', tracks: demoTracks() };
  const meta = await api(`/playlists/${playlistId}?fields=name`);
  const tracks = [];
  const seen = new Set();
  let url = `/playlists/${playlistId}/items?limit=50&additional_types=track`;
  while (url) {
    const page = await api(url);
    for (const entry of page.items || []) {
      const t = entry.item || entry.track;
      if (!t || t.type !== 'track' || t.is_local || !t.id || !t.uri || seen.has(t.id)) continue;
      seen.add(t.id);
      tracks.push(toTrack(t));
    }
    url = page.next;
  }
  return { name: meta.name, tracks };
}

// ---------- År: MusicBrainz med Spotify som reserv ----------
let mbChain = Promise.resolve();
let mbLast = 0;
function mbThrottle(fn) {
  // MusicBrainz tillåter högst ett anrop per sekund.
  const run = mbChain.then(async () => {
    const wait = mbLast + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    mbLast = Date.now();
    return fn();
  });
  mbChain = run.catch(() => {});
  return run;
}

async function musicBrainzYear(isrc) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await mbThrottle(() => fetch(`https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(isrc)}?fmt=json`, {
      headers: { Accept: 'application/json' },
    }));
    if (res.status === 404) return null;
    if (res.status === 503 || res.status === 429) { await sleep(2000); continue; }
    if (!res.ok) return null;
    const data = await res.json();
    const years = (data.recordings || [])
      .map((r) => parseInt(r['first-release-date'], 10))
      .filter((y) => y > 1800 && y <= new Date().getFullYear() + 1);
    return years.length ? Math.min(...years) : null;
  }
  return null;
}

const yearPromises = new Map();
function resolveYear(track) {
  if (track.year) return Promise.resolve(track);
  const cache = lsGet(LS.years, {});
  if (cache[track.id]) { Object.assign(track, cache[track.id]); return Promise.resolve(track); }
  if (yearPromises.has(track.id)) return yearPromises.get(track.id);
  const p = (async () => {
    let year = null, src = null;
    if (track.isrc && !DEMO) {
      try { year = await musicBrainzYear(track.isrc); if (year) src = 'musicbrainz'; } catch { /* nätverksfel → reserv */ }
    }
    if (!year && track.spotifyYear) { year = track.spotifyYear; src = 'spotify'; }
    track.year = year; track.src = src;
    if (year && !DEMO) {
      const c = lsGet(LS.years, {});
      c[track.id] = { year, src };
      lsSet(LS.years, c);
    }
    return track;
  })().finally(() => yearPromises.delete(track.id));
  yearPromises.set(track.id, p);
  return p;
}
function sourceLabel(src) {
  return src === 'musicbrainz' ? 'År från MusicBrainz (första utgivning)'
    : src === 'spotify' ? 'År från Spotify-albumet (hittades inte i MusicBrainz)'
    : src === 'demo' ? 'Demoår' : '';
}

// ---------- Uppspelning (Web Playback SDK) ----------
let player = null;
let deviceId = null;
let playerReady = null;

function initPlayer() {
  if (DEMO) return Promise.resolve();
  if (playerReady) return playerReady;
  playerReady = new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      player = new window.Spotify.Player({
        name: 'Hitster-träning',
        getOAuthToken: (cb) => { getToken().then(cb).catch(() => toast('Inloggningen har gått ut. Logga in igen.')); },
        volume: 0.8,
      });
      player.addListener('ready', ({ device_id }) => { deviceId = device_id; resolve(); });
      player.addListener('not_ready', () => { deviceId = null; });
      player.addListener('initialization_error', ({ message }) => { reject(new Error('Webbläsaren stöds inte: ' + message)); });
      player.addListener('authentication_error', ({ message }) => { toast('Spotify-autentisering misslyckades: ' + message, 7000); reject(new Error(message)); });
      player.addListener('account_error', () => { toast('Uppspelning kräver Spotify Premium.', 7000); reject(new Error('Premium krävs')); });
      player.addListener('playback_error', ({ message }) => { toast('Uppspelningsfel: ' + message); });
      player.addListener('player_state_changed', (s) => { $('#current').classList.toggle('playing', !!s && !s.paused); });
      player.connect();
    };
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.onerror = () => reject(new Error('Kunde inte ladda Spotifys spelare'));
    document.head.appendChild(script);
  });
  playerReady.catch(() => { playerReady = null; });
  return playerReady;
}

function activateAudio() {
  // Måste anropas direkt i ett tryck (krav i mobilwebbläsare för att ljud ska få starta).
  try { player?.activateElement?.(); } catch { /* ignore */ }
}

async function playTrack(uri) {
  if (DEMO) { $('#current').classList.add('playing'); return; }
  try {
    await initPlayer();
    await api(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT', body: { uris: [uri], position_ms: 0 } });
  } catch (e) {
    toast('Kunde inte spela låten: ' + e.message + '. Tryck på ▶ Spela.', 6000);
  }
}
async function pausePlayback() {
  if (DEMO) { $('#current').classList.remove('playing'); return; }
  try { await player?.pause(); } catch { /* ignore */ }
}
async function resumePlayback() {
  if (DEMO) { $('#current').classList.add('playing'); return; }
  const g = game;
  if (!g?.current) return;
  const state = await player?.getCurrentState?.().catch(() => null);
  if (state && state.track_window?.current_track?.uri === g.current.uri) { await player.resume(); }
  else { await playTrack(g.current.uri); }
}

// ---------- Spellogik ----------
let game = null;
let lastPlaylistTracks = null;

function saveCurrent() { if (game) lsSet(LS.current, game); else lsDel(LS.current); }

async function startGame(playlistId) {
  loading(true, 'Hämtar spellistan…');
  try {
    const { name, tracks } = await loadPlaylistTracks(playlistId);
    if (tracks.length < 2) throw new Error('Spellistan behöver minst 2 spelbara låtar.');
    lastPlaylistTracks = { id: playlistId, name, tracks };
    lsSet(LS.lastPlaylist, playlistId);
    game = {
      playlistId, playlistName: name,
      deck: shuffle(tracks).map((t) => t.id),
      tracks: Object.fromEntries(tracks.map((t) => [t.id, t])),
      timeline: [], current: null, phase: 'loading',
      correct: 0, wrong: 0, guesses: [], skipped: 0,
      lastGuess: null, startedAt: Date.now(),
    };
    loading(true, 'Hämtar startkortets år…');
    const first = await drawCard();
    if (!first) throw new Error('Hittade inget år för någon låt i listan.');
    game.timeline.push(first);
    show('game');
    if (!DEMO) initPlayer().catch((e) => toast(e.message, 7000));
    await nextRound(false);
  } catch (e) {
    toast(e.message, 7000);
    game = null;
  } finally {
    loading(false);
    saveCurrent();
  }
}

// Drar nästa låt ur högen och tar reda på dess år. Låtar utan år hoppas över.
async function drawCard() {
  while (game.deck.length) {
    const id = game.deck.pop();
    const t = await resolveYear(game.tracks[id]);
    prefetchNext();
    if (t.year) return { id: t.id, uri: t.uri, name: t.name, artists: t.artists, year: t.year, src: t.src };
    game.skipped++;
  }
  return null;
}
function prefetchNext() {
  const id = game?.deck[game.deck.length - 1];
  if (id) resolveYear(game.tracks[id]).catch(() => {});
}

async function nextRound(fromTap = true) {
  if (fromTap) activateAudio();
  if (game.timeline.length >= WIN_CARDS) return finishGame('won');
  game.phase = 'loading';
  game.current = null;
  renderGame();
  $('#current-sub').textContent = 'Hämtar nästa låt…';
  const card = await drawCard();
  if (!card) return finishGame('out');
  game.current = card;
  game.phase = 'guess';
  game.lastGuess = null;
  saveCurrent();
  renderGame();
  playTrack(card.uri);
}

function isCorrectPlacement(timeline, gapIndex, year) {
  const before = timeline[gapIndex - 1];
  const after = timeline[gapIndex];
  return (!before || before.year <= year) && (!after || year <= after.year);
}

function place(gapIndex) {
  if (game.phase !== 'guess') return;
  const card = game.current;
  const ok = isCorrectPlacement(game.timeline, gapIndex, card.year);
  game.guesses.push(ok);
  if (ok) { game.correct++; game.timeline.splice(gapIndex, 0, card); }
  else { game.wrong++; }
  game.lastGuess = { ok, card, gapIndex };
  game.phase = 'reveal';
  saveCurrent();
  renderGame();
}

function currentStreak(guesses) {
  let n = 0;
  for (let i = guesses.length - 1; i >= 0 && guesses[i]; i--) n++;
  return n;
}

function finishGame(status) {
  pausePlayback();
  const record = {
    date: Date.now(),
    playlist: game.playlistName,
    status,                          // 'won' | 'out'
    correct: game.correct,
    wrong: game.wrong,
    guesses: game.guesses,
    cards: game.timeline.length,
  };
  const games = lsGet(LS.games, []);
  games.push(record);
  lsSet(LS.games, games);
  game = null;
  saveCurrent();
  renderResult(record);
  show('result');
}

function quitGame() {
  if (!confirm('Avbryta spelet? Det sparas inte i statistiken.')) return;
  pausePlayback();
  game = null;
  saveCurrent();
  show('playlist');
  renderPlaylistScreen();
}

// ---------- Rendering: spel ----------
function renderGame() {
  if (!game) return;
  $('#tl-count').textContent = game.timeline.length;
  $('#sc-correct').textContent = game.correct;
  $('#sc-wrong').textContent = game.wrong;
  $('#sc-streak').textContent = currentStreak(game.guesses);

  const guessing = game.phase === 'guess';
  const revealing = game.phase === 'reveal';
  $('#current').hidden = revealing;
  $('#place-hint').hidden = !guessing;
  $('#current-title').textContent = 'Ny låt';
  $('#current-sub').textContent = guessing ? 'Lyssna och placera den i tidslinjen.' : 'Hämtar nästa låt…';
  $('#btn-play').disabled = !guessing;
  $('#btn-pause').disabled = !guessing;

  const rv = $('#reveal');
  rv.hidden = !revealing;
  if (revealing && game.lastGuess) {
    const { ok, card } = game.lastGuess;
    rv.className = 'reveal ' + (ok ? 'ok' : 'bad');
    $('#reveal-verdict').textContent = ok ? 'Rätt!' : 'Fel – låten kasseras';
    $('#reveal-year').textContent = card.year;
    $('#reveal-title').textContent = card.name;
    $('#reveal-artist').textContent = card.artists;
    $('#reveal-source').textContent = sourceLabel(card.src);
    $('#btn-next').textContent = game.timeline.length >= WIN_CARDS ? 'Se resultat' : 'Nästa låt';
  }

  const tl = $('#timeline');
  const parts = [];
  const gap = (i) => guessing
    ? `<li class="gap"><button type="button" data-gap="${i}">${gapLabel(i)}</button></li>`
    : '<li class="gap spacer"></li>';
  game.timeline.forEach((c, i) => {
    parts.push(gap(i));
    const fresh = revealing && game.lastGuess?.ok && game.lastGuess.card.id === c.id;
    parts.push(`<li class="tl-card${fresh ? ' fresh' : ''}"><span class="year">${c.year}</span>
      <span><span class="t">${esc(c.name)}</span><br><span class="a">${esc(c.artists)}</span></span></li>`);
  });
  parts.push(gap(game.timeline.length));
  tl.innerHTML = parts.join('');
}
function gapLabel(i) {
  const tl = game.timeline;
  if (i === 0) return `Före ${tl[0].year}`;
  if (i === tl.length) return `Efter ${tl[tl.length - 1].year}`;
  return `Mellan ${tl[i - 1].year} och ${tl[i].year}`;
}

// ---------- Statistik ----------
function runsOf(guesses) {
  // En svit = en följd av minst ett rätt i rad, avslutad av ett fel eller spelets slut.
  const runs = []; let cur = 0;
  for (const g of guesses) { if (g) cur++; else { if (cur) runs.push(cur); cur = 0; } }
  if (cur) runs.push(cur);
  return runs;
}
const maxRun = (guesses) => Math.max(0, ...runsOf(guesses));
const pct = (c, w) => (c + w ? Math.round((100 * c) / (c + w)) : 0);
const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString('sv-SE');

function aggregate(games) {
  const allRuns = games.flatMap((g) => runsOf(g.guesses));
  const longest = games.map((g) => maxRun(g.guesses));
  const c = games.reduce((s, g) => s + g.correct, 0);
  const w = games.reduce((s, g) => s + g.wrong, 0);
  return {
    games: games.length,
    won: games.filter((g) => g.status === 'won').length,
    avgRun: allRuns.length ? allRuns.reduce((a, b) => a + b, 0) / allRuns.length : 0,
    avgLongest: longest.length ? longest.reduce((a, b) => a + b, 0) / longest.length : 0,
    record: Math.max(0, ...longest),
    hitRate: pct(c, w),
  };
}

function tile(v, l) { return `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`; }

function chartSvg(games) {
  const pts = games.slice(-30).map((g) => pct(g.correct, g.wrong));
  if (pts.length < 2) return '<p class="muted">Diagrammet visas när du spelat minst två spel.</p>';
  const W = 320, H = 140, L = 40, R = 8, T = 10, B = 22;
  const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + ((100 - v) * (H - T - B)) / 100;
  const grid = [0, 50, 100].map((v) => `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`).join('');
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const dots = pts.map((v, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"><title>Spel ${games.length - pts.length + i + 1}: ${v}%</title></circle>`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Träffprocent per spel">${grid}
    <polyline class="line" points="${line}"/>${dots}
    <text x="${L}" y="${H - 4}">Äldst</text><text x="${W - R}" y="${H - 4}" text-anchor="end">Senaste</text></svg></div>`;
}

function historyHtml(games) {
  if (!games.length) return '<p class="muted">Inga spel sparade ännu.</p>';
  const a = aggregate(games);
  const recent = games.slice(-10).reverse().map((g) => `<li>
      <span>${new Date(g.date).toLocaleDateString('sv-SE')} · ${g.status === 'won' ? 'Vunnet' : 'Låtarna tog slut'}</span>
      <span>${g.correct} rätt / ${g.wrong} fel · ${pct(g.correct, g.wrong)}%</span></li>`).join('');
  return `<div class="tiles">
      ${tile(fmt1(a.avgRun), 'Snittlängd på sviter (rätt i rad)')}
      ${tile(fmt1(a.avgLongest), 'Snitt av längsta svit per spel')}
      ${tile(a.record, 'Rekord, rätt i rad')}
      ${tile(a.hitRate + '%', 'Träffprocent totalt')}
      ${tile(a.games, 'Spelade spel')}
      ${tile(a.won, 'Vunna spel')}
    </div>
    <p class="explain">En svit är en följd av minst ett rätt i rad som bryts av ett fel eller av att spelet tar slut. Startkortet räknas inte som en gissning.</p>
    <h3>Träffprocent per spel</h3>
    ${chartSvg(games)}
    <h3>Senaste spelen</h3>
    <ul class="history">${recent}</ul>`;
}

function renderResult(rec) {
  $('#result-heading').textContent = rec.status === 'won' ? 'Vunnet! 🎉' : 'Låtarna tog slut – ej vunnet';
  $('#result-tiles').innerHTML =
    tile(rec.correct, 'Rätt') + tile(rec.wrong, 'Fel') +
    tile(pct(rec.correct, rec.wrong) + '%', 'Träffprocent') + tile(maxRun(rec.guesses), 'Längsta svit i spelet');
  $('#result-history').innerHTML = historyHtml(lsGet(LS.games, []));
}
function renderStats() { $('#stats-body').innerHTML = historyHtml(lsGet(LS.games, [])); }

// ---------- Startflöde ----------
function renderPlaylistScreen() {
  const saved = lsGet(LS.current);
  $('#resume-box').hidden = !saved;
  loadMyPlaylists();
}

function route() {
  if (DEMO) { show('playlist'); renderPlaylistScreen(); return; }
  if (!lsGet(LS.clientId)) { show('setup'); return; }
  if (!isLoggedIn()) { show('login'); return; }
  show('playlist');
  renderPlaylistScreen();
}

function bind() {
  for (const id of ['#redirect-uri', '#redirect-uri-2']) $(id).textContent = redirectUri();
  $('#copy-redirect').onclick = () => navigator.clipboard?.writeText(redirectUri()).then(() => toast('Kopierat'));
  $('#save-client').onclick = () => {
    const v = $('#client-id').value.trim();
    if (!/^[0-9a-f]{32}$/i.test(v)) { toast('Det ser inte ut som ett Client ID (32 tecken, 0–9 och a–f).'); return; }
    lsSet(LS.clientId, v); login();
  };
  $('#login').onclick = login;

  document.querySelectorAll('[data-nav]').forEach((b) => {
    b.onclick = () => {
      const to = b.dataset.nav;
      if (to === 'stats') renderStats();
      if (to === 'settings') $('#client-id-2').value = lsGet(LS.clientId, '');
      show(to);
    };
  });
  $('#stats-back').onclick = goBack;
  $('#settings-back').onclick = goBack;
  $('#save-client-2').onclick = () => {
    const v = $('#client-id-2').value.trim();
    if (!/^[0-9a-f]{32}$/i.test(v)) { toast('Det ser inte ut som ett Client ID.'); return; }
    lsSet(LS.clientId, v); lsDel(LS.tokens); toast('Sparat. Logga in igen.'); route();
  };
  $('#logout').onclick = () => { lsDel(LS.tokens); player?.disconnect(); playerReady = null; toast('Utloggad'); route(); };
  $('#reset-stats').onclick = () => { if (confirm('Radera all statistik?')) { lsDel(LS.games); toast('Statistiken är nollställd'); renderStats(); } };
  $('#clear-year-cache').onclick = () => { lsDel(LS.years); toast('Årscachen är tömd'); };

  $('#use-url').onclick = () => {
    const id = parsePlaylistId($('#playlist-url').value);
    if (!id) { toast('Kunde inte läsa ut ett spellist-ID ur länken.'); return; }
    activateAudio(); startGame(id);
  };
  $('#playlists').onclick = (e) => {
    const b = e.target.closest('[data-pl]');
    if (b) { activateAudio(); startGame(b.dataset.pl); }
  };
  $('#resume-game').onclick = () => {
    game = lsGet(LS.current);
    if (!game) return;
    show('game');
    if (!DEMO) initPlayer().catch((e) => toast(e.message, 7000));
    if (game.phase === 'loading' || !game.current && game.phase !== 'reveal') nextRound(true);
    else renderGame();  // i gissningsläge: tryck ▶ Spela för att höra låten igen
  };
  $('#discard-game').onclick = () => { lsDel(LS.current); $('#resume-box').hidden = true; };

  $('#timeline').onclick = (e) => {
    const b = e.target.closest('[data-gap]');
    if (b) place(Number(b.dataset.gap));
  };
  $('#btn-play').onclick = () => { activateAudio(); resumePlayback(); };
  $('#btn-pause').onclick = pausePlayback;
  $('#btn-next').onclick = () => nextRound(true);
  $('#btn-quit').onclick = quitGame;
  $('#btn-again').onclick = () => { const id = lsGet(LS.lastPlaylist); if (id) { activateAudio(); startGame(id); } else route(); };
  $('#btn-other').onclick = () => { show('playlist'); renderPlaylistScreen(); };
}

// ---------- Demoläge (?demo) – för test utan Spotify ----------
function demoTracks() {
  const data = [
    ['Låt A', 'Artist 1', 1965], ['Låt B', 'Artist 2', 1972], ['Låt C', 'Artist 3', 1979],
    ['Låt D', 'Artist 4', 1984], ['Låt E', 'Artist 5', 1984], ['Låt F', 'Artist 6', 1991],
    ['Låt G', 'Artist 7', 1997], ['Låt H', 'Artist 8', 2003], ['Låt I', 'Artist 9', 2008],
    ['Låt J', 'Artist 10', 2015], ['Låt K', 'Artist 11', 2015], ['Låt L', 'Artist 12', 2021],
  ];
  return data.map(([name, artists, year], i) => ({
    id: 'demo' + i, uri: 'spotify:track:demo' + i, name, artists, album: '', spotifyYear: year, isrc: null, year, src: 'demo',
  }));
}

// ---------- Uppstart ----------
(async function main() {
  if ('serviceWorker' in navigator && !DEMO) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  bind();
  await handleAuthCallback();
  route();
})();

// Exponeras för tester
window.__ht = { isCorrectPlacement, runsOf, aggregate, get game() { return game; } };
