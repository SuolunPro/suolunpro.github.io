-- Every two minutes, rotate among unfrozen current-day matches.
select cron.schedule('ninety-soren-fotmob-xg-strict-v1','*/2 0-14 * * *',$job$
select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name='ninety_project_url')
       || '/functions/v1/ninety-soren-fotmob-xg-v1',
  headers := jsonb_build_object('Content-Type','application/json',
       'x-ninety-collector-token',(select decrypted_secret from vault.decrypted_secrets where name='ninety_collector_token')),
  body := '{}'::jsonb, timeout_milliseconds := 120000
)
$job$);
