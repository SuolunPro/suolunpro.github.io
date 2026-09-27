create or replace function public.soren_fast_archive_bundle_v2(p_date date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with expected as (
  select count(*)::int as n from public.soren_matches where pool_date = p_date
),
locked as (
  select count(*)::int as n
  from public.soren_sale_freezes_v1
  where pool_date = p_date and locked_at is not null and snapshot is not null
),
latest as (
  select distinct on (u.match_no)
    u.match_id,u.match_no,u.snapshot,u.source_frozen_at,u.captured_at,
    m.home_team,m.away_team,m.kickoff_at,m.official_handicap
  from public.soren_prematch_updates_v1 u
  join public.soren_matches m on m.id=u.match_id and m.pool_date=p_date
  where u.pool_date=p_date and u.snapshot is not null
    and u.source_frozen_at<m.kickoff_at and u.captured_at<m.kickoff_at
    and coalesce((u.snapshot->>'pregameVerified')::boolean,false)=true
  order by u.match_no,u.source_frozen_at desc,u.captured_at desc
),
base as (
  select l.*,
    case when nullif(l.snapshot->>'frozenAt','') is not null
      then (l.snapshot->>'frozenAt')::timestamptz else l.source_frozen_at end as cut_at,
    case when coalesce(l.snapshot->'upsetWarning'->>'publish','false')='true'
      or coalesce(l.snapshot->'upsetWarning'->>'displayTier','') in ('重点风险','强风险信号')
      then true else false end as risk_blocked,
    case when coalesce(l.snapshot->>'pregameVerified','false')='true'
      and upper(coalesce(l.snapshot->>'mode','')) in ('SINGLE','DOUBLE')
      and upper(coalesce(l.snapshot->>'tier','')) not in ('','PASS')
      and coalesce(l.snapshot->>'pass','false')<>'true'
      and not (
        coalesce(l.snapshot->'upsetWarning'->>'publish','false')='true'
        or coalesce(l.snapshot->'upsetWarning'->>'displayTier','') in ('重点风险','强风险信号')
      )
      then true else false end as core_pick,
    case when l.snapshot->>'confidence' ~ '^-?[0-9]+([.][0-9]+)?$'
      then (l.snapshot->>'confidence')::numeric else null end as confidence_num,
    case coalesce(l.snapshot->>'ftTop1','')
      when '主胜' then 'H' when 'H' then 'H' when '3' then 'H'
      when '平' then 'D' when 'D' then 'D' when '1' then 'D'
      when '客胜' then 'A' when 'A' then 'A' when '0' then 'A'
      else null end as top1_code
  from latest l
),
raw_rank as (
  select b.match_no,b.core_pick,b.risk_blocked,b.confidence_num,q.odds,
    row_number() over(order by b.confidence_num desc nulls last,q.odds asc,b.match_no asc) as rn
  from base b
  join lateral (
    select case b.top1_code when 'H' then ms.home_value when 'D' then ms.draw_value
      when 'A' then ms.away_value else null end::numeric as odds
    from public.soren_market_snapshots ms
    where ms.match_id=b.match_id and ms.source_code='zucaijia_william'
      and ms.market_type='FT_1X2' and ms.data_quality in ('verified','verified_mirror')
      and ms.snapshot_type='current' and ms.captured_at<=b.cut_at
      and coalesce(ms.ingested_at,ms.captured_at)<=b.cut_at
    order by ms.captured_at desc limit 1
  ) q on true
  where b.confidence_num is not null and q.odds between 1.45 and 1.75
),
supplements as (
  select match_no,rn,odds,confidence_num from raw_rank
  where rn<=3 and not core_pick and not risk_blocked
),
rows_out as (
  select jsonb_agg(
    b.snapshot
    || jsonb_build_object('predictionView','LATEST_PREMATCH_ONLY','prematchLastCapturedAt',b.captured_at)
    || case
      when b.core_pick then jsonb_build_object('dailySelectionTier','CORE','dailySelectionLabel','核心优选','dailySelectionMeta',null)
      when s.match_no is not null then jsonb_build_object(
        'dailySelectionTier','SUPPLEMENT','dailySelectionLabel','精选补充',
        'dailySelectionMeta',jsonb_build_object(
          'selectorVersion','DAILY-VALUE-v1.1-20260927','rank',s.rn,
          'williamTop1Odds',round(s.odds,2),'frozenAt',b.snapshot->>'frozenAt',
          'rule','William 1.45–1.75 · 日内Top3 · 非核心 · 风险过滤通过'
        )
      )
      else jsonb_build_object('dailySelectionTier',null,'dailySelectionLabel',null,'dailySelectionMeta',null)
    end
    order by b.match_no
  ) as rows
  from base b left join supplements s using(match_no)
),
result_rows as (
  select m.id as match_id,m.match_no,m.home_team,m.away_team,m.official_handicap,
    r.home_score,r.away_score,r.ft_result,r.handicap_result,r.result_source,r.verified,r.verified_at,r.raw_result
  from public.soren_matches m
  join public.soren_results r on r.match_id=m.id and r.verified=true
  where m.pool_date=p_date
),
live_score_latest as (
  select distinct on (match_no)
    id,match_no,market_at,base_frozen_at,computed_at,lambda_home,lambda_away,scores,input_manifest
  from public.soren_live_score_goals_v1
  where pool_date=p_date
  order by match_no,computed_at desc
)
select case
  when (select n from expected)>0
   and (select n from locked)=(select n from expected)
   and (select count(*) from latest)=(select n from expected)
  then jsonb_build_object(
    'rows',coalesce((select rows from rows_out),'[]'::jsonb),
    'results',coalesce((select jsonb_agg(to_jsonb(r) order by r.match_no) from result_rows r),'[]'::jsonb),
    'htftPublished',coalesce((select jsonb_agg(to_jsonb(h) order by h.match_no) from public.soren_htft_top4_v1 h where h.pool_date=p_date),'[]'::jsonb),
    'htftHistorical',coalesce((select jsonb_agg(to_jsonb(h) order by h.match_no) from public.soren_htft_top4_history_v1 h where h.pool_date=p_date),'[]'::jsonb),
    'liveScoreGoals',coalesce((select jsonb_agg(to_jsonb(s) order by s.match_no) from live_score_latest s),'[]'::jsonb),
    'liveHtft',coalesce((select jsonb_agg(to_jsonb(h) order by h.source_frozen_at desc) from public.soren_live_htft_v1 h where h.pool_date=p_date),'[]'::jsonb)
  )
  else null
end;
$$;

revoke all on function public.soren_fast_archive_bundle_v2(date) from public;
grant execute on function public.soren_fast_archive_bundle_v2(date) to service_role;
