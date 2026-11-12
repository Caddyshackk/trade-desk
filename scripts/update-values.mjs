// Refreshes values.json for Gridiron Trade Desk. Runs daily from GitHub Actions (Node 20+, no dependencies).
// QB/RB/WR/TE: FantasyCalc redraft market values (10/12/14-team). K/DEF: ranked by Sleeper rest-of-season projections,
// scaled 0.75x for 10-team and 1.25x for 14-team leagues.
// Matchups left: ESPN public fantasy data (ESPN matchup ratings by position + remaining NFL schedule).
// If a source fails, the previous values for that group are kept so the site never breaks.
import { readFile, writeFile } from "node:fs/promises";

const OUT = new URL("../values.json", import.meta.url);
const getJSON = async (url, extra) => {
  const r = await fetch(url, { headers: { "user-agent": "gridiron-trade-desk", ...(extra || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};

// Sleeper player ID -> name, so the page can read Sleeper rosters.
const SLEEPER = {};
let prev = { players: [] };
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}
// Row format: [name, pos, team, age, [12 values: sizes 10/12/14 x ppr/half/std/sf], trend30Day]
const SIZES = [10, 12, 14], FMTS = ["ppr", "half", "std", "sf"];
const prevOf = (pos) => prev.players.filter((r) => pos.includes(r[1]) && Array.isArray(r[4]));

// ---- Offense from FantasyCalc ----
async function offense() {
  const base = "https://api.fantasycalc.com/values/current?isDynasty=false&numTeams=12";
  const variants = { ppr: "&ppr=1&numQbs=1", half: "&ppr=0.5&numQbs=1", std: "&ppr=0&numQbs=1", sf: "&ppr=1&numQbs=2" };
  const m = new Map();
  for (const size of SIZES) for (const [k, q] of Object.entries(variants)) {
    const slot = SIZES.indexOf(size) * 4 + FMTS.indexOf(k);
    const list = await getJSON(base.replace("numTeams=12", `numTeams=${size}`) + q);
    for (const p of list) {
      const pl = p.player || {};
      if (!["QB", "RB", "WR", "TE"].includes(pl.position)) continue;
      const id = pl.sleeperId || pl.name;
      const row = m.get(id) || { n: pl.name, pos: pl.position, tm: pl.maybeTeam || "FA", age: pl.maybeAge ? Math.round(pl.maybeAge * 10) / 10 : 0, v: Array(12).fill(null), tr: 0 };
      row.v[slot] = Math.round(p.value || 0);
      if (size === 12 && k === "ppr") row.tr = Math.round(p.trend30Day || 0);
      if (pl.sleeperId) SLEEPER[pl.sleeperId] = pl.name;
      m.set(id, row);
    }
  }
  // A player missing from one league size falls back to his 12-team value for that format.
  const rows = [...m.values()].map((r) => [r.n, r.pos, r.tm, r.age, r.v.map((x, i) => x ?? r.v[4 + (i % 4)] ?? 0), r.tr]);
  if (rows.length < 100) throw new Error(`FantasyCalc returned only ${rows.length} players`);
  return rows;
}

// ---- Kickers and defenses from Sleeper projections ----
const TEAMS = { ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills", CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns", DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers", HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs", LV: "Las Vegas Raiders", LAC: "Los Angeles Chargers", LAR: "Los Angeles Rams", MIA: "Miami Dolphins", MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants", NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SF: "San Francisco 49ers", SEA: "Seattle Seahawks", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WAS: "Washington Commanders" };

async function kdef() {
  const state = await getJSON("https://api.sleeper.app/v1/state/nfl");
  const season = state.season;
  const start = state.season_type === "regular" ? Math.max(1, Number(state.week) || 1) : 1;
  const tot = new Map();
  for (let w = start; w <= 18; w++) {
    let list;
    try { list = await getJSON(`https://api.sleeper.com/projections/nfl/${season}/${w}?season_type=regular&position[]=K&position[]=DEF`); }
    catch { continue; }
    for (const it of list || []) {
      const pl = it.player || {};
      const pos = pl.position || it.position;
      if (pos !== "K" && pos !== "DEF") continue;
      const id = it.player_id;
      const name = pos === "DEF" ? `${TEAMS[id] || id} D/ST` : `${pl.first_name || ""} ${pl.last_name || ""}`.trim();
      const pts = Number(it.stats?.pts_ppr ?? it.stats?.pts_std ?? 0) || 0;
      const row = tot.get(id) || { n: name, pos, tm: it.team || pl.team || (pos === "DEF" ? id : "FA"), pts: 0 };
      row.pts += pts;
      SLEEPER[id] = name;
      tot.set(id, row);
    }
  }
  const rank = (pos, top, decay, floor) =>
    [...tot.values()].filter((r) => r.pos === pos && r.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, 32)
      .map((r, i) => { const v = Math.round(top * Math.exp(-i / decay) + floor); return [r.n, pos, r.tm, 0, [...Array(4).fill(Math.round(v * 0.75)), ...Array(4).fill(v), ...Array(4).fill(Math.round(v * 1.25))], null]; });
  const def = rank("DEF", 420, 7, 15), k = rank("K", 300, 6, 10);
  if (def.length < 20 || k.length < 20) throw new Error(`Sleeper projections too thin (DEF ${def.length}, K ${k.length})`);
  return [...def, ...k];
}

// Matchups left: ESPN's own positional matchup ratings (the OPRK numbers in the ESPN app) + the NFL schedule.
// ranks[pos][team] = that defense's rank vs the position (1 = toughest, 32 = easiest). sched[team] = [[week, opp, kickoff ms], ...].
async function buildMatchups(season, getJSON) {
  const BASE = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}`;
  const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF" };
  const FIX = { WSH: "WAS" }; // ESPN abbreviation -> ours
  const sched0 = await getJSON(`${BASE}?view=proTeamSchedules_wl`);
  const teams = ((sched0.settings && sched0.settings.proTeams) || []).filter(t => t.id > 0);
  if (teams.length < 30) throw new Error(`schedule has only ${teams.length} teams`);
  const ab = {}; for (const t of teams) { const a = String(t.abbrev).toUpperCase(); ab[t.id] = FIX[a] || a; }
  const rat = await getJSON(`${BASE}/segments/0/leaguedefaults/3?view=mPositionalRatingsStats`);
  const pr = (rat.positionAgainstOpponent || {}).positionalRatings || {};
  const ranks = {};
  for (const [pid, pos] of Object.entries(POS)) { ranks[pos] = {};
    for (const [tid, v] of Object.entries((pr[pid] || {}).ratingsByOpponent || {})) if (ab[tid] && v.rank) ranks[pos][ab[tid]] = v.rank; }
  if (Object.keys(ranks.RB).length < 30) throw new Error("ESPN matchup ratings missing");
  const sched = {}; const cutoff = Date.now() - 14 * 86400e3;
  for (const t of teams) { sched[ab[t.id]] = [];
    for (const [wk, games] of Object.entries(t.proGamesByScoringPeriod || {})) for (const g of games) {
      if (+wk > 17 || (g.date || 0) < cutoff) continue;
      const opp = g.homeProTeamId === t.id ? g.awayProTeamId : g.homeProTeamId;
      if (ab[opp]) sched[ab[t.id]].push([+wk, ab[opp], g.date]); }
    sched[ab[t.id]].sort((a, b) => a[0] - b[0]); }
  return { ranks, sched };
}

let off, kd, ok = true;
try { off = await offense(); } catch (e) { console.warn("Offense kept from last run:", e.message); off = prevOf(["QB", "RB", "WR", "TE"]); ok = false; }
try { kd = await kdef(); } catch (e) { console.warn("K/DEF kept from last run:", e.message); kd = prevOf(["K", "DEF"]); }
if (!off.length) throw new Error("No offensive values available; leaving values.json unchanged.");

off.sort((a, b) => b[4][4] - a[4][4]);
const sleeper = { ...(prev.sleeper || {}), ...SLEEPER };
let matchups = prev.matchups || null, matchupsUpdated = prev.matchupsUpdated || null;
try { const season = new Date().getMonth() < 2 ? new Date().getFullYear() - 1 : new Date().getFullYear(); matchups = await buildMatchups(season, getJSON); matchupsUpdated = new Date().toISOString(); }
catch (e) { console.warn("Matchups kept from last run:", e.message); }
const out = { sleeper, matchups, matchupsUpdated, updated: ok ? new Date().toISOString() : prev.updated || new Date().toISOString(), source: "FantasyCalc (QB/RB/WR/TE), Sleeper projections (K/DEF)", players: [...off, ...kd] };
await writeFile(OUT, JSON.stringify(out));
console.log(`Wrote ${out.players.length} players (${off.length} offense, ${kd.length} K/DEF).`);
