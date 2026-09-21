-- Production schedule for verified result ingestion and automatic settlement.
-- Secrets stay in Supabase Vault; no service-role credential is stored here.
select cron.schedule(
  'soren_results_settlement_v1',
  '*/10 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='soren_project_url')
           || '/functions/v1/soren-core-collector-v1',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey',(select decrypted_secret from vault.decrypted_secrets where name='soren_anon_jwt'),
      'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='soren_anon_jwt')
    ),
    body := '{"mode":"results","lookback_days":14}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
