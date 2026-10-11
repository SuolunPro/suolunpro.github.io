-- Safe past-day fallback for exactly one genuinely missing lawful prematch fixture.
-- Keeps the v1 output byte-for-byte when the original all-fixtures gate passes.
CREATE OR REPLACE FUNCTION public.soren_fast_locked_archive_rows_safe_v2(p_date date)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    public.soren_fast_locked_archive_rows_v1(p_date),
    case when public.soren_archive_day_fully_started_v1(p_date)
      then (public.soren_fast_archive_bundle_safe_v3(p_date))->'rows'
      else null
    end
  );
$function$;

REVOKE ALL ON FUNCTION public.soren_fast_locked_archive_rows_safe_v2(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.soren_fast_locked_archive_rows_safe_v2(date) TO service_role, postgres;
