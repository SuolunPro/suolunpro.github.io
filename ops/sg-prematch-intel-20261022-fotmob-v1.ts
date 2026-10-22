import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  db: { schema: "ninety_core" }, auth: { persistSession: false, autoRefreshToken: false }
});
const bjtDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const official = (side: string, player: any) => {
  const type = String(player?.unavailability?.type ?? "unknown");
  const state = type === "injury" ? "伤病名单" : type === "suspension" ? "停赛名单" : "缺阵/待确认名单";
  const until = String(player?.unavailability?.expectedReturn ?? "").trim();
  return side + " " + String(player?.name ?? "").trim() + "：" + state + (until ? "；FotMob预计状态 " + until : "");
};
async function readDetails(mid: number) {
  const url = "https://www.fotmob.com/api/data/matchDetails?matchId=" + mid;
  const r = await fetch(url, { headers: { "accept": "application/json", "user-agent": "Mozilla/5.0", "cache-control": "no-cache" }, signal: AbortSignal.timeout(13000) });
  if (!r.ok) throw new Error("FOTMOB_HTTP_" + r.status);
  const body = await r.text();
  if (body.length > 1500000) throw new Error("FOTMOB_OVERSIZE");
  return { url, data: JSON.parse(body) };
}
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return respond({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  const token = req.headers.get("x-ninety-collector-token") ?? "";
  if (token.length < 32) return respond({ ok: false, error: "UNAUTHORIZED" }, 401);
  const auth = await db.rpc("soren_collector_token_valid_v1", { p_token: token });
  if (auth.error || auth.data !== true) return respond({ ok: false, error: "UNAUTHORIZED" }, 401);
  try {
    const input = await req.json().catch(() => ({}));
    const date = String(input.date ?? bjtDate());
    if (date !== bjtDate()) return respond({ ok: false, error: "CURRENT_DAY_ONLY" }, 400);
    const dry = input.dry_run === true;
    const now = Date.now(), nowIso = new Date(now).toISOString();
    const day = new Date(date + "T12:00:00+08:00").getUTCDay();
    const sale = Date.parse(date + "T" + ([0,6].includes(day) ? "23" : "22") + ":00:00+08:00");
    const { data: matches, error: me } = await db.from("soren_matches")
      .select("id,pool_date,match_no,home_team,away_team,kickoff_at,cutoff_at,is_world_cup")
      .eq("pool_date", date).eq("is_world_cup", false).gt("kickoff_at", nowIso).limit(100);
    if (me) throw me;
    const eligible = (matches ?? []).filter((m: any) => now < Math.min(Date.parse(m.kickoff_at), m.cutoff_at ? Date.parse(m.cutoff_at) : Infinity, sale) - 600000);
    const keys = eligible.map((m: any) => date.replaceAll("-", "") + "-" + String(m.match_no).padStart(3, "0"));
    const { data: maps, error: ee } = keys.length
      ? await db.from("elo_match_scores").select("match_key,fotmob_match_id,home_team_id,away_team_id").in("match_key", keys)
      : { data: [], error: null };
    if (ee) throw ee;
    const mapping = new Map((maps ?? []).map((x: any) => [x.match_key, x]));
    const findings: any[] = [], failures: any[] = [];
    for (let i = 0; i < eligible.length; i += 4) {
      const batch = await Promise.all(eligible.slice(i, i + 4).map(async (m: any) => {
        const key = date.replaceAll("-", "") + "-" + String(m.match_no).padStart(3, "0");
        const e: any = mapping.get(key);
        if (!e?.fotmob_match_id || !e?.home_team_id || !e?.away_team_id) return { no: m.match_no, status: "NO_EXACT_FOTMOB_MAPPING" };
        try {
          const { url, data: j } = await readDetails(Number(e.fotmob_match_id));
          const g = j?.general, lineup = j?.content?.lineup;
          const kickoff = Date.parse(String(m.kickoff_at));
          if (Number(g?.matchId) !== Number(e.fotmob_match_id) ||
              Number(g?.homeTeam?.id) !== Number(e.home_team_id) ||
              Number(g?.awayTeam?.id) !== Number(e.away_team_id) ||
              Math.abs(Date.parse(String(g?.matchTimeUTCDate)) - kickoff) > 60000 ||
              g?.started === true || g?.finished === true || j?.header?.status?.started === true)
            return { no: m.match_no, status: "IDENTITY_OR_PREMATCH_REJECTED" };
          const home = Array.isArray(lineup?.homeTeam?.unavailable) ? lineup.homeTeam.unavailable : [];
          const away = Array.isArray(lineup?.awayTeam?.unavailable) ? lineup.awayTeam.unavailable : [];
          const items = [...home.map((x: any) => official("主队", x)), ...away.map((x: any) => official("客队", x))]
            .filter((x: string) => x.length >= 10 && x.length <= 300).slice(0, 30);
          if (!items.length) return { no: m.match_no, status: "NO_UNAVAILABLE_PLAYERS", source: url };
          const observedAt = new Date().toISOString();
          if (Date.parse(observedAt) >= Math.min(kickoff, sale, m.cutoff_at ? Date.parse(m.cutoff_at) : Infinity))
            return { no: m.match_no, status: "FROZEN_DURING_FETCH" };
          if (!dry) {
            const { error } = await db.from("soren_intelligence_reports_v1").upsert({
              match_id: m.id, pool_date: m.pool_date, match_no: String(m.match_no).padStart(3, "0"),
              home_team: m.home_team, away_team: m.away_team,
              source_code: "fotmob_match_unavailable_public", source_url: url,
              headline: "赛前伤停名单（FotMob，非本场确认首发）",
              published_at: null, fetched_at: observedAt,
              quality: "fotmob_exact_fixture_prematch_unavailable_first_observed",
              highlights: items
            }, { onConflict: "match_id,source_url", ignoreDuplicates: true });
            if (error) throw error;
          }
          return { no: m.match_no, status: dry ? "DRY_VERIFIED" : "VERIFIED_FIRST_SNAPSHOT", source: url,
            unavailable: items.length, lineupType: lineup?.lineupType ?? null, observedAt };
        } catch (error) { return { no: m.match_no, status: "FETCH_OR_STORE_ERROR", error: String(error).slice(0, 120) }; }
      }));
      for (const item of batch) (item.status === "FETCH_OR_STORE_ERROR" ? failures : findings).push(item);
    }
    const matched = findings.filter(x => x.status === "DRY_VERIFIED" || x.status === "VERIFIED_FIRST_SNAPSHOT").length;
    if (!dry) {
      const { error: logError } = await db.from("ingest_runs").insert({
        source_name: "soren_fotmob_prematch_unavailable_v1",
        status: failures.length || (eligible.length && matched === 0) ? "partial" : "completed",
        started_at: nowIso, finished_at: new Date().toISOString(),
        summary: { candidate_matches: eligible.length, exact_fixture_matches: matched,
          unavailable_players: findings.reduce((n, x) => n + (x.unavailable ?? 0), 0),
          failures: failures.length, missing_mapping: findings.filter(x => x.status === "NO_EXACT_FOTMOB_MAPPING").length }
      });
      if (logError) console.error("FOTMOB_INTEL_AUDIT_FAILED", logError.code);
    }
    return respond({ ok: failures.length === 0, dry, date, candidates: eligible.length, exactMatches: matched,
      findings, failures, policy: "immutable first observed injury snapshot; no confirmed current lineup inferred from lastStarting11" }, failures.length ? 207 : 200);
  } catch (error) {
    console.error("FOTMOB_PREMATCH_INTEL_ERROR", error);
    return respond({ ok: false, error: "FOTMOB_PREMATCH_INTEL_FAILED" }, 503);
  }
});
