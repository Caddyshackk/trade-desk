// Cloudflare Worker: lets the Trade Desk page read an ESPN fantasy football league.
// ESPN's API blocks direct browser requests, so the page calls this Worker instead.
// Usage: GET https://<your-worker>.workers.dev/?league=123456&season=2026
// Private leagues: the page sends the viewer's own espn_s2/SWID in X-ESPN-S2 / X-ESPN-SWID headers.
// They are forwarded to ESPN for that one request and never logged or stored.
// Optional fallback for your own leagues: ESPN_S2 and SWID as Worker secrets.

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
      "Access-Control-Allow-Headers": "X-ESPN-S2, X-ESPN-SWID",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return json({ error: "GET only" }, 405, cors);

    const url = new URL(request.url);
    const league = url.searchParams.get("league") || "";
    const season = url.searchParams.get("season") || String(new Date().getFullYear());
    if (!/^\d{1,12}$/.test(league) || !/^\d{4}$/.test(season)) return json({ error: "Bad league or season" }, 400, cors);

    // Viewer's own login first; your Worker secrets as a fallback.
    const userS2 = request.headers.get("X-ESPN-S2") || "";
    const userSwid = request.headers.get("X-ESPN-SWID") || "";
    const hasUser = userS2 && userSwid;
    if (hasUser && (!/^[A-Za-z0-9%+/=_.\-]{20,2048}$/.test(userS2) || !/^\{[0-9A-Fa-f-]{36}\}$/.test(userSwid))) {
      return json({ error: "Bad ESPN login format" }, 400, cors);
    }
    // ESPN stores espn_s2 URL-encoded (…%2B…%3D). Chrome's cookie viewer can show it decoded (…+…=),
    // which ESPN rejects, so re-encode any decoded copy.
    const fixS2 = v => (v && !v.includes("%") && /[+/=]/.test(v) ? encodeURIComponent(v) : v);
    const s2 = fixS2(hasUser ? userS2 : env.ESPN_S2);
    const swid = hasUser ? userSwid : env.SWID;

    const api = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league}?view=mTeam&view=mRoster&view=mSettings`;
    const headers = { Accept: "application/json", "User-Agent": "trade-desk-proxy" };
    if (s2 && swid) headers.Cookie = `espn_s2=${s2}; SWID=${swid}`;

    // Never cache a response fetched with a viewer's login: the cache is keyed by URL only,
    // so a cached private league would be served to anyone asking for the same league ID.
    const r = await fetch(api, hasUser ? { headers, cf: { cacheTtl: 0, cacheEverything: false } } : { headers, cf: { cacheTtl: 300, cacheEverything: true } });
    return new Response(r.body, {
      status: r.status,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": hasUser ? "private, no-store" : "public, max-age=300" },
    });
  },
};

function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
