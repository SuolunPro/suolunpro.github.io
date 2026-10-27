import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store",
};
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers });
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") return respond({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  const jwt = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) return respond({ ok: false, error: "LOGIN_REQUIRED" }, 401);
  const auth = await db.auth.getUser(jwt);
  if (auth.error || !auth.data.user) return respond({ ok: false, error: "LOGIN_REQUIRED" }, 401);
  const user = auth.data.user;
  const admin = user.app_metadata?.role === "admin" || user.app_metadata?.is_admin === true;
  const member = await db.rpc("ninety_membership_status", { p_user_id: user.id });
  if (member.error) return respond({ ok: false, error: "MEMBERSHIP_STATUS_UNAVAILABLE" }, 503);
  const vip = admin || (member.data?.active === true &&
    ["vip_monthly", "vip_manual", "admin"].includes(String(member.data?.tier)));
  if (!vip) return respond({ ok: false, error: "VIP_REQUIRED" }, 403);

  const url = new URL(req.url);
  const date = url.searchParams.get("date") || "";
  const no = url.searchParams.get("no") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,3}$/.test(no))
    return respond({ ok: false, error: "INVALID_MATCH" }, 400);
  const fixture = await db.schema("ninety_core").from("soren_matches")
    .select("id,home_team,away_team,kickoff_at").eq("pool_date", date)
    .eq("match_no", no.padStart(3, "0")).maybeSingle();
  if (fixture.error) return respond({ ok: false, error: "MATCH_UNAVAILABLE" }, 503);
  if (!fixture.data) return respond({ ok: false, error: "MATCH_NOT_FOUND" }, 404);

  const snapshots = await db.schema("ninety_core").from("soren_market_snapshots")
    .select("home_value,draw_value,away_value,captured_at")
    .eq("match_id", fixture.data.id).eq("source_code", "zucaijia_william")
    .eq("market_type", "FT_1X2").eq("snapshot_type", "current")
    .eq("data_quality", "verified").order("captured_at", { ascending: true }).limit(100);
  if (snapshots.error) return respond({ ok: false, error: "MARKET_UNAVAILABLE" }, 503);
  const kickoff = Date.parse(fixture.data.kickoff_at);
  const points = (snapshots.data || []).flatMap((r) => {
    const at = Date.parse(r.captured_at);
    const [home, draw, away] = [r.home_value, r.draw_value, r.away_value].map(Number);
    if (!Number.isFinite(at) || at >= kickoff || at > Date.now() ||
      [home, draw, away].some((v) => !Number.isFinite(v) || v <= 1 || v > 100)) return [];
    return [{ at: r.captured_at, home, draw, away }];
  });
  return respond({ ok: true, trend: { home: fixture.data.home_team,
    away: fixture.data.away_team, points } });
});
