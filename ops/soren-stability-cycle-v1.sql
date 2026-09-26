-- Soren stability closure v1
-- Source-controlled copy of the production health/regression/orchestration layer.
-- Deployed 2026-09-26. Do not use result data to create prematch predictions.

create table if not exists public.soren_module_health_v1 (
  pool_date date primary key,
  checked_at timestamptz not null default now(),
  status text not null,
  pool_count integer not null default 0,
  started_count integer not null default 0,
  future_count integer not null default 0,
  formal_prediction_count integer not null default 0,
  sale_freeze_count integer not null default 0,
  prematch_update_count integer not null default 0,
  score_input_count integer not null default 0,
  htft_original_count integer not null default 0,
  htft_replay_count integer not null default 0,
  dynamic_score_count integer not null default 0,
  dynamic_htft_count integer not null default 0,
  risk_publish_count integer not null default 0,
  invalid_provenance_count integer not null default 0,
  issues jsonb not null default '[]'::jsonb,
  details jsonb not null default '{}'::jsonb
);
alter table public.soren_module_health_v1 enable row level security;

create table if not exists public.soren_stability_runs_v1 (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  pool_date date,
  step text not null,
  ok boolean not null,
  detail jsonb not null default '{}'::jsonb
);
alter table public.soren_stability_runs_v1 enable row level security;
create index if not exists soren_stability_runs_v1_run_at_idx
  on public.soren_stability_runs_v1(run_at desc);
create index if not exists soren_stability_runs_v1_date_idx
  on public.soren_stability_runs_v1(pool_date,run_at desc);

CREATE OR REPLACE FUNCTION public.soren_refresh_module_health_v1(p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_pool integer := 0;
  v_started integer := 0;
  v_future integer := 0;
  v_formal integer := 0;
  v_sale integer := 0;
  v_updates integer := 0;
  v_score_inputs integer := 0;
  v_htft integer := 0;
  v_replay integer := 0;
  v_dyn_score integer := 0;
  v_dyn_htft integer := 0;
  v_risk integer := 0;
  v_invalid integer := 0;
  v_min_kickoff timestamptz;
  v_status text := 'OK';
  v_issues jsonb := '[]'::jsonb;
  v_details jsonb;
begin
  select count(*),
         count(*) filter (where kickoff_at <= v_now),
         count(*) filter (where kickoff_at > v_now),
         min(kickoff_at)
    into v_pool,v_started,v_future,v_min_kickoff
  from public.soren_matches
  where pool_date=p_date and coalesce(is_world_cup,false)=false;

  select count(distinct p.match_id) into v_formal
  from public.soren_predictions p
  join public.soren_matches m on m.id=p.match_id
  where m.pool_date=p_date and p.frozen_at<m.kickoff_at;

  select count(distinct f.match_id) into v_sale
  from public.soren_sale_freezes_v1 f
  join public.soren_matches m on m.id=f.match_id
  where m.pool_date=p_date
    and f.source_frozen_at<m.kickoff_at
    and f.locked_at is not null and f.locked_at<m.kickoff_at;

  select count(distinct u.match_id) into v_updates
  from public.soren_prematch_updates_v1 u
  join public.soren_matches m on m.id=u.match_id
  where m.pool_date=p_date
    and u.source_frozen_at<m.kickoff_at
    and u.captured_at<m.kickoff_at
    and u.snapshot->>'pregameVerified'='true';

  select count(distinct x.match_id) into v_score_inputs
  from (
    select u.match_id
    from public.soren_prematch_updates_v1 u
    join public.soren_matches m on m.id=u.match_id
    where m.pool_date=p_date
      and u.source_frozen_at<m.kickoff_at and u.captured_at<m.kickoff_at
      and u.snapshot->>'pregameVerified'='true'
      and jsonb_typeof(u.snapshot->'scoreTop4'->'picks')='array'
      and jsonb_array_length(u.snapshot->'scoreTop4'->'picks')=4
      and u.snapshot->'scoreTop4'->>'frozenAt' is not null
      and nullif(u.snapshot->'scoreTop4'->>'frozenAt','')::timestamptz<m.kickoff_at
      and nullif(u.snapshot->'scoreTop4'->>'lambdaHome','')::double precision between 0.1 and 8
      and nullif(u.snapshot->'scoreTop4'->>'lambdaAway','')::double precision between 0.1 and 8
    union
    select m.id
    from public.soren_prematch_goals_v1 g
    join public.soren_matches m
      on m.pool_date=g.pool_date and lpad(m.match_no,3,'0')=lpad(g.match_no,3,'0')
     and m.home_team=g.home_team and m.away_team=g.away_team
    where m.pool_date=p_date
      and g.frozen_at<m.kickoff_at
      and g.lambda_home between 0.1 and 8 and g.lambda_away between 0.1 and 8
  ) x;

  select count(distinct h.match_id) into v_htft
  from public.soren_htft_top4_v1 h where h.pool_date=p_date;

  select count(distinct h.match_id) into v_replay
  from public.soren_htft_top4_history_v1 h where h.pool_date=p_date;

  select count(distinct s.match_id) into v_dyn_score
  from public.soren_live_score_goals_v1 s where s.pool_date=p_date;

  select count(distinct h.match_id) into v_dyn_htft
  from public.soren_live_htft_v1 h where h.pool_date=p_date;

  select count(*) into v_risk
  from (
    select distinct on (match_no) match_no,source_payload
    from public.soren_upset_warnings_v1
    where pool_date=p_date
    order by match_no,source_frozen_at desc
  ) w
  where coalesce(w.source_payload->>'publish','false')='true';

  select count(*) into v_invalid
  from (
    select 1
    from public.soren_htft_top4_v1 h
    join public.soren_matches m on m.id=h.match_id
    where h.pool_date=p_date
      and not (h.source_frozen_at<=h.published_at and h.published_at<m.kickoff_at and h.source_frozen_at<m.kickoff_at)
    union all
    select 1
    from public.soren_live_score_goals_v1 s
    join public.soren_matches m on m.id=s.match_id
    where s.pool_date=p_date
      and not (s.base_frozen_at<=s.market_at and s.market_at<=s.computed_at and s.computed_at<m.kickoff_at)
    union all
    select 1
    from public.soren_live_htft_v1 h
    join public.soren_matches m on m.id=h.match_id
    where h.pool_date=p_date
      and not (h.source_frozen_at<=h.computed_at and h.computed_at<m.kickoff_at)
    union all
    select 1
    from public.soren_htft_top4_history_v1 h
    join public.soren_matches m on m.id=h.match_id
    where h.pool_date=p_date
      and not (h.source_frozen_at<m.kickoff_at and h.reconstructed_at>=m.kickoff_at)
  ) bad;

  if v_pool=0 then
    v_status:='IDLE';
  end if;

  if v_invalid>0 then
    v_status:='FAIL';
    v_issues:=v_issues||jsonb_build_array('PROVENANCE_TIMESTAMP_VIOLATION');
  end if;

  if v_pool>=3 and v_min_kickoff is not null and v_min_kickoff<=v_now+interval '18 hours' and v_updates=0 then
    v_status:='FAIL';
    v_issues:=v_issues||jsonb_build_array('PREMATCH_UPDATES_EMPTY_NEAR_KICKOFF');
  end if;

  if v_score_inputs>=3 and (v_started>0 or (v_min_kickoff is not null and v_min_kickoff<=v_now+interval '18 hours'))
     and v_htft+v_replay=0 then
    v_status:='FAIL';
    v_issues:=v_issues||jsonb_build_array('HTFT_ZERO_WITH_VALID_SCORE_INPUTS');
  end if;

  if v_dyn_score>=3 and v_dyn_htft=0 then
    v_status:='FAIL';
    v_issues:=v_issues||jsonb_build_array('DYNAMIC_HTFT_ZERO_WITH_DYNAMIC_SCORE');
  elsif abs(v_dyn_score-v_dyn_htft)>1 then
    if v_status='OK' then v_status:='WARN'; end if;
    v_issues:=v_issues||jsonb_build_array('DYNAMIC_SCORE_HTFT_COVERAGE_GAP');
  end if;

  if v_pool>=5 and v_started>0 and v_sale=0 then
    if v_status='OK' then v_status:='WARN'; end if;
    v_issues:=v_issues||jsonb_build_array('SALE_FREEZE_EMPTY_AFTER_START');
  end if;

  v_details:=jsonb_build_object(
    'minKickoff',v_min_kickoff,
    'htftCoverage',case when v_pool>0 then round((v_htft+v_replay)::numeric/v_pool,4) else null end,
    'dynamicParity',jsonb_build_object('score',v_dyn_score,'htft',v_dyn_htft),
    'scoreInputCoverage',case when v_pool>0 then round(v_score_inputs::numeric/v_pool,4) else null end
  );

  insert into public.soren_module_health_v1(
    pool_date,checked_at,status,pool_count,started_count,future_count,
    formal_prediction_count,sale_freeze_count,prematch_update_count,score_input_count,
    htft_original_count,htft_replay_count,dynamic_score_count,dynamic_htft_count,
    risk_publish_count,invalid_provenance_count,issues,details
  ) values (
    p_date,v_now,v_status,v_pool,v_started,v_future,
    v_formal,v_sale,v_updates,v_score_inputs,
    v_htft,v_replay,v_dyn_score,v_dyn_htft,
    v_risk,v_invalid,v_issues,v_details
  )
  on conflict (pool_date) do update set
    checked_at=excluded.checked_at,status=excluded.status,pool_count=excluded.pool_count,
    started_count=excluded.started_count,future_count=excluded.future_count,
    formal_prediction_count=excluded.formal_prediction_count,sale_freeze_count=excluded.sale_freeze_count,
    prematch_update_count=excluded.prematch_update_count,score_input_count=excluded.score_input_count,
    htft_original_count=excluded.htft_original_count,htft_replay_count=excluded.htft_replay_count,
    dynamic_score_count=excluded.dynamic_score_count,dynamic_htft_count=excluded.dynamic_htft_count,
    risk_publish_count=excluded.risk_publish_count,invalid_provenance_count=excluded.invalid_provenance_count,
    issues=excluded.issues,details=excluded.details;

  insert into public.soren_source_health(
    source_code,status,pool_date,expected,captured,verified,last_attempt_at,last_success_at,last_error,details,updated_at
  ) values (
    'pipeline:stability:'||to_char(p_date,'YYYY-MM-DD'),
    lower(v_status),p_date,v_pool,v_htft+v_replay,v_dyn_htft,v_now,
    case when v_status in ('OK','IDLE') then v_now else null end,
    case when v_status in ('FAIL','WARN') then v_issues::text else null end,
    jsonb_build_object(
      'formal',v_formal,'saleFreeze',v_sale,'prematchUpdates',v_updates,
      'scoreInputs',v_score_inputs,'htftOriginal',v_htft,'htftReplay',v_replay,
      'dynamicScore',v_dyn_score,'dynamicHtft',v_dyn_htft,'riskPublished',v_risk,
      'invalidProvenance',v_invalid,'issues',v_issues
    ),v_now
  )
  on conflict (source_code) do update set
    status=excluded.status,pool_date=excluded.pool_date,expected=excluded.expected,
    captured=excluded.captured,verified=excluded.verified,last_attempt_at=excluded.last_attempt_at,
    last_success_at=coalesce(excluded.last_success_at,public.soren_source_health.last_success_at),
    last_error=excluded.last_error,details=excluded.details,updated_at=excluded.updated_at;

  return jsonb_build_object(
    'ok',v_status in ('OK','IDLE'),
    'status',v_status,'date',p_date,'pool',v_pool,
    'htftOriginal',v_htft,'htftReplay',v_replay,
    'dynamicScore',v_dyn_score,'dynamicHtft',v_dyn_htft,
    'issues',v_issues
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.soren_run_regression_guard_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_warning_contamination integer := 0;
  v_htft_bad integer := 0;
  v_dyn_score_bad integer := 0;
  v_dyn_htft_bad integer := 0;
  v_replay_bad integer := 0;
  v_gap_dates integer := 0;
  v_status text := 'OK';
  v_issues jsonb := '[]'::jsonb;
begin
  select count(*) into v_warning_contamination
  from public.soren_upset_warnings_v1
  where pool_date>=date '2026-09-20'
    and (coalesce(result_fields_used,false)=true or coalesce(hur_direction_used,false)=true);

  select count(*) into v_htft_bad
  from public.soren_htft_top4_v1 h
  join public.soren_matches m on m.id=h.match_id
  where not (h.source_frozen_at<=h.published_at and h.published_at<m.kickoff_at);

  select count(*) into v_dyn_score_bad
  from public.soren_live_score_goals_v1 s
  join public.soren_matches m on m.id=s.match_id
  where not (s.base_frozen_at<=s.market_at and s.market_at<=s.computed_at and s.computed_at<m.kickoff_at);

  select count(*) into v_dyn_htft_bad
  from public.soren_live_htft_v1 h
  join public.soren_matches m on m.id=h.match_id
  where not (h.source_frozen_at<=h.computed_at and h.computed_at<m.kickoff_at);

  select count(*) into v_replay_bad
  from public.soren_htft_top4_history_v1 h
  join public.soren_matches m on m.id=h.match_id
  where not (h.source_frozen_at<m.kickoff_at and h.reconstructed_at>=m.kickoff_at);

  select count(*) into v_gap_dates
  from (
    select d.pool_date,
           coalesce(s.n,0) score_n,
           coalesce(h.n,0) htft_n
    from (select distinct pool_date from public.soren_live_score_goals_v1 where pool_date>=date '2026-09-25') d
    left join (
      select pool_date,count(distinct match_id) n from public.soren_live_score_goals_v1
      where pool_date>=date '2026-09-25' group by pool_date
    ) s using(pool_date)
    left join (
      select pool_date,count(distinct match_id) n from public.soren_live_htft_v1
      where pool_date>=date '2026-09-25' group by pool_date
    ) h using(pool_date)
    where coalesce(s.n,0)>=3 and abs(coalesce(s.n,0)-coalesce(h.n,0))>1
  ) q;

  if v_warning_contamination>0 then
    v_status:='FAIL'; v_issues:=v_issues||jsonb_build_array('RISK_RESULT_CONTAMINATION');
  end if;
  if v_htft_bad+v_dyn_score_bad+v_dyn_htft_bad+v_replay_bad>0 then
    v_status:='FAIL'; v_issues:=v_issues||jsonb_build_array('PREMATCH_TIMESTAMP_INTEGRITY');
  end if;
  if v_gap_dates>0 then
    if v_status='OK' then v_status:='WARN'; end if;
    v_issues:=v_issues||jsonb_build_array('DYNAMIC_PRODUCT_PARITY');
  end if;

  insert into public.soren_source_health(
    source_code,status,pool_date,last_attempt_at,last_success_at,last_error,details,updated_at
  ) values (
    'regression:prematch-integrity',lower(v_status),null,v_now,
    case when v_status='OK' then v_now else null end,
    case when v_status<>'OK' then v_issues::text else null end,
    jsonb_build_object(
      'warningContamination',v_warning_contamination,
      'htftTimestampBad',v_htft_bad,
      'dynamicScoreTimestampBad',v_dyn_score_bad,
      'dynamicHtftTimestampBad',v_dyn_htft_bad,
      'replayTimestampBad',v_replay_bad,
      'dynamicGapDates',v_gap_dates,
      'issues',v_issues
    ),v_now
  )
  on conflict (source_code) do update set
    status=excluded.status,last_attempt_at=excluded.last_attempt_at,
    last_success_at=coalesce(excluded.last_success_at,public.soren_source_health.last_success_at),
    last_error=excluded.last_error,details=excluded.details,updated_at=excluded.updated_at;

  return jsonb_build_object('ok',v_status='OK','status',v_status,'issues',v_issues);
end;
$function$;

CREATE OR REPLACE FUNCTION public.soren_run_stability_cycle_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  d date;
  v_today date := (clock_timestamp() at time zone 'Asia/Shanghai')::date;
  v_failures integer := 0;
  v_result jsonb;
  v_health jsonb := '[]'::jsonb;
begin
  for d in select (v_today+g)::date from generate_series(0,2) g loop
    begin
      perform public.soren_publish_strict_goals_v1(d);
      insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
      values(d,'strict_goals',true,'{}'::jsonb);
    exception when others then
      v_failures:=v_failures+1;
      insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
      values(d,'strict_goals',false,jsonb_build_object('error',sqlerrm));
    end;
  end loop;

  begin
    perform public.soren_publish_htft_top4_v1();
    insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
    values(null,'original_htft',true,'{}'::jsonb);
  exception when others then
    v_failures:=v_failures+1;
    insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
    values(null,'original_htft',false,jsonb_build_object('error',sqlerrm));
  end;

  for d in select (v_today+g)::date from generate_series(0,2) g loop
    begin
      select public.soren_refresh_live_score_goals_v1(d) into v_result;
      insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
      values(d,'dynamic_score',true,coalesce(v_result,'{}'::jsonb));
    exception when others then
      v_failures:=v_failures+1;
      insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
      values(d,'dynamic_score',false,jsonb_build_object('error',sqlerrm));
    end;

    begin
      select public.soren_refresh_live_htft_v1(d) into v_result;
      insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
      values(d,'dynamic_htft',true,coalesce(v_result,'{}'::jsonb));
    exception when others then
      v_failures:=v_failures+1;
      insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
      values(d,'dynamic_htft',false,jsonb_build_object('error',sqlerrm));
    end;

    begin
      select public.soren_refresh_module_health_v1(d) into v_result;
      v_health:=v_health||jsonb_build_array(v_result);
      insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
      values(d,'health',coalesce((v_result->>'ok')::boolean,false),coalesce(v_result,'{}'::jsonb));
      if coalesce((v_result->>'status'),'FAIL')='FAIL' then v_failures:=v_failures+1; end if;
    exception when others then
      v_failures:=v_failures+1;
      insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
      values(d,'health',false,jsonb_build_object('error',sqlerrm));
    end;
  end loop;

  begin
    select public.soren_run_regression_guard_v1() into v_result;
    insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
    values(null,'regression_guard',coalesce((v_result->>'ok')::boolean,false),coalesce(v_result,'{}'::jsonb));
    if coalesce((v_result->>'status'),'FAIL')='FAIL' then v_failures:=v_failures+1; end if;
  exception when others then
    v_failures:=v_failures+1;
    insert into public.soren_stability_runs_v1(pool_date,step,ok,detail)
    values(null,'regression_guard',false,jsonb_build_object('error',sqlerrm));
  end;

  delete from public.soren_stability_runs_v1 where run_at<clock_timestamp()-interval '14 days';

  insert into public.soren_source_health(
    source_code,status,last_attempt_at,last_success_at,last_error,details,updated_at
  ) values(
    'pipeline:stability-cycle',
    case when v_failures=0 then 'ok' else 'degraded' end,
    clock_timestamp(),
    case when v_failures=0 then clock_timestamp() else null end,
    case when v_failures=0 then null else v_failures||' stability checks failed' end,
    jsonb_build_object('failures',v_failures,'health',v_health),
    clock_timestamp()
  )
  on conflict (source_code) do update set
    status=excluded.status,last_attempt_at=excluded.last_attempt_at,
    last_success_at=coalesce(excluded.last_success_at,public.soren_source_health.last_success_at),
    last_error=excluded.last_error,details=excluded.details,updated_at=excluded.updated_at;

  return jsonb_build_object('ok',v_failures=0,'failures',v_failures,'health',v_health);
end;
$function$;

-- Consolidate dependent product jobs into one ordered cycle.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname='soren_strict_goals_publish_auto_v1'),
  active := false
);
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname='soren_htft_top4_publish_v1'),
  active := false
);
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname='ninety-live-score-goals-prematch-v01'),
  active := false
);
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname='ninety-live-htft-prematch-v01'),
  active := false
);

select cron.schedule(
  'soren-stability-cycle-v1',
  '*/5 * * * *',
  'select public.soren_run_stability_cycle_v1()'
);

-- The upset sync remains a separate Edge-function job, but it must use the layered
-- formal-freeze anchored sync endpoint for both current and next pool dates.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname='soren_upset_warning_sync_v1'),
  command := $cmd$
    select net.http_get(
      url := 'https://ttydbcejxqxdkcfoizkj.supabase.co/functions/v1/soren-public-api-v1?sync_upset=1&date='
             || to_char(((now() at time zone 'Asia/Shanghai')::date + g)::date,'YYYY-MM-DD'),
      timeout_milliseconds := 30000
    )
    from generate_series(0,1) g
  $cmd$
);
