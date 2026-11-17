import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const env = (name: string) => Deno.env.get(name) ?? "";
const service = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const origin = env("WP_SITE_ORIGIN");
const site = env("WP_SITE_URL");
const cloudflareSite = env("WP_CLOUDFLARE_SITE_URL");
const cloudflareOrigin = cloudflareSite ? new URL(cloudflareSite).origin : "";
const key = env("SUPABASE_ANON_KEY");

function response(data: unknown, code = 200, cors: string | null = null) {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(cors ? { "Access-Control-Allow-Origin": cors, "Vary": "Origin" } : {}),
    },
  });
}

async function digest(secret: string, value: string) {
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", signature, encoder.encode(value));
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function equal(left: string, right: string) {
  const encoder = new TextEncoder();
  const l = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(left)));
  const r = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(right)));
  let different = 0;
  for (let i = 0; i < l.length; i++) different |= l[i] ^ r[i];
  return different === 0;
}

async function traffic(req: Request, cors: string) {
  const secret = env("WP_ANALYTICS_SECRET");
  if (!secret) return response({ error: "Analytics setup is pending." }, 503, cors);
  if (Number(req.headers.get("content-length")) > 8192) return response({}, 413, cors);
  const body = await req.text();
  if (body.length > 8192) return response({}, 413, cors);
  const { visit, route, language, source, event } = JSON.parse(body);
  if (typeof visit !== "string" || !/^[0-9a-f-]{36}$/.test(visit)
      || typeof route !== "string" || route.length > 140
      || !/^(|about\/|stories\/|newsletter\/|contribute\/|archive\/([0-9]{16,22}\/)?|articles\/[a-z0-9-]+\/)$/.test(route)
      || !["ar", "en"].includes(language) || !["view", "engaged"].includes(event)
      || !["direct", "internal", "search", "social", "newsletter", "referral"].includes(source)) {
    return response({ error: "Invalid event." }, 400, cors);
  }
  const day = new Date().toISOString().slice(0, 10);
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "unknown";
  const client = await digest(secret, day + "|ip|" + ip);
  const limit = await service.rpc("wp_limit", { _client: client, _limit: 90 });
  if (limit.error) throw new Error("Rate limiter unavailable");
  if (!limit.data) return response({ error: "Rate limited." }, 429, cors);
  const result = await service.rpc("wp_record", {
    _visitor: await digest(secret, day + "|visit|" + visit),
    _route: route,
    _language: language, _source: source, _event: event,
  });
  if (result.error) throw new Error("Traffic event failed");
  return response({ ok: true }, 202, cors);
}

async function exportSite(req: Request) {
  const secret = env("WP_EXPORT_TOKEN");
  const readOnlySecret = env("WP_CLOUDFLARE_EXPORT_TOKEN");
  const authorization = req.headers.get("Authorization") ?? "";
  const canPublish = Boolean(secret && await equal(authorization, "Bearer " + secret));
  if (!canPublish && (!readOnlySecret || !await equal(authorization, "Bearer " + readOnlySecret))) {
    return response({ error: "Unauthorized." }, 401);
  }
  if (canPublish) {
    const scheduled = await service.rpc("wp_due");
    if (scheduled.error) throw new Error("Scheduled publication check failed");
  }
  const rows = [];
  for (let start = 0;; start += 500) {
    const result = await service.from("wp_live").select("route,visible,passthrough,payload,published_at,updated_at").order("route").range(start, start + 499);
    if (result.error) throw new Error("Publication export failed");
    rows.push(...result.data.map((row) => row.visible ? row : { ...row, payload: null }));
    if (result.data.length < 500) break;
  }
  const assetNames = [...new Set(rows.filter((row) => row.visible).map((row) => row.payload?.cover).filter((cover) => cover?.includes("/")))];
  const assets: Record<string, string> = {};
  for (const asset of assetNames) {
    const result = await service.storage.from("editorial-assets").createSignedUrl(asset, 900);
    if (result.error || !result.data) throw new Error("Published cover unavailable");
    assets[asset] = result.data.signedUrl;
  }
  return response({ rows, assets });
}

async function beehiiv(req: Request, url: URL, cors: string) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return response({ error: "Sign in first." }, 401, cors);
  const user = createClient(env("SUPABASE_URL"), key, { global: { headers: { Authorization: auth } } });
  const session = await user.auth.getUser();
  const staff = session.data.user?.email_confirmed_at && await user.rpc("wp_is_staff");
  if (!staff || staff.error || !staff.data) return response({ error: "Staff access required." }, 403, cors);
  const limit = await service.rpc("wp_limit", { _client: "beehiiv:" + session.data.user?.id, _limit: 4 });
  if (limit.error || !limit.data) return response({ error: "Try again in a minute." }, 429, cors);
  const apiKey = env("BEEHIIV_API_KEY");
  const publication = env("BEEHIIV_PUBLICATION_ID");
  if (!apiKey || !/^pub_[a-f0-9-]+$/i.test(publication)) {
    return response({ error: "Beehiiv reporting credentials are missing." }, 503, cors);
  }
  const days = Number(url.searchParams.get("days") ?? 30);
  if (![7, 30, 90].includes(days)) return response({ error: "Invalid date range." }, 400, cors);
  const since = Date.now() / 1000 - (days * 86_400);
  const groups: Record<string, number> = {};
  let signups = 0;
  let websiteSignups = 0;
  let siteAttribution = false;
  let cursor = "";
  let complete = false;
  for (let i = 0; i < 35; i++) {
    const target = new URL(`https://api.beehiiv.com/v2/publications/${publication}/subscriptions`);
    target.search = new URLSearchParams({ limit: "100", direction: "desc" }).toString();
    if (cursor) target.searchParams.set("cursor", cursor);
    const data = await fetch(target, { headers: { Authorization: "Bearer " + apiKey }, signal: AbortSignal.timeout(5000) });
    if (!data.ok) return response({ error: "Beehiiv reporting request failed.", status: data.status }, 502, cors);
    const result = await data.json();
    if (!Array.isArray(result.data)) throw new Error("Unexpected Beehiiv response");
    for (const subscriber of result.data) {
      if (subscriber.created < since) {
        complete = true;
        break;
      }
      signups++;
      const status = String(subscriber.status ?? "unknown");
      groups[status] = (groups[status] ?? 0) + 1;
      const referrer = String(subscriber.referring_site ?? "");
      const attributed = String(subscriber.utm_campaign ?? "") === "without_permission_site"
        || [site, cloudflareSite].some((url) => url && referrer.startsWith(url));
      if (attributed) {
        websiteSignups++;
        siteAttribution = true;
      }
    }
    cursor = result.pagination?.next_cursor ?? result.next_cursor ?? "";
    if (!cursor || complete) {
      complete = true;
      break;
    }
  }
  return response({ signups, websiteSignups: siteAttribution ? websiteSignups : null, groups, complete }, 200, cors);
}

Deno.serve(async (req) => {
  const pageOrigin = req.headers.get("Origin");
  const cors = pageOrigin && (pageOrigin === origin || pageOrigin === cloudflareOrigin) ? pageOrigin : null;
  const url = new URL(req.url);
  const path = url.pathname.split("/").at(-1);
  if (req.method === "OPTIONS" && cors) {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": cors,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "authorization,content-type",
        "Vary": "Origin",
      },
    });
  }
  try {
    if (path === "export" && req.method === "GET") return await exportSite(req);
    if (!cors) return response({ error: "Origin not allowed." }, 403);
    if (path === "traffic" && req.method === "POST") return await traffic(req, cors);
    if (path === "newsletter" && req.method === "GET") return await beehiiv(req, url, cors);
    return response({ error: "Not found." }, 404, cors);
  } catch (error) {
    console.error(error instanceof SyntaxError ? "Invalid request" : "Platform request failed", path);
    return response({ error: "Request could not be completed." }, error instanceof SyntaxError ? 400 : 502, cors);
  }
});
