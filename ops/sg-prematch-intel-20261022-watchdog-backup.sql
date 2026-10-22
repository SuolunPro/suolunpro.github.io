CREATE OR REPLACE FUNCTION ninety_core.soren_daily_intel_watchdog_v1(p_date date DEFAULT ((now() AT TIME ZONE 'Asia/Shanghai'::text))::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare
 v_pending integer:=0;
 v_published integer:=0;
 v_realintel integer:=0;
 v_marketpending integer:=0;
 v_blocked integer:=0;
 v_lock_conflicts integer:=0;
 v_status text:='OK';
 v_now timestamptz:=clock_timestamp();
begin
 if p_date is null then raise exception 'date required';end if;
 if not pg_try_advisory_xact_lock(hashtext('ninety_daily_intel_watchdog:'||p_date::text)) then
  return jsonb_build_object('ok',false,'status','BUSY');
 end if;
 select count(*) filter(where publication_status='PENDING_VIP_COLD_REVIEW'),
        count(*) filter(where publication_status='PENDING_MARKET_DATA'),
        count(*) filter(where publication_status='BLOCKED')
 into v_pending,v_marketpending,v_blocked
 from ninety_core.soren_daily_selection_candidate_audit_v1
 where pool_date=p_date;
 select count(*) into v_published
 from ninety_core.soren_daily_selection_publications_v1
 where pool_date=p_date;
 select count(distinct match_no) into v_realintel
 from ninety_core.soren_intelligence_reports_v1
 where pool_date=p_date and fetched_at<v_now
 and quality in ('okooo_public_prematch_observed','attributed_prematch_article_pair_verified');
 select count(*) into v_lock_conflicts
 from ninety_core.soren_daily_selection_publications_v1 p
 join ninety_core.soren_daily_selection_locks_v1 l
   on l.pool_date=p.pool_date and l.match_no=p.match_no and l.lock_type='PRODUCTION_RISK'
 where p.pool_date=p_date;
 if v_lock_conflicts>0 then v_status:='FAIL_RISK_LOCK_CONFLICT';
 elsif v_pending>0 and v_published=0
    and p_date=(v_now at time zone 'Asia/Shanghai')::date
    and (v_now at time zone 'Asia/Shanghai')::time>time '11:30'
    and (v_now at time zone 'Asia/Shanghai')::time<time '22:00'
 then v_status:='WARN_INTEL_GATE_BLOCKED';
 end if;
 if v_status<>'OK' and not exists (
    select 1 from ninety_core.ingest_runs
    where source_name='ninety_daily_intel_watchdog_v1'
      and status='partial' and finished_at>v_now-interval '50 minutes'
 ) then
   insert into ninety_core.ingest_runs(source_name,status,started_at,finished_at,summary)
   values('ninety_daily_intel_watchdog_v1','partial',v_now,clock_timestamp(),
     jsonb_build_object('date',p_date,'status',v_status,'pending_vip',v_pending,
     'pending_market',v_marketpending,'published',v_published,
     'verified_news_matches',v_realintel,'risk_lock_conflicts',v_lock_conflicts,
     'note','Server-side health log; do not publish unverified candidates.'))
 ;end if;
 return jsonb_build_object('ok',true,'date',p_date,'status',v_status,
  'pending_vip',v_pending,'pending_market',v_marketpending,
  'published',v_published,'verified_news_matches',v_realintel,
  'blocked',v_blocked,'risk_lock_conflicts',v_lock_conflicts);
end;
$function$

