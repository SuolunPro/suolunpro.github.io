-- Dynamic A: preserve valid customer output until sale cutoff and avoid repeat publishes.
-- Original function and cron definitions: ninety_core.module_runtime_backups_v1, tags dynamic_a_20261022_*_pre.
CREATE OR REPLACE FUNCTION public.ninety_publish_modules(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_date date := (p_payload->>'date')::date;
  v_match jsonb;
  v_output jsonb;
  v_match_key text;
  v_module text;
  v_written integer := 0;
  v_exclusions integer := 0;
  v_kickoff timestamptz;
  v_sale timestamptz;
  v_written_row integer;
  v_written_modules text[] := array[]::text[];
begin
  if jsonb_typeof(p_payload->'matches') is distinct from 'array' then
    raise exception 'matches must be an array';
  end if;

  for v_match in select item from jsonb_array_elements(p_payload->'matches') as matches(item)
  loop
    v_match_key := nullif(v_match->>'match_key','');
    select mp.kickoff_at,
      least(
        ((mp.match_date::text || case when extract(isodow from mp.match_date) in (6,7) then ' 23:00:00' else ' 22:00:00' end)::timestamp at time zone 'Asia/Shanghai'),
        coalesce(sm.cutoff_at, 'infinity'::timestamptz),
        coalesce(o.cutoff_local at time zone 'Asia/Shanghai', 'infinity'::timestamptz)
      )
      into v_kickoff,v_sale
    from ninety_core.match_pool mp
    left join ninety_core.soren_matches sm on sm.pool_date=mp.match_date and sm.match_no=mp.match_no
    left join ninety_core.jc_offerings_2026 o on o.offer_date=mp.match_date and lpad(o.match_no::text,3,'0')=mp.match_no
    where mp.match_key=v_match_key and mp.match_date=v_date and mp.status<>'invalid_test';
    if v_kickoff is null or clock_timestamp() >= least(v_sale,v_kickoff - interval '10 minutes') then
      continue;
    end if;

    for v_output in
      select item from jsonb_array_elements(coalesce(v_match->'outputs','[]'::jsonb)) as outputs(item)
    loop
      v_module := nullif(v_output->>'module','');
      if v_module not in ('ft','handicap','score_top3','score_top4','htft_top3','total_goals','upset_warning','daily_selection') then
        continue;
      end if;

      -- Atomic publication gate: an invalid READY payload must not replace
      -- a valid frozen Top3/Top4 or appear as a successful prediction.
      if v_output->'payload'->>'status'='READY'
         and v_module in ('ft','handicap','score_top3','score_top4',
                          'htft_top3','total_goals') then
        if v_module='score_top4' then
          if (case when jsonb_typeof(v_output->'payload'->'top4')='array'
       then jsonb_array_length(v_output->'payload'->'top4') else 0 end)<>4 then
            continue;
          end if;
        else
          if (case when jsonb_typeof(v_output->'payload'->'top3')='array'
       then jsonb_array_length(v_output->'payload'->'top3') else 0 end)<>3 then
            continue;
          end if;
        end if;
      end if;

      if v_module='upset_warning'
         and coalesce((v_output->'payload'->>'triggered')::boolean,false) then
        insert into ninety_core.upset_exclusions(match_key,triggered_at,reason)
        values(v_match_key,now(),nullif(v_output->'payload'->>'reason',''))
        on conflict(match_key) do nothing;
        v_exclusions := v_exclusions + 1;
      end if;

      if v_module='daily_selection'
         and exists(select 1 from ninety_core.upset_exclusions ux where ux.match_key=v_match_key) then
        v_output := jsonb_set(
          jsonb_set(v_output,'{payload,status}','"PASS"'::jsonb,true),
          '{payload,reason}','"upset_warning_hard_exclusion"'::jsonb,true
        );
      end if;

      insert into ninety_core.module_outputs(match_key,module,revision,payload,quality,produced_at)
      values(
        v_match_key,
        v_module,
        coalesce(nullif(v_output->>'revision',''),'singapore_shadow_v1'),
        coalesce(v_output->'payload','{}'::jsonb),
        case when v_output->>'quality' in ('formal','provisional','pass')
             then v_output->>'quality' else 'provisional' end,
        now()
      )
      on conflict(match_key,module) do update set
        revision=excluded.revision,
        payload=excluded.payload,
        quality=excluded.quality,
        produced_at=excluded.produced_at
      where (
        ninety_core.module_outputs.revision,
        ninety_core.module_outputs.payload,
        ninety_core.module_outputs.quality
      ) is distinct from (
        excluded.revision, excluded.payload, excluded.quality
      )
      and not (
        ninety_core.module_outputs.module in
          ('ft','handicap','score_top3','score_top4','htft_top3','total_goals')
        and ninety_core.module_outputs.payload->>'status'='READY'
        and coalesce(excluded.payload->>'status','')<>'READY'
      );
      get diagnostics v_written_row = row_count;
      v_written := v_written + v_written_row;
      if v_written_row > 0 then v_written_modules := array_append(v_written_modules,v_module); end if;
    end loop;
  end loop;

  insert into ninety_core.publish_versions(module,match_date,version,published_at)
  select distinct module_name,v_date,1,now()
  from unnest(v_written_modules) as module_name
  on conflict(module,match_date) do update set
    version=ninety_core.publish_versions.version+1,
    published_at=now();

  return jsonb_build_object('ok',true,'date',v_date,'outputs_written',v_written,'upset_exclusions_locked',v_exclusions);
end;
$function$


-- Reuse the existing module task after the :09/:24/:39/:54 formal model cycle.
select cron.alter_job((select jobid from cron.job where jobname='ninety-modules-hourly'), schedule => '14,29,44,59 4-13 * * *');
select cron.alter_job((select jobid from cron.job where jobname='ninety-modules-close-weekday'), active => false);
