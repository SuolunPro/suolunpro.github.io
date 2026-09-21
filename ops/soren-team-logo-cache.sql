create table if not exists public.soren_team_logo_cache (
  fotmob_team_id bigint primary key,
  source text not null default 'fotmob',
  canonical_name text not null,
  chinese_names text[] not null default '{}'::text[],
  bucket_id text not null default 'team-logos',
  object_path text,
  mime_type text,
  byte_size bigint,
  etag text,
  cache_status text not null default 'pending' check (cache_status in ('pending','cached','missing','error')),
  source_url text,
  last_error text,
  fetched_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.soren_team_logo_cache enable row level security;
grant select on public.soren_team_logo_cache to anon, authenticated;

drop policy if exists "public_read_cached_team_logos" on public.soren_team_logo_cache;
create policy "public_read_cached_team_logos"
on public.soren_team_logo_cache for select
to anon, authenticated
using (cache_status = 'cached' and object_path is not null);

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('team-logos','team-logos',true,1048576,array['image/png','image/jpeg','image/webp','image/svg+xml'])
on conflict (id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create index if not exists soren_team_logo_cache_status_updated_idx
on public.soren_team_logo_cache(cache_status,updated_at);

-- Daily at 03:20 Asia/Shanghai (19:20 UTC). Existing cached files are reused;
-- only new, missing, failed, or 30-day-stale logos are fetched.
do $$
declare jid bigint;
begin
  select jobid into jid from cron.job where jobname='soren_team_logo_cache_daily_v1';
  if jid is not null then perform cron.unschedule(jid); end if;
end $$;

select cron.schedule(
  'soren_team_logo_cache_daily_v1',
  '20 19 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='soren_project_url') || '/functions/v1/soren-team-logo-cache-v1',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey',(select decrypted_secret from vault.decrypted_secrets where name='soren_anon_jwt'),
      'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='soren_anon_jwt')
    ),
    body := '{"mode":"sync","limit":120}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cron$
);
