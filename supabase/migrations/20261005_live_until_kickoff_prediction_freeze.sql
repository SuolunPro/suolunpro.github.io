-- Keep every lawful prematch publication version, but do not freeze customer
-- prediction fields until the verified fixture kickoff.

create or replace function public.soren_capture_prematch_updates_v1(
  p_date date,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r jsonb;
  m public.soren_matches%rowtype;
  n text;
  t timestamptz;
  k timestamptz;
  c timestamptz;
  st timestamptz;
  saved int:=0;
  enriched int:=0;
  skipped int:=0;
  affected int:=0;
begin
  if p_date is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>120 then
    raise exception 'INVALID_PREMATCH_CAPTURE_INPUT';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    n:=lpad(coalesce(r->>'no',''),3,'0');
    if n !~ '^[0-9]{3}$' then
      skipped:=skipped+1;
      continue;
    end if;

    select * into m
    from public.soren_matches
    where pool_date=p_date and match_no=n;

    if not found then
      skipped:=skipped+1;
      continue;
    end if;

    c:=clock_timestamp();
    begin
      t:=(r->>'frozenAt')::timestamptz;
      k:=(r->>'kickoff')::timestamptz;
    exception when others then
      t:=null;
      k:=null;
    end;

    -- Prediction input is accepted only while both its source time and capture
    -- time are before kickoff. Result/settlement fields must all be absent.
    if r->>'pregameVerified' <> 'true'
       or coalesce(r->>'date','')<>p_date::text
       or coalesce(r->>'home','')<>m.home_team
       or coalesce(r->>'away','')<>m.away_team
       or coalesce(r->>'version','')<>'3.8'
       or r->>'resultVerified'='true'
       or nullif(r->>'result','') is not null
       or nullif(r->>'resultHome','') is not null
       or nullif(r->>'resultAway','') is not null
       or nullif(r->>'resultScore','') is not null
       or nullif(r->>'resultSource','') is not null
       or nullif(r->>'resultVerifiedAt','') is not null
       or nullif(r->>'top1Hit','') is not null
       or nullif(r->>'coverageHit','') is not null
       or nullif(r->>'handicapResult','') is not null
       or nullif(r->>'handicapHit','') is not null
       or coalesce(r->>'ftTop1','') not in ('主胜','平','客胜','H','D','A','3','1','0')
       or t is null or k is null
       or abs(extract(epoch from (k-m.kickoff_at)))>120
       or t>c or t>=m.kickoff_at or c>=m.kickoff_at
    then
      skipped:=skipped+1;
      continue;
    end if;

    st:=null;
    if jsonb_typeof(r->'scoreTop4')='object' then
      begin
        st:=nullif(r->'scoreTop4'->>'frozenAt','')::timestamptz;
      exception when others then
        st:=null;
      end;
    end if;

    insert into public.soren_prematch_updates_v1(
      match_id,pool_date,match_no,source_frozen_at,snapshot,captured_at
    )
    values(m.id,p_date,n,t,r,c)
    on conflict (match_id,source_frozen_at) do update
      set snapshot=jsonb_set(
        public.soren_prematch_updates_v1.snapshot,
        '{scoreTop4}',
        excluded.snapshot->'scoreTop4',
        true
      )
      where public.soren_prematch_updates_v1.snapshot->'scoreTop4' is null
        and jsonb_typeof(excluded.snapshot->'scoreTop4')='object'
        and excluded.snapshot->'scoreTop4'->>'pregameVerified'='true'
        and st is not null
        and st<=t
        and st<m.kickoff_at
        and st<=c
        and coalesce(excluded.snapshot->'scoreTop4'->>'resultHome','')=''
        and coalesce(excluded.snapshot->'scoreTop4'->>'resultAway','')=''
        and coalesce(excluded.snapshot->'scoreTop4'->>'resultSource','')=''
        and coalesce(excluded.snapshot->'scoreTop4'->>'settlementStatus','PENDING')='PENDING';

    get diagnostics affected=row_count;
    if affected=1 then
      if exists (
        select 1
        from public.soren_prematch_updates_v1 u
        where u.match_id=m.id and u.source_frozen_at=t
          and u.captured_at=c
      ) then
        saved:=saved+1;
      else
        enriched:=enriched+1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'saved',saved,
    'enriched',enriched,
    'skipped',skipped,
    'date',p_date
  );
end
$function$;

create or replace function public.soren_capture_sale_snapshots_v1(
  p_date date,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r jsonb;
  m public.soren_matches%rowtype;
  s public.soren_sale_freezes_v1%rowtype;
  u public.soren_prematch_updates_v1%rowtype;
  n text;
  t timestamptz;
  k timestamptz;
  current_time_ timestamptz;
  valid boolean;
  out_rows jsonb:='[]'::jsonb;
begin
  if p_date is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>120 then
    raise exception 'INVALID_FREEZE_INPUT';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    n:=lpad(coalesce(r->>'no',''),3,'0');
    if n !~ '^[0-9]{3}$' then continue; end if;

    select * into m
    from public.soren_matches
    where pool_date=p_date and match_no=n;

    if not found then
      out_rows:=out_rows||jsonb_build_array(jsonb_build_object('no',n,'status','MATCH_NOT_VERIFIED'));
      continue;
    end if;

    current_time_:=clock_timestamp();
    begin
      t:=(r->>'frozenAt')::timestamptz;
      k:=(r->>'kickoff')::timestamptz;
    exception when others then
      t:=null;
      k:=null;
    end;

    valid:=r->>'pregameVerified'='true'
      and coalesce(r->>'date','')=p_date::text
      and coalesce(r->>'home','')=m.home_team
      and coalesce(r->>'away','')=m.away_team
      and coalesce(r->>'version','')='3.8'
      and r->>'resultVerified'<>'true'
      and nullif(r->>'result','') is null
      and nullif(r->>'resultHome','') is null
      and nullif(r->>'resultAway','') is null
      and nullif(r->>'resultScore','') is null
      and nullif(r->>'top1Hit','') is null
      and nullif(r->>'coverageHit','') is null
      and nullif(r->>'handicapResult','') is null
      and t is not null and k is not null
      and abs(extract(epoch from (k-m.kickoff_at)))<120
      and t<=current_time_ and t<m.kickoff_at
      and coalesce(r->>'ftTop1','') in ('主胜','平','客胜','H','D','A','3','1','0');

    select * into s
    from public.soren_sale_freezes_v1
    where match_id=m.id
    for update;

    if current_time_<m.kickoff_at then
      -- Preserve an existing early audit row exactly as recorded. It is not a
      -- customer freeze; current live output comes from prematch version history.
      if not found and valid then
        insert into public.soren_sale_freezes_v1(
          match_id,pool_date,match_no,snapshot,source_frozen_at,captured_at,
          refreshed_at,locked_at,lock_reason,cutoff_at
        )
        values(m.id,p_date,n,r,t,current_time_,current_time_,null,null,m.kickoff_at)
        returning * into s;
      end if;
    elsif not found or coalesce(s.lock_reason,'')<>'KICKOFF_FINAL' then
      select * into u
      from public.soren_prematch_updates_v1 pu
      where pu.match_id=m.id
        and pu.source_frozen_at<m.kickoff_at
        and pu.captured_at<m.kickoff_at
        and pu.snapshot->>'pregameVerified'='true'
        and pu.snapshot->>'resultVerified'<>'true'
        and nullif(pu.snapshot->>'result','') is null
        and nullif(pu.snapshot->>'resultHome','') is null
        and nullif(pu.snapshot->>'resultAway','') is null
        and nullif(pu.snapshot->>'resultScore','') is null
      order by pu.source_frozen_at desc,pu.captured_at desc
      limit 1;

      if u.match_id is not null then
        if s.match_id is null then
          insert into public.soren_sale_freezes_v1(
            match_id,pool_date,match_no,snapshot,source_frozen_at,captured_at,
            refreshed_at,locked_at,lock_reason,cutoff_at
          )
          values(m.id,p_date,n,u.snapshot,u.source_frozen_at,u.captured_at,
            current_time_,m.kickoff_at,'KICKOFF_FINAL',m.kickoff_at)
          returning * into s;
        else
          update public.soren_sale_freezes_v1
          set snapshot=u.snapshot,
              source_frozen_at=u.source_frozen_at,
              captured_at=u.captured_at,
              refreshed_at=current_time_,
              locked_at=m.kickoff_at,
              lock_reason='KICKOFF_FINAL',
              cutoff_at=m.kickoff_at
          where match_id=m.id
          returning * into s;
        end if;
      elsif s.match_id is not null
        and s.source_frozen_at<m.kickoff_at
        and s.snapshot->>'pregameVerified'='true'
        and s.snapshot->>'resultVerified'<>'true'
      then
        update public.soren_sale_freezes_v1
        set refreshed_at=current_time_,
            locked_at=m.kickoff_at,
            lock_reason='KICKOFF_FINAL',
            cutoff_at=m.kickoff_at
        where match_id=m.id
        returning * into s;
      end if;
    end if;

    if s.match_id is not null then
      out_rows:=out_rows||jsonb_build_array(jsonb_build_object(
        'no',n,
        'status',case
          when current_time_<m.kickoff_at then 'LIVE'
          when s.lock_reason='KICKOFF_FINAL' then 'KICKOFF_FINAL'
          else 'NO_VALID_PREMATCH_LOCK'
        end,
        'snapshot',s.snapshot,
        'sourceFrozenAt',s.source_frozen_at,
        'capturedAt',s.captured_at,
        'lockedAt',case when s.lock_reason='KICKOFF_FINAL' then s.locked_at else null end,
        'cutoffAt',m.kickoff_at
      ));
    else
      out_rows:=out_rows||jsonb_build_array(jsonb_build_object(
        'no',n,
        'status',case when current_time_<m.kickoff_at then 'PENDING_VALID_PUBLICATION' else 'NO_VALID_PREMATCH_LOCK' end,
        'cutoffAt',m.kickoff_at
      ));
    end if;
  end loop;

  return out_rows;
end
$function$;
