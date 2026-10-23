import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.95.0';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { db: { schema: 'ninety_core' }, auth: { persistSession: false, autoRefreshToken: false } });
const bjtDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const num = (x: unknown) => Number(x);
const fixtures = (j: any) => j?.fixtures?.allFixtures?.fixtures ?? [];
async function getJson(url: string) {
  let last: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('FOTMOB_HTTP_' + r.status);
      const text = await r.text();
      if (text.length > 2500000) throw new Error('FOTMOB_RESPONSE_OVERSIZE');
      return JSON.parse(text);
    } catch (e) { last = e; }
  }
  throw last;
}
function xgPair(v: any): [number, number] | null {
  if (!v) return null;
  if (Array.isArray(v)) { for (const x of v) { const p = xgPair(x); if (p) return p; } return null; }
  if (typeof v !== 'object') return null;
  if (v.key === 'expected_goals' && Array.isArray(v.stats) && v.stats.length >= 2) {
    const h = num(v.stats[0]), a = num(v.stats[1]);
    if (Number.isFinite(h) && Number.isFinite(a) && h >= 0 && a >= 0 && h <= 15 && a <= 15) return [h, a];
  }
  for (const key of Object.keys(v)) { const p = xgPair(v[key]); if (p) return p; }
  return null;
}
Deno.serve(async (req) => {
  if (req.method !== 'POST') return Response.json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  const token = req.headers.get('x-ninety-collector-token') ?? '';
  if (token.length < 32 || (await db.rpc('soren_collector_token_valid_v1', { p_token: token })).data !== true)
    return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const input = await req.json().catch(() => ({}));
    const date = String(input.date ?? bjtDate());
    if (date !== bjtDate()) return Response.json({ ok: false, error: 'CURRENT_DAY_ONLY' }, { status: 400 });
    const now = Date.now();
    const dow = new Date(date + 'T12:00:00+08:00').getUTCDay();
    const sale = Date.parse(date + 'T' + ([0, 6].includes(dow) ? '23' : '22') + ':00:00+08:00');
    const { data: matches, error: me } = await db.from('soren_matches')
      .select('id,pool_date,match_no,home_team,away_team,kickoff_at,cutoff_at,source_status,is_world_cup')
      .eq('pool_date', date).eq('is_world_cup', false).gt('kickoff_at', new Date().toISOString());
    if (me) throw me;
    const active = (matches ?? []).filter((m: any) => (m.source_status?.pool_status === 'ACTIVE' || m.source_status?.source === 'sg_local_hj38_offerings') &&
      now < Math.min(Date.parse(m.kickoff_at) - 600000, sale, m.cutoff_at ? Date.parse(m.cutoff_at) : Infinity));
    if (!active.length) return Response.json({ ok: true, date, eligible: 0, status: 'SALE_OR_KICKOFF_FROZEN' });
    const requested = String(input.match_no ?? '');
    const m = requested ? active.find((x: any) => String(x.match_no).padStart(3, '0') === requested.padStart(3, '0'))
      : active[Math.floor(now / 120000) % active.length];
    if (!m) return Response.json({ ok: true, date, status: 'MATCH_NOT_ELIGIBLE_OR_FROZEN', requested });
    const key = date.replaceAll('-', '') + '-' + String(m.match_no).padStart(3, '0');
    const { data: e, error: ee } = await db.from('elo_match_scores')
      .select('fotmob_match_id,home_team_id,away_team_id,league_id,season_label').eq('match_key', key).maybeSingle();
    if (ee) throw ee;
    if (!e?.fotmob_match_id || !e?.home_team_id || !e?.away_team_id || !e?.league_id || !e?.season_label)
      return Response.json({ ok: true, date, match_no: m.match_no, status: 'INSUFFICIENT_EXACT_FOTMOB_MAPPING' });
    // Verify the target fixture is genuinely still prematch before collecting inputs.
    const current = await getJson('https://www.fotmob.com/api/data/matchDetails?matchId=' + e.fotmob_match_id);
    const g = current?.general;
    if (num(g?.matchId) !== num(e.fotmob_match_id) || num(g?.homeTeam?.id) !== num(e.home_team_id) ||
        num(g?.awayTeam?.id) !== num(e.away_team_id) ||
        Math.abs(Date.parse(String(g?.matchTimeUTCDate)) - Date.parse(m.kickoff_at)) > 60000 ||
        g?.started === true || g?.finished === true || current?.header?.status?.started === true)
      return Response.json({ ok: false, date, match_no: m.match_no, status: 'IDENTITY_OR_PREMATCH_REJECTED' }, { status: 409 });
    const [home, away] = await Promise.all([
      getJson('https://www.fotmob.com/api/data/teams?id=' + e.home_team_id),
      getJson('https://www.fotmob.com/api/data/teams?id=' + e.away_team_id)
    ]);
    const country = String(home?.details?.country ?? '');
    let league: any = null, leagueError: string | null = null;
    try {
      league = await getJson(`https://www.fotmob.com/api/data/leagues?id=${e.league_id}&season=${encodeURIComponent(e.season_label)}&ccode3=${encodeURIComponent(country)}`);
    } catch (error) { leagueError = String(error).slice(0, 100); }
    const leagueFixtures = league?.fixtures?.allMatches ?? [];
    const leagueIds = new Set(leagueFixtures.map((f: any) => num(f?.id)).filter(Number.isSafeInteger));
    const all = [...fixtures(home), ...fixtures(away), ...leagueFixtures];
    const candidates = new Map<number, any>();
    for (const f of all) {
      const id = num(f?.id), time = Date.parse(String(f?.status?.utcTime));
      if (!Number.isSafeInteger(id) || !Number.isFinite(time) ||
          !f?.status?.finished || f?.status?.cancelled ||
          time >= Math.min(Date.parse(m.kickoff_at), now - 90 * 60000)) continue;
      candidates.set(id, f);
    }
    const sorted = [...candidates.values()].sort((a, b) =>
      Date.parse(String(b.status.utcTime)) - Date.parse(String(a.status.utcTime))).slice(0, 100);
    const ids = sorted.map(x => num(x.id));
    const { data: cached, error: ce } = ids.length
      ? await db.from('soren_fotmob_xg_matches_v1').select('fotmob_match_id').in('fotmob_match_id', ids)
      : { data: [], error: null };
    if (ce) throw ce;
    const seen = new Set((cached ?? []).map((x: any) => num(x.fotmob_match_id)));
    const previouslyUnlabeled = [...seen].filter(id => leagueIds.has(id));
    if (previouslyUnlabeled.length) {
      const { error: le } = await db.from('soren_fotmob_xg_matches_v1')
        .update({ league_id: e.league_id, season_label: e.season_label })
        .is('league_id', null).in('fotmob_match_id', previouslyUnlabeled);
      if (le) throw le;
    }
    const limit = Math.min(Math.max(num(input.max_fetch ?? 16) || 16, 1), 24);
    const toFetch = sorted.filter(x => !seen.has(num(x.id))).slice(0, limit);
    let fetched = 0, missingXg = 0, failed = 0;
    for (let i = 0; i < toFetch.length; i += 4) {
      const batch = await Promise.all(toFetch.slice(i, i + 4).map(async (f: any) => {
        try {
          const j = await getJson('https://www.fotmob.com/api/data/matchDetails?matchId=' + f.id);
          const p = xgPair(j);
          if (!p) return 'missing';
          const details = j?.general;
          const homeId = num(f?.home?.id), awayId = num(f?.away?.id);
          if (num(details?.matchId) !== num(f.id) || num(details?.homeTeam?.id) !== homeId ||
              num(details?.awayTeam?.id) !== awayId || details?.finished !== true && j?.header?.status?.finished !== true)
            return 'failed';
          const fetchedAt = new Date().toISOString();
          if (Date.parse(fetchedAt) >= Math.min(Date.parse(m.kickoff_at), sale, m.cutoff_at ? Date.parse(m.cutoff_at) : Infinity))
            return 'failed';
          const lid = leagueIds.has(num(f.id)) ? num(e.league_id) : num(f?.tournament?.leagueId);
          const { error } = await db.from('soren_fotmob_xg_matches_v1').upsert({
            fotmob_match_id: num(f.id), league_id: Number.isSafeInteger(lid) && lid > 0 ? lid : null,
            season_label: lid === num(e.league_id) ? e.season_label : null,
            utc_time: f.status.utcTime, home_team_id: homeId, away_team_id: awayId,
            home_xg: p[0], away_xg: p[1],
            source_url: 'https://www.fotmob.com/api/data/matchDetails?matchId=' + f.id,
            fetched_at: fetchedAt
          }, { onConflict: 'fotmob_match_id', ignoreDuplicates: true });
          if (error) throw error;
          return 'fetched';
        } catch { return 'failed'; }
      }));
      for (const status of batch) { if (status === 'fetched') fetched++; else if (status === 'missing') missingXg++; else failed++; }
    }
    const { data: refresh, error: re } = await db.rpc('soren_refresh_fotmob_score_v1', { p_date: date });
    if (re) throw re;
    const summary = { date, match_no: m.match_no, candidates: sorted.length, cached: seen.size,
      fetched, missing_xg: missingXg, failed, league_error: leagueError, refresh };
    await db.from('ingest_runs').insert({ source_name: 'soren_fotmob_xg_strict_prematch_v1',
      started_at: new Date(now).toISOString(), finished_at: new Date().toISOString(),
      status: failed || leagueError ? 'partial' : 'completed', summary });
    return Response.json({ ok: failed === 0, ...summary });
  } catch (error) {
    console.error('SOREN_FOTMOB_XG_ERROR', error);
    return Response.json({ ok: false, error: String(error).slice(0, 200) }, { status: 503 });
  }
});
