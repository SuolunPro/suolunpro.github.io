-- DAILY-VALUE-v2.0 historical replay from SG formal prematch inputs.
-- Replay audits use actual reconstructed_at; they are not historical publications.
create or replace view ninety_core.soren_daily_legacy_replay_v1 with (security_invoker=true) as
with base as (
 select m.id match_id,m.pool_date,m.match_no,m.home_team,m.away_team,m.kickoff_at,m.official_handicap,p.id prediction_id,p.run_id,p.frozen_at,p.ft_top1,p.selection_mode,p.ft_class,p.confidence,
 p.source_snapshot, r.status run_status,r.formal_allowed,r.data_complete,r.no_result_leakage,
 (m.pool_date::timestamp + case when extract(isodow from m.pool_date) in (6,7) then interval '15 hours' else interval '14 hours' end) sale_at
 from ninety_core.soren_matches m join ninety_core.soren_predictions p on p.match_id=m.id
 join ninety_core.soren_runs r on r.id=p.run_id
 where m.pool_date between '2026-10-21' and '2026-10-25'
), quotes as (
 select b.*, q.captured_at william_at,q.ingested_at william_ingested_at,
 case b.ft_top1 when 'H' then q.home_value when 'D' then q.draw_value when 'A' then q.away_value end william_odds,
 exists(select 1 from ninety_core.soren_daily_selection_locks_v1 l where l.pool_date=b.pool_date and l.match_no=b.match_no) locked,
 coalesce((b.source_snapshot->'upsetWarning'->>'publish')::boolean,false) warning,
 exists(select 1 from ninety_core.soren_upset_warnings_v1 w where w.pool_date=b.pool_date and w.match_no=b.match_no and w.result_fields_used=false and w.source_frozen_at <= least(b.sale_at at time zone 'UTC',b.kickoff_at)) warning_row
 from base b left join lateral (
 select s.* from ninety_core.soren_market_snapshots s
 where s.match_id=b.match_id and s.source_code='zucaijia_william' and s.market_type='FT_1X2'
 and s.snapshot_type='current' and s.data_quality in ('verified','verified_mirror')
 and s.captured_at<=b.frozen_at and s.ingested_at<=b.frozen_at and s.captured_at<b.kickoff_at
 order by s.captured_at desc limit 1
 ) q on true
), ranked as (
 select q.*,case when william_odds between 1.45 and 1.75 then row_number() over(partition by pool_date,william_odds between 1.45 and 1.75 order by confidence desc,william_odds,match_no) end william_rank,
 (source_snapshot->>'pregameVerified')='true' and run_status='COMPLETE' and formal_allowed and data_complete and no_result_leakage and frozen_at <= least(sale_at at time zone 'UTC',kickoff_at) verified
 from quotes q
), market as (select r.*, b.captured_at bf_at,b.index_rows bf_index, ((b.index_rows->(case r.ft_top1 when 'H' then 0 else 2 end)->>'bfShare')::numeric) bf_share, (b.index_rows->0->>'avgProb')::numeric ih, (b.index_rows->1->>'avgProb')::numeric idr, (b.index_rows->2->>'avgProb')::numeric ia, (b.index_rows->0->>'bfShare')::numeric fh, (b.index_rows->1->>'bfShare')::numeric fd, (b.index_rows->2->>'bfShare')::numeric fa from ranked r left join lateral (select x.* from ninety_core.soren_market_behavior_v1 x where x.pool_date=r.pool_date and x.match_no=r.match_no and x.prematch_verified and x.captured_at<=least(r.sale_at at time zone 'UTC',r.kickoff_at)-interval '10 minutes' and jsonb_array_length(x.index_rows)=3 and x.index_rows->0->>'team'=r.home_team and x.index_rows->1->>'team'='平局' and x.index_rows->2->>'team'=r.away_team order by x.captured_at desc limit 1) b on true), risk as (select mk.*,(abs(mk.official_handicap)=1 and an.n>=2 and case when an.h0<an.a0 then an.h1/an.h0>=1.05 and an.a1/an.a0<=.95 else an.a1/an.a0>=1.05 and an.h1/an.h0<=.95 end) market_direction_anomaly, (coalesce((mk.source_snapshot->>'drawProbability')::numeric,0)>=29 and mk.official_handicap=-1 and (mk.source_snapshot->>'handicapTop1') in ('让胜','让平','让负') and (mk.source_snapshot->>'handicapSecond') in ('让胜','让平','让负')) high_draw_risk, case when mk.ft_top1='H' then mk.ih>greatest(mk.idr,mk.ia)+0.01 and mk.fh>greatest(mk.fd,mk.fa)+0.01 when mk.ft_top1='A' then mk.ia>greatest(mk.ih,mk.idr)+0.01 and mk.fa>greatest(mk.fh,mk.fd)+0.01 else false end triple_aligned from market mk left join lateral (select count(*) n,(array_agg(s.home_value order by s.captured_at))[1] h0,(array_agg(s.away_value order by s.captured_at))[1] a0,(array_agg(s.home_value order by s.captured_at desc))[1] h1,(array_agg(s.away_value order by s.captured_at desc))[1] a1 from ninety_core.soren_market_snapshots s where s.match_id=mk.match_id and s.source_code='zucaijia_william' and s.market_type='FT_1X2' and s.snapshot_type='current' and s.data_quality in ('verified','verified_mirror') and s.captured_at<=least(mk.sale_at at time zone 'UTC',mk.kickoff_at) and s.ingested_at<=least(mk.sale_at at time zone 'UTC',mk.kickoff_at)) an on true), decision as (select *, case when not verified then 'BLOCK_UNVERIFIED' when locked or warning then 'BLOCK_COLD' when coalesce(market_direction_anomaly,false) then 'BLOCK_MARKET_DIRECTION' when coalesce(high_draw_risk,false) then 'BLOCK_HIGH_DRAW' when selection_mode in ('SINGLE','DOUBLE') and ft_class is not null then 'CORE' when william_rank<=3 then 'SUPPLEMENT' else 'NO_SELECTION' end v1 from risk) select pool_date,match_no,match_id,prediction_id,run_id,home_team,away_team,ft_top1,selection_mode,ft_class,confidence,frozen_at,verified,william_at,william_ingested_at,william_odds,william_rank,locked,warning,market_direction_anomaly,high_draw_risk,bf_at,bf_share,triple_aligned,v1,
case when v1 in ('CORE','SUPPLEMENT') and bf_share<50 then 'BLOCK_BF'
when v1='NO_SELECTION' and bf_share>=50 and confidence>=.55 and triple_aligned and william_odds between 1.45 and 1.75 and count(*) filter(where v1='SUPPLEMENT') over(partition by pool_date)<3 then 'SUPPLEMENT'
else v1 end replay,
'DAILY-VALUE-v2.0-20261013-SG-REPLAY'::text selector_version,
'singapore_local_hj38_v87'::text prediction_origin
from decision;
create table if not exists ninety_core.soren_daily_legacy_replay_audit_v1 (
 pool_date date not null, match_no text not null, match_id bigint not null, prediction_id bigint not null,
 run_id bigint not null, replay text not null, v1 text not null, selector_version text not null,
 evidence jsonb not null, reconstructed_at timestamptz not null default now(),
 primary key(pool_date,match_no)
);
alter table ninety_core.soren_daily_legacy_replay_audit_v1 enable row level security;
-- Historical rows are inserted only after the relevant sale cutoff. Never upsert
-- existing rows: a later dynamic run must not overwrite frozen replay evidence.
insert into ninety_core.soren_daily_legacy_replay_audit_v1(pool_date,match_no,match_id,prediction_id,run_id,replay,v1,selector_version,evidence)
select pool_date,match_no,match_id,prediction_id,run_id,replay,v1,selector_version,
 jsonb_build_object('prediction_origin',prediction_origin,'prediction_frozen_at',frozen_at,'pregame_verified',verified,
 'william_captured_at',william_at,'william_ingested_at',william_ingested_at,'william_top1_odds',william_odds,'william_rank',william_rank,
 'betfair_captured_at',bf_at,'betfair_top1_share',bf_share,'three_way_aligned',triple_aligned,
 'permanent_risk_lock',locked,'upset_warning',warning,'market_direction_anomaly',market_direction_anomaly,'high_draw_risk',high_draw_risk,
 'publication_kind','historical_rule_replay','published_at',null)
from ninety_core.soren_daily_legacy_replay_v1
where pool_date >= '2026-10-21'
  and pool_date < (now() at time zone 'Asia/Shanghai')::date
on conflict(pool_date,match_no) do nothing;