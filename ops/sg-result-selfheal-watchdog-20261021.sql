create or replace function ninety_core.result_selfheal_watchdog_v1()
returns jsonb
language plpgsql
security invoker
set search_path to pg_catalog
as $$
declare
  issues jsonb;
  n integer;
  reported boolean;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'match_key', x.match_key,
    'result_quality', x.quality,
    'half_verified', x.half_verified,
    'pending_modules', x.pending_modules
  ) order by x.match_key),'[]'::jsonb),count(*)
  into issues,n
  from (
    select m.match_key,s.quality,
      coalesce(s.payload->>'halftime_verified','false') as half_verified,
      (select count(distinct o.module)
       from ninety_core.module_outputs o
       where o.match_key=m.match_key and o.module in
         ('ft','handicap','score_top3','htft_top3','total_goals')
         and o.payload->>'status'='READY'
         and o.produced_at<m.kickoff_at
         and not exists (
           select 1 from ninety_core.module_settlements_v1 z
           where z.match_key=o.match_key and z.module=o.module
             and z.forecast_at=o.produced_at and z.settlement_status='GRADED'
         )) as pending_modules
    from ninety_core.match_pool m
    left join ninety_core.source_state s
      on s.match_key=m.match_key and s.field_key='result'
    where m.match_date between
      ((now() at time zone 'Asia/Shanghai')::date-2)
      and (now() at time zone 'Asia/Shanghai')::date
      and m.status='finished'
      and m.kickoff_at < now()-interval '3 hours'
      and m.status<>'invalid_test'
    order by m.match_key
  ) x
  where x.quality is distinct from 'verified'
     or x.half_verified<>'true'
     or x.pending_modules>0;
  if n>0 then
    select exists(select 1 from ninety_core.ingest_runs
      where source_name='ninety_result_selfheal_watchdog_v1'
        and finished_at>now()-interval '1 hour') into reported;
    if not reported then
      insert into ninety_core.ingest_runs
        (source_name,status,finished_at,summary)
      values ('ninety_result_selfheal_watchdog_v1','partial',now(),
        jsonb_build_object('unresolved',n,'fixtures',issues,
          'recovery','10min dual-source retry and 3-day daily replay'));
    end if;
  end if;
  return jsonb_build_object('unresolved',n,'fixtures',issues,'checked_at',now());
end $$;
revoke all on function ninety_core.result_selfheal_watchdog_v1() from public,anon,authenticated;
select cron.schedule('ninety-result-selfheal-watchdog-v1','8,18,28,38,48,58 * * * *','select ninety_core.result_selfheal_watchdog_v1();');
