create or replace function public.soren_fast_locked_archive_rows_v1(p_date date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with expected as (
  select count(*)::int as n
  from public.soren_matches
  where pool_date = p_date
),
locked as (
  select count(*)::int as n
  from public.soren_sale_freezes_v1
  where pool_date = p_date
    and locked_at is not null
    and snapshot is not null
),
latest as (
  select distinct on (u.match_no)
    u.match_no,
    u.snapshot,
    u.source_frozen_at,
    u.captured_at
  from public.soren_prematch_updates_v1 u
  join public.soren_matches m
    on m.id = u.match_id
   and m.pool_date = p_date
  where u.pool_date = p_date
    and u.snapshot is not null
    and u.source_frozen_at < m.kickoff_at
    and u.captured_at < m.kickoff_at
    and coalesce((u.snapshot->>'pregameVerified')::boolean,false) = true
  order by u.match_no, u.source_frozen_at desc, u.captured_at desc
),
covered as (
  select count(*)::int as n from latest
)
select case
  when (select n from expected) > 0
   and (select n from locked) = (select n from expected)
   and (select n from covered) = (select n from expected)
  then coalesce((
    select jsonb_agg(
      l.snapshot ||
      jsonb_build_object(
        'predictionView','LATEST_PREMATCH_ONLY',
        'prematchLastCapturedAt',l.captured_at
      )
      order by l.match_no
    )
    from latest l
  ), '[]'::jsonb)
  else null
end;
$$;

revoke all on function public.soren_fast_locked_archive_rows_v1(date) from public;
grant execute on function public.soren_fast_locked_archive_rows_v1(date) to service_role;
