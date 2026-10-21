// Cloudflare Worker: lets the Trade Desk page read an ESPN fantasy football league.
// ESPN's API blocks direct browser requests, so the page calls this Worker instead.
// Usage: GET https://<your-worker>.workers.dev/?league=123456&season=2026
// Private leagues: add ESPN_S2 and SWID as Worker secrets (never put them in the page or repo).

const ALLOWED_ORIGINS = [
  "https://caddyshackk.github.io",
  "http://localhost:5500",   // VS Code Live Server, for local testing
  "http://127.0.0.1:5500",
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return json({ error: "GET only" }, 405, cors);

    const url = new URL(request.url);
    const league = url.searchParams.get("league") || "";
    const season = url.searchParams.get("season") || String(new Date().getFullYear());
    if (!/^\d{1,12}$/.test(league) || !/^\d{4}$/.test(season)) return json({ error: "Bad league or season" }, 400, cors);

    const api = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league}?view=mTeam&view=mRoster&view=mSettings`;
    const headers = { Accept: "application/json", "User-Agent": "trade-desk-proxy" };
    if (env.ESPN_S2 && env.SWID) headers.Cookie = `espn_s2=${env.ESPN_S2}; SWID=${env.SWID}`;

    const r = await fetch(api, { headers, cf: { cacheTtl: 300, cacheEverything: true } });
    return new Response(r.body, {
      status: r.status,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    });
  },
};

function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
