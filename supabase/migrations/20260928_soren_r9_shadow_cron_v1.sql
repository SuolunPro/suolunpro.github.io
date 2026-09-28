do $$
begin
  if not exists (
    select 1 from cron.job where jobname = 'soren_r9_shadow_refresh_v1'
  ) then
    perform cron.schedule(
      'soren_r9_shadow_refresh_v1',
      '5,35 * * * *',
      $cmd$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name='soren_project_url')
               || '/functions/v1/soren-r9-shadow-v1',
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'apikey',(select decrypted_secret from vault.decrypted_secrets where name='soren_anon_jwt'),
          'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='soren_anon_jwt'),
          'x-soren-intel-key',(select decrypted_secret from vault.decrypted_secrets where name='soren_intel_internal')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
      $cmd$
    );
  end if;
end $$;
