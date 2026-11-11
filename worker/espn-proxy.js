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
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : "null",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "X-ESPN-S2, X-ESPN-SWID",
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

    // Viewer's own login first; your Worker secrets as a fallback.
    const userS2 = request.headers.get("X-ESPN-S2") || "";
    const userSwid = request.headers.get("X-ESPN-SWID") || "";
    const hasUser = userS2 && userSwid;
    if (hasUser && (!/^[A-Za-z0-9%+/=_.\-]{20,2048}(,[A-Za-z0-9%+/=_.\-]{20,2048}){0,3}$/.test(userS2) || !/^\{[0-9A-Fa-f-]{36}\}$/.test(userSwid))) {
      return json({ error: "Bad ESPN login format" }, 400, cors);
    }
    const rawS2 = hasUser ? userS2 : env.ESPN_S2;
    const swid = hasUser ? userSwid : env.SWID;
    // espn_s2 can arrive URL-encoded (…%2B…%3D) or decoded (…+…=) depending on how it was copied.
    // Send it exactly as given first; if ESPN says "not authorized", retry once with the other form.
    // ESPN sometimes leaves more than one espn_s2 cookie; the bookmark sends them all, comma-separated.
    // Try each one as given, then each in the other encoding, until ESPN accepts one.
    const flip = v => { try { return v.includes("%") ? decodeURIComponent(v) : encodeURIComponent(v); } catch (e) { return ""; } };
    const base = String(rawS2 || "").split(",").filter(Boolean);
    const tries = [...base, ...base.map(flip)].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 8);
    const api = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league}?view=mTeam&view=mRoster&view=mSettings`;
    const get = s2 => {
      const headers = { Accept: "application/json", "User-Agent": "trade-desk-proxy" };
      if (s2 && swid) headers.Cookie = `espn_s2=${s2}; SWID=${swid}`;
      // Never cache a response fetched with a viewer's login: the cache is keyed by URL only,
      // so a cached private league would be served to anyone asking for the same league ID.
      return fetch(api, hasUser ? { headers, cf: { cacheTtl: 0, cacheEverything: false } } : { headers, cf: { cacheTtl: 300, cacheEverything: true } });
    };
    let r = await get(tries[0]);
    let attempts = 1;
    while ((r.status === 401 || r.status === 403) && attempts < tries.length) { r = await get(tries[attempts]); attempts++; }
    return new Response(r.body, {
      status: r.status,
      // X-Trade-Desk-Login: whether a login was sent and how many cookie formats were tried (no secrets).
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": hasUser ? "private, no-store" : "public, max-age=300", "X-Trade-Desk-Login": `${hasUser ? "user" : swid ? "secret" : "none"};tries=${attempts}`, "Access-Control-Expose-Headers": "X-Trade-Desk-Login" },
    });
  },
};

function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
