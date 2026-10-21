create or replace function ninety_core.lock_published_prematch_upset_v1()
returns trigger
language plpgsql security definer
set search_path to 'pg_catalog'
as $function$
declare
  model_at timestamptz;
  sale_at timestamptz;
  certified_abc boolean := false;
begin
  sale_at := ((new.pool_date + case when extract(isodow from new.pool_date) in (6,7) then time '23:00' else time '22:00' end) at time zone 'Asia/Shanghai');
  if new.source_payload->>'source' = 'SG_ABCDE_V2_ORIGINAL_GATES'
     and new.source_payload->>'abc_verified' = 'true'
     and new.source_payload->>'inputModelAt' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}[T ]'
     and jsonb_typeof(new.source_payload->'channels') = 'array'
     and new.source_payload->'channels' ?| array['A','B','C','D','E1','E2'] then
    model_at := (new.source_payload->>'inputModelAt')::timestamptz;
    certified_abc := exists (
      select 1
      from ninety_core.hao_console_predictions p
      join ninety_core.hao_console_model_runs r on r.id=p.run_id
      where p.pool_date=new.pool_date and p.match_no=new.match_no
        and p.home_team=new.home_team and p.away_team=new.away_team
        and p.kickoff_bjt=new.kickoff_bjt
        and p.frozen_at=model_at and p.top1=new.original_top1
        and p.model_version='3.8'
        and r.formal_allowed=true and r.data_complete=true
    );
  end if;
  if new.source_payload->>'publish'='true'
     and new.source_payload->>'directionPublicationEligible'='true'
     and new.warning_direction in ('主队不胜','主队不败')
     and ((new.warning_direction='主队不胜' and new.original_top1='主胜')
       or (new.warning_direction='主队不败' and new.original_top1='客胜'))
     and (new.directional_domain_count >= 2 or
       (certified_abc and new.directional_domain_count >= 1))
     and new.source_frozen_at < new.kickoff_bjt
     and new.synced_at < least(new.kickoff_bjt,sale_at)
     and (not certified_abc or model_at <= new.source_frozen_at)
     and new.result_fields_used=false and new.hur_direction_used=false
     and new.pool_date >= date '2026-10-19' then
    insert into ninety_core.soren_daily_selection_locks_v1
      (pool_date,match_no,lock_type,source,source_payload)
    values (new.pool_date,new.match_no,'PRODUCTION_RISK','SOREN_IMPORTED_PUBLISHED_WARNING',
      jsonb_build_object('reason','COLD_WARNING_PUBLISHED',
        'source_frozen_at',new.source_frozen_at,
        'ruleVersion','DAILY-COLD-EXCLUSION-v1.1-20260928'))
    on conflict (pool_date,match_no,lock_type) do nothing;
  end if;
  return new;
end;
$function$;