-- Weekend final hour for the confirmed 23:00 Beijing sale cutoff.
-- Production: zssourkgabcxibggwhqm. Existing 04–13 UTC jobs remain in place.
-- Pre-change definitions are preserved in ninety_core.module_runtime_backups_v1
-- under dynamic_a_weekend_20261022_*.
-- pg_cron uses UTC. Hour 14 UTC is 22:00–22:59 Asia/Shanghai.
DO $$
DECLARE
  source_name text;
  target_name text;
  target_schedule text;
  source_command text;
  entries text[][] := ARRAY[
    ARRAY['hj38-official-collector-sg','dynamic-a-hj38-official-weekend','1,16,31,46 14 * * 0,6'],
    ARRAY['hj38-pool-collector-sg','dynamic-a-hj38-pool-weekend','3,18,33,48 14 * * 0,6'],
    ARRAY['hj38-market-collector-sg','dynamic-a-hj38-market-weekend','6,21,36,51 14 * * 0,6'],
    ARRAY['hj38-model-v87-sg','dynamic-a-hj38-model-weekend','9,24,39,54 14 * * 0,6'],
    ARRAY['ninety-soren-local-sync','dynamic-a-soren-sync-weekend','11,26,41,56 14 * * 0,6'],
    ARRAY['ninety-soren-william-shared','dynamic-a-william-sync-weekend','8,23,38,53 14 * * 0,6'],
    ARRAY['ninety-collector-close-weekend','dynamic-a-okooo-weekend','5,20,35,50 14 * * 0,6'],
    ARRAY['ninety-modules-hourly','dynamic-a-modules-weekend','14,29,44,59 14 * * 0,6']
  ];
  entry text[];
BEGIN
  FOREACH entry SLICE 1 IN ARRAY entries LOOP
    source_name := entry[1];
    target_name := entry[2];
    target_schedule := entry[3];
    SELECT command INTO STRICT source_command FROM cron.job WHERE jobname = source_name;
    IF target_name = 'dynamic-a-hj38-model-weekend' AND position(' WHERE EXISTS (' IN upper(source_command)) = 0 THEN
      source_command := rtrim(source_command, '; ')
        || ' WHERE EXISTS (SELECT 1 FROM ninety_core.hao_market_raw_william_v01 w'
        || ' WHERE w.pool_date=(now() at time zone ''Asia/Shanghai'')::date'
        || ' AND w.parse_status=''verified'' AND w.fetched_at >= now()-interval ''8 minutes'')'
        || ' AND EXISTS (SELECT 1 FROM ninety_core.hao_jc_sp_mirror_raw_v01 s'
        || ' WHERE s.pool_date=(now() at time zone ''Asia/Shanghai'')::date'
        || ' AND s.parse_status=''verified_mirror'' AND s.fetched_at >= now()-interval ''10 minutes'');';
    END IF;
    PERFORM cron.schedule(target_name, target_schedule, source_command);
  END LOOP;

  -- Use the same fresh-source gate in the existing daily model job.
  PERFORM cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname='hj38-model-v87-sg'),
    command => (SELECT command FROM cron.job WHERE jobname='dynamic-a-hj38-model-weekend')
  );

  PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='ninety-collector-close-weekend'), active => false);
  PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='ninety-modules-close-weekend'), active => false);
END $$;

-- To roll back the hour-14 change:
-- SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'dynamic-a-%-weekend';
-- SELECT cron.alter_job(jobid, active => true) FROM cron.job
-- WHERE jobname IN ('ninety-collector-close-weekend','ninety-modules-close-weekend');
-- Restore hj38-model-v87-sg.command from the backed-up definition
-- dynamic_a_weekend_20261022_hj38-model-v87-sg.
