import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from snapshots import freeze

class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.fixture={"fixture_id":"DEMO","kickoff":"2026-11-05T20:00:00+08:00",
                      "collected_at":"2026-11-04T16:00:00+08:00","source":"synthetic test"}
    def test_write_once(self):
        with tempfile.TemporaryDirectory() as folder:
            a=freeze(self.fixture,folder)
            self.assertEqual(json.loads(Path(a["path"]).read_text())["fixture_id"],"DEMO")
            with self.assertRaises(FileExistsError):
                freeze(self.fixture,folder)
    def test_reject_postmatch(self):
        with tempfile.TemporaryDirectory() as folder:
            self.fixture["collected_at"]="2026-11-06T16:00:00+08:00"
            with self.assertRaises(ValueError):
                freeze(self.fixture,folder)
if __name__=="__main__":
    unittest.main()
