// Cloudflare Worker: lets the Trade Desk page read a PUBLIC ESPN fantasy football league.
// ESPN's API blocks direct browser requests, so the page calls this Worker instead.
// Usage: GET https://<your-worker>.workers.dev/?league=123456&season=2026
// Private leagues don't come through here any more: the "Send to Trade Desk" bookmark reads them
// on ESPN's own site. This Worker never receives anyone's ESPN login.

const ALLOWED_ORIGINS = [
  "https://trade-desk.win",
  "https://www.trade-desk.win",
  "https://caddyshackk.github.io",
  "http://localhost:5500",   // VS Code Live Server, for local testing
  "http://127.0.0.1:5500",
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : "null",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    // Security: only answer the Trade Desk site. Other websites (and most bots) are refused.
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "Not allowed" }, 403, cors);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // Security: rate limit each visitor (configured in wrangler.toml as LIMITER).
    if (env.LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return json({ error: "Too many requests" }, 429, { ...cors, "Retry-After": "60" });
    }
    if (request.method !== "GET") return json({ error: "GET only" }, 405, cors);

    const url = new URL(request.url);
    const league = url.searchParams.get("league") || "";
    const season = url.searchParams.get("season") || String(new Date().getFullYear());
    if (!/^\d{1,12}$/.test(league) || !/^\d{4}$/.test(season)) return json({ error: "Bad league or season" }, 400, cors);

    // No cookies are sent, so ESPN only returns public leagues. Safe to cache for 5 minutes.
    const api = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league}?view=mTeam&view=mRoster&view=mSettings`;
    const r = await fetch(api, {
      headers: { Accept: "application/json", "User-Agent": "trade-desk-proxy" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    return new Response(r.body, {
      status: r.status,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  },
};

function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
