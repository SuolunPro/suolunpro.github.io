-- An upset in the module pipeline disqualifies that fixture from customer Daily Picks
-- for its entire pool date, even if the warning later clears. Historical rows
-- stay intact; the backfill is limited to the currently open pool.
CREATE OR REPLACE FUNCTION ninety_core.lock_daily_pick_from_module_upset_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  v_date date;
  v_no text;
BEGIN
  SELECT m.match_date, m.match_no INTO v_date, v_no
  FROM ninety_core.match_pool m
  WHERE m.match_key = NEW.match_key AND m.status <> 'invalid_test';
  IF v_date IS NULL THEN RETURN NEW; END IF;
  INSERT INTO ninety_core.soren_daily_selection_locks_v1
    (pool_date, match_no, lock_type, source, source_payload, locked_at)
  VALUES
    (v_date, v_no, 'PRODUCTION_RISK', 'NINETY_MODULE_UPSET_EXCLUSION',
     jsonb_build_object('match_key',NEW.match_key,'triggered_at',NEW.triggered_at),
     NEW.triggered_at)
  ON CONFLICT (pool_date,match_no,lock_type) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lock_daily_pick_from_module_upset_v1
AFTER INSERT ON ninety_core.upset_exclusions
FOR EACH ROW EXECUTE FUNCTION ninety_core.lock_daily_pick_from_module_upset_v1();

INSERT INTO ninety_core.soren_daily_selection_locks_v1
  (pool_date,match_no,lock_type,source,source_payload,locked_at)
SELECT m.match_date,m.match_no,'PRODUCTION_RISK','NINETY_MODULE_UPSET_EXCLUSION',
       jsonb_build_object('match_key',e.match_key,'triggered_at',e.triggered_at),
       e.triggered_at
FROM ninety_core.upset_exclusions e
JOIN ninety_core.match_pool m ON m.match_key=e.match_key
WHERE m.match_date=(now() AT TIME ZONE 'Asia/Shanghai')::date
  AND m.status <> 'invalid_test'
ON CONFLICT (pool_date,match_no,lock_type) DO NOTHING;

-- Rollback: DROP TRIGGER trg_lock_daily_pick_from_module_upset_v1
-- ON ninety_core.upset_exclusions; DROP FUNCTION
-- ninety_core.lock_daily_pick_from_module_upset_v1();
-- Review source='NINETY_MODULE_UPSET_EXCLUSION' locks before removing them;
-- removing a valid risk lock can make a match eligible again.
