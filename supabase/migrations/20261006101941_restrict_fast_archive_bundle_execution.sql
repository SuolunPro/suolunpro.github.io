revoke all on function public.soren_fast_archive_bundle_v2(date) from public;
revoke all on function public.soren_fast_archive_bundle_v2(date) from anon;
revoke all on function public.soren_fast_archive_bundle_v2(date) from authenticated;
grant execute on function public.soren_fast_archive_bundle_v2(date) to service_role;
