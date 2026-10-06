-- KICKOFF_ARCHIVE_GUARD_V2
-- Prevent a Beijing date rollover from making an unfinished pool eligible for
-- fast archive reads. This is a database-level invariant, independent of the
-- currently deployed Edge Function version.

create or replace function public.soren_archive_day_fully_started_v1(p_date date)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.soren_matches where pool_date = p_date
  )
  and not exists (
    select 1
    from public.soren_matches
    where pool_date = p_date
      and (kickoff_at is null or kickoff_at > now())
  );
$function$;

revoke all on function public.soren_archive_day_fully_started_v1(date) from public, anon, authenticated;
grant execute on function public.soren_archive_day_fully_started_v1(date) to service_role;

do $patch$
declare
  v_oid oid;
  v_def text;
  v_new text;
begin
  select p.oid into v_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'soren_fast_archive_bundle_v2'
    and pg_get_function_identity_arguments(p.oid) = 'p_date date';

  if v_oid is null then
    raise exception 'soren_fast_archive_bundle_v2(date) not found';
  end if;

  v_def := pg_get_functiondef(v_oid);
  if position('soren_archive_day_fully_started_v1(p_date)' in v_def) = 0 then
    v_new := replace(
      v_def,
      'or (select n from locked)=(select n from expected)',
      'or ((select n from locked)=(select n from expected)' || chr(10) ||
      '       and public.soren_archive_day_fully_started_v1(p_date))'
    );
    if v_new = v_def then
      raise exception 'bundle guard anchor not found';
    end if;
    execute v_new;
  end if;

  select p.oid into v_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'soren_fast_locked_archive_rows_v1'
    and pg_get_function_identity_arguments(p.oid) = 'p_date date';

  if v_oid is null then
    raise exception 'soren_fast_locked_archive_rows_v1(date) not found';
  end if;

  v_def := pg_get_functiondef(v_oid);
  if position('soren_archive_day_fully_started_v1(p_date)' in v_def) = 0 then
    v_new := replace(
      v_def,
      'and (select n from locked) = (select n from expected)',
      'and (select n from locked) = (select n from expected)' || chr(10) ||
      '   and public.soren_archive_day_fully_started_v1(p_date)'
    );
    if v_new = v_def then
      raise exception 'locked archive guard anchor not found';
    end if;
    execute v_new;
  end if;
end
$patch$;
