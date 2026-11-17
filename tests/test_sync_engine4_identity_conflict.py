"""Regression tests for safe sales-day fixture identity reconciliation."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from scripts.sync_engine4 import main


def fixture(away, verified=False):
    m = {
        "source_id": "503109631", "match_no": "003",
        "home": "日本", "away": away,
        "kickoff": "2026-11-17 21:10",
        "predicted_at": "2026-11-16T20:27:15+00:00",
        "prediction": {"top1": "主胜"},
        "result_verification": {"status": "PENDING"},
    }
    if verified:
        m["settlement"] = {"ft": "1-0"}
        m["result_verification"] = {"status": "VERIFIED"}
    return m


def document(away, verified=False):
    return {
        "sale_day": "2026-11-17",
        "generated_at": "2026-11-16T20:28:49+00:00",
        "matches": [fixture(away, verified)],
        "metrics": {"total": 1, "settled": int(verified), "pending": int(not verified)},
    }


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


class IdentityConflictTests(unittest.TestCase):
    def test_approved_conflict_archived_and_merged(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            src, dst = root / "src", root / "dst"
            old = document("乌拉圭")
            new = document("巴拉圭")
            write(src / "sales/2026-11-17.json", new)
            write(src / "latest.json", new)
            write(dst / "sales/2026-11-17.json", old)
            main(src, dst)
            published = json.loads((dst / "sales/2026-11-17.json").read_text())
            self.assertEqual(len(published["matches"]), 1)
            self.assertEqual(published["matches"][0]["away"], "巴拉圭")
            archive = dst / "identity_conflicts/2026-11-17_503109631_old.json"
            self.assertEqual(json.loads(archive.read_text()), old["matches"][0])

    def test_verified_conflict_blocks_without_overwriting(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            src, dst = root / "src", root / "dst"
            old = document("乌拉圭", verified=True)
            new = document("巴拉圭")
            write(src / "sales/2026-11-17.json", new)
            write(dst / "sales/2026-11-17.json", old)
            original = (dst / "sales/2026-11-17.json").read_bytes()
            with self.assertRaisesRegex(ValueError, "Verified fixture identity conflict"):
                main(src, dst)
            self.assertEqual((dst / "sales/2026-11-17.json").read_bytes(), original)

    def test_unapproved_conflict_blocks_without_overwriting(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            src, dst = root / "src", root / "dst"
            old = document("乌拉圭")
            new = document("其他球队")
            write(src / "sales/2026-11-17.json", new)
            write(dst / "sales/2026-11-17.json", old)
            original = (dst / "sales/2026-11-17.json").read_bytes()
            with self.assertRaisesRegex(ValueError, "Unapproved fixture identity conflict"):
                main(src, dst)
            self.assertEqual((dst / "sales/2026-11-17.json").read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
