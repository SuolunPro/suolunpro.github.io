-- Keep weekend selection refreshing until 23:00 Beijing time, then freeze.
-- Weekday publication stops at 22:00 Beijing time.
CREATE OR REPLACE FUNCTION ninety_core.soren_daily_selection_audit_refresh_v1(p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare n integer:=0;w integer:=0;b integer:=0;
begin
 if p_date < (now() at time zone 'Asia/Shanghai')::date
    or p_date > (now() at time zone 'Asia/Shanghai')::date +1 then
    return jsonb_build_object('ok',false,'reason','HISTORICAL_WRITE_FORBIDDEN'); end if;
 if now() >= ((p_date + case when extract(isodow from p_date) in (6,7)
   then time '23:00' else time '22:00' end) at time zone 'Asia/Shanghai') then
   return jsonb_build_object('ok',true,'reason','LOTTERY_CLOSED_FROZEN','customer_published',0);
 end if;
 with model as (
   select distinct on (m.id) m.id match_id,m.pool_date,m.match_no,
     m.home_team,m.away_team,m.kickoff_at,m.cutoff_at,m.official_handicap,
     p.frozen_at,p.ft_top1,p.selection_mode,p.ft_class,p.source_snapshot,
     case when p.confidence<=1 then p.confidence*100 else p.confidence end confidence_pct,
     (p.id is not null and r.status='COMPLETE' and r.formal_allowed=true and
       r.no_result_leakage=true and p.ft_top1 in ('H','D','A') and
       p.frozen_at<m.kickoff_at and p.frozen_at<=now() and
       p.source_snapshot->>'pregameVerified'='true') as formally_verified
   from ninety_core.soren_matches m
   left join ninety_core.soren_predictions p on p.match_id=m.id
   left join ninety_core.soren_runs r on r.id=p.run_id
   where m.pool_date=p_date and m.is_world_cup=false
   order by m.id,p.frozen_at desc nulls last,p.id desc nulls last
 ), mrk as (
   select m.*,
     v.odd as william_odd,
     bf.index_rows,bf.captured_at as funds_captured_at,
     exists(select 1 from ninety_core.soren_daily_selection_locks_v1 l
       where l.pool_date=m.pool_date and l.match_no=m.match_no)
     or exists(select 1 from ninety_core.soren_upset_warnings_v1 w
       where w.pool_date=m.pool_date and w.match_no=m.match_no
       and (w.source_payload->>'publish')='true'
       and (w.source_payload->>'directionPublicationEligible')='true'
       and w.warning_direction in ('主队不胜','主队不败')
       and w.directional_domain_count>=2
       and w.result_fields_used=false and w.hur_direction_used=false
       and w.source_frozen_at<w.kickoff_bjt)
     as permanent_lock,
     (m.official_handicap=-1
       and (m.source_snapshot->>'drawProbability') ~ '^[0-9]+([.][0-9]+)?$'
       and (m.source_snapshot->>'drawProbability')::numeric >=29
       and m.source_snapshot->>'handicapTop1' in ('让胜','让平','让负')
       and m.source_snapshot->>'handicapSecond' in ('让胜','让平','让负')
     ) as high_draw,
     anom.anomaly as market_anomaly
   from model m
   left join lateral (
     select case m.ft_top1 when 'H' then w.home_value
            when 'D' then w.draw_value when 'A' then w.away_value else null end odd
     from ninety_core.soren_market_snapshots w
     where w.match_id=m.match_id
       and w.source_code='zucaijia_william' and w.market_type='FT_1X2'
       and w.snapshot_type='current' and w.data_quality in ('verified','verified_mirror')
       and w.captured_at<=m.frozen_at and w.ingested_at<=m.frozen_at
       and w.captured_at<m.kickoff_at and w.ingested_at<m.kickoff_at
     order by w.captured_at desc,w.id desc limit 1
   ) v on true
   left join lateral (
     select b.index_rows,b.captured_at
     from ninety_core.soren_daily_selection_v2_market_snapshot(p_date) b
     where b.match_id=m.match_id limit 1
   ) bf on true
   left join lateral (
     select (
       abs(m.official_handicap)=1 and
       case when firstq.home_value<firstq.away_value then
         (lastq.home_value/ nullif(firstq.home_value,0)-1)>=0.05
         and (1-lastq.away_value/nullif(firstq.away_value,0))>=0.05
       else
         (lastq.away_value/nullif(firstq.away_value,0)-1)>=0.05
         and (1-lastq.home_value/nullif(firstq.home_value,0))>=0.05
       end
     ) anomaly
     from lateral (
       select q.home_value,q.away_value from ninety_core.soren_market_snapshots q
       where q.match_id=m.match_id and q.snapshot_type='current'
         and q.source_code='zucaijia_william' and q.market_type='FT_1X2'
         and q.captured_at<=least(now(),m.kickoff_at)
         and q.ingested_at<=least(now(),m.kickoff_at)
         and q.home_value>0 and q.away_value>0
       order by q.captured_at asc,q.id asc limit 1
     ) firstq
     cross join lateral (
       select q.home_value,q.away_value from ninety_core.soren_market_snapshots q
       where q.match_id=m.match_id and q.snapshot_type='current'
         and q.source_code='zucaijia_william' and q.market_type='FT_1X2'
         and q.captured_at<=least(now(),m.kickoff_at)
         and q.ingested_at<=least(now(),m.kickoff_at)
         and q.home_value>0 and q.away_value>0
       order by q.captured_at desc,q.id desc limit 1
     ) lastq
   ) anom on true
 ), raw_band as (
   select match_id,row_number() over(order by confidence_pct desc, william_odd asc,match_no asc) as band_rank
   from mrk where formally_verified and william_odd between 1.45 and 1.75
 ), directional as (
   select x.*,rb.band_rank,
     case when jsonb_typeof(index_rows)='array' and jsonb_array_length(index_rows)=3
       and index_rows->0->>'team'=home_team and index_rows->1->>'team'='平局'
       and index_rows->2->>'team'=away_team and
       (index_rows->0->>'avgProb')~'^[0-9]+([.][0-9]+)?$'
       and (index_rows->1->>'avgProb')~'^[0-9]+([.][0-9]+)?$'
       and (index_rows->2->>'avgProb')~'^[0-9]+([.][0-9]+)?$'
       and (index_rows->0->>'bfShare')~'^[0-9]+([.][0-9]+)?$'
       and (index_rows->1->>'bfShare')~'^[0-9]+([.][0-9]+)?$'
       and (index_rows->2->>'bfShare')~'^[0-9]+([.][0-9]+)?$'
       then true else false end as three_way_fields_valid
   from mrk x left join raw_band rb on rb.match_id=x.match_id
 ), prob as (
   select d.*,
     case when three_way_fields_valid then
       array[(index_rows->0->>'avgProb')::numeric,(index_rows->1->>'avgProb')::numeric,
             (index_rows->2->>'avgProb')::numeric] else null end as institution_vector,
     case when three_way_fields_valid then
       array[(index_rows->0->>'bfShare')::numeric,(index_rows->1->>'bfShare')::numeric,
             (index_rows->2->>'bfShare')::numeric] else null end as funds_vector
   from directional d
 ), scored as (
   select p.*,
     (institution_vector is not null and funds_vector is not null
       and abs(institution_vector[1]+institution_vector[2]+institution_vector[3]-100)<=3
       and abs(funds_vector[1]+funds_vector[2]+funds_vector[3]-100)<=3) as three_way_valid,
     case when institution_vector[1]>=greatest(institution_vector[2],institution_vector[3])+0.01 then 'H'
          when institution_vector[2]>=greatest(institution_vector[1],institution_vector[3])+0.01 then 'D'
          when institution_vector[3]>=greatest(institution_vector[1],institution_vector[2])+0.01 then 'A' end institution_pick,
     case when funds_vector[1]>=greatest(funds_vector[2],funds_vector[3])+0.01 then 'H'
          when funds_vector[2]>=greatest(funds_vector[1],funds_vector[3])+0.01 then 'D'
          when funds_vector[3]>=greatest(funds_vector[1],funds_vector[2])+0.01 then 'A' end funds_pick,
     case ft_top1 when 'H' then funds_vector[1] when 'A' then funds_vector[3] else null end as top_share,
     (formally_verified and selection_mode in ('SINGLE','DOUBLE') and
       ft_class is not null and ft_class<>'PASS' and coalesce(source_snapshot->>'pass','false')<>'true'
       and not permanent_lock and not coalesce(high_draw,false) and not coalesce(market_anomaly,false))
       as core
   from prob p
 ), v1 as (
   select s.*,
     case when core then 'CORE'
          when formally_verified and band_rank between 1 and 3 and not permanent_lock
             and not coalesce(high_draw,false) and not coalesce(market_anomaly,false)
          then 'SUPPLEMENT' else null end as initial_tier
   from scored s
 ), v2 as (
   select v.*,
     case when not three_way_valid or funds_captured_at is null
       or not (funds_captured_at <= least(
         kickoff_at,coalesce(cutoff_at,
            ((pool_date+case when extract(isodow from pool_date) in (6,7)
              then time '23:00' else time '22:00' end) at time zone 'Asia/Shanghai'))
             )- interval '10 minutes')
       or now()>=least(kickoff_at,coalesce(cutoff_at,
            ((pool_date+case when extract(isodow from pool_date) in (6,7)
              then time '23:00' else time '22:00' end) at time zone 'Asia/Shanghai'))
             )- interval '10 minutes'
       or ft_top1 not in ('H','A') or not formally_verified
       then 'NOT_EVALUATED'
       when initial_tier is not null and top_share<50 then 'BLOCK'
       when initial_tier is null and top_share>=50 and confidence_pct>=55
         and institution_pick=ft_top1 and funds_pick=ft_top1
         and not permanent_lock and not coalesce(high_draw,false) and not coalesce(market_anomaly,false)
         then 'ADD'
       else 'KEEP' end as overlay
   from v1 v
 )
 insert into ninety_core.soren_daily_selection_candidate_audit_v1
 (pool_date,match_no,match_id,model_frozen_at,model_top1,
  confidence_pct,source_mode,model_tier,william_top1_odds,william_rank,
  funds_share_pct,institution_top1,funds_top1,v1_candidate,v2_decision,
  permanent_risk_lock,high_draw_risk,market_direction_anomaly,
  vip_cold_gate,publication_status,reason,verified_inputs,audited_at)
 select pool_date,match_no,match_id,frozen_at,ft_top1,
  confidence_pct,selection_mode,ft_class,william_odd,band_rank,
  top_share,institution_pick,funds_pick,initial_tier,overlay,
  permanent_lock,coalesce(high_draw,false),coalesce(market_anomaly,false),
  'NOT_VERIFIED',
  case when not coalesce(formally_verified,false) then 'BLOCKED'
       when permanent_lock or coalesce(high_draw,false) or coalesce(market_anomaly,false) then 'BLOCKED'
       when overlay='BLOCK' then 'BLOCKED'
       when (initial_tier is not null or overlay='ADD') and (overlay='NOT_EVALUATED' or not three_way_valid) then 'PENDING_MARKET_DATA'
       when initial_tier is not null or overlay='ADD' then 'PENDING_VIP_COLD_REVIEW'
       else 'NOT_SELECTED' end,
  case when not coalesce(formally_verified,false) then 'FORMAL_SOURCE_UNVERIFIED'
       when permanent_lock then 'HISTORICAL_COLD_LOCK'
       when high_draw then 'HIGH_DRAW_RISK'
       when coalesce(market_anomaly,false) then 'WILLIAM_DYNAMIC_REVERSAL_5PCT'
       when overlay='BLOCK' then 'V2_BETFAIR_SHARE_LT_50'
       when (initial_tier is not null or overlay='ADD') and (overlay='NOT_EVALUATED' or not three_way_valid) then 'MISSING_VERIFIED_BETFAIR_FOR_V2'
       when initial_tier is not null or overlay='ADD' then 'ORIGINAL_VIP_COLD_GATE_NOT_YET_RESTORED'
       else 'ORIGINAL_SELECTOR_NO_ELIGIBILITY' end,
  jsonb_build_object('source','original_soren_v1_v2_rules_shadow',
     'model_pre_kickoff',coalesce(formally_verified,false),'william_before_model_freeze',william_odd is not null,
     'william_raw_top3_rank',band_rank,'three_way_verified',three_way_valid,
     'funds_capture_at',funds_captured_at,
     'candidate_not_customer_visible',true,'original_vip_risk_verified',false),
  now()
 from v2
 on conflict(pool_date,match_no) do update set
  model_frozen_at=excluded.model_frozen_at,model_top1=excluded.model_top1,
  confidence_pct=excluded.confidence_pct,source_mode=excluded.source_mode,
  model_tier=excluded.model_tier,william_top1_odds=excluded.william_top1_odds,
  william_rank=excluded.william_rank,funds_share_pct=excluded.funds_share_pct,
  institution_top1=excluded.institution_top1,funds_top1=excluded.funds_top1,
  v1_candidate=excluded.v1_candidate,v2_decision=excluded.v2_decision,
  permanent_risk_lock=excluded.permanent_risk_lock,high_draw_risk=excluded.high_draw_risk,
  market_direction_anomaly=excluded.market_direction_anomaly,
  vip_cold_gate=excluded.vip_cold_gate,publication_status=excluded.publication_status,
  reason=excluded.reason,verified_inputs=excluded.verified_inputs,audited_at=now();
 get diagnostics n=row_count;
 select count(*) into w from ninety_core.soren_daily_selection_candidate_audit_v1
 where pool_date=p_date and publication_status='PENDING_VIP_COLD_REVIEW';
 select count(*) into b from ninety_core.soren_daily_selection_candidate_audit_v1
 where pool_date=p_date and publication_status='BLOCKED';
 return jsonb_build_object('ok',true,'pool_date',p_date,'reviewed',n,
   'pending_vip_gate',w,'blocked',b,'customer_published',0,'shadow_only',true);
end;$function$
;

select cron.alter_job(33, schedule := '12,27,42,57 0-14 * * *');
