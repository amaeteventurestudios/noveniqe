"""Tests for novenique_backup.py: python3 -m unittest discover -s ops/backup"""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import novenique_backup as nb


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        self.data, self.root = t / "srv", t / "backups"
        (self.data / "pal/pb_data/storage").mkdir(parents=True)
        (self.data / "pal/pb_data/storage/avatar.txt").write_text("png")
        # a live WAL database with an open writer, like PocketBase
        self.live = sqlite3.connect(self.data / "pal/pb_data/data.db")
        self.live.execute("pragma journal_mode=wal")
        self.live.execute("create table users (id integer primary key, name text)")
        self.live.executemany("insert into users (name) values (?)", [("a",), ("b",), ("c",)])
        self.live.commit()
        eco = sqlite3.connect(self.data / "pal/economy.db")
        eco.execute("create table journal (id integer primary key, amount integer)")
        eco.execute("insert into journal (amount) values (5)")
        eco.commit()
        eco.close()
        (self.data / "app.env").write_text("SECRET=x\n")
        self.cfg = {"root": str(self.root), "keep": 2, "sets": [
            {"name": "palasora", "sqlite": [f"{self.data}/pal/pb_data/*.db", f"{self.data}/pal/*.db"],
             "copy": [f"{self.data}/pal/pb_data/storage", f"{self.data}/app.env"]},
            {"name": "agent-grand-prix", "sqlite": [f"{self.data}/agp/*.db"], "copy": [f"{self.data}/agp/state.json"]},
        ]}

    def tearDown(self):
        self.live.close()
        self.tmp.cleanup()

    def test_backup_verify_drill_restore(self):
        b = nb.backup(self.cfg, self.root)
        man = json.loads((b / "MANIFEST.json").read_text())
        kinds = {Path(f["path"]).name: f for f in man["files"]}
        self.assertEqual(kinds["data.db"]["rows"], {"users": 3})
        self.assertEqual(kinds["economy.db"]["rows"], {"journal": 1})
        self.assertIn("avatar.txt", kinds)
        self.assertIn("app.env", kinds)
        # a product that isn't installed is skipped, not an error
        self.assertEqual(len(man["sets"]["agent-grand-prix"]["missing"]), 2)
        self.assertTrue(nb.verify(b)["ok"])
        d = nb.drill(self.root)
        self.assertTrue(d["ok"], d)
        self.assertEqual(d["sqlite_checked"], 2)
        self.assertTrue((self.root / "LAST_DRILL.json").exists())
        out = Path(self.tmp.name) / "restored"
        nb.restore(b, "palasora", out)
        got = sqlite3.connect(out / str(self.data / "pal/pb_data/data.db").lstrip("/"))
        self.assertEqual(got.execute("select count(*) from users").fetchone()[0], 3)
        got.close()
        with self.assertRaises(SystemExit):
            nb.restore(b, "palasora", out)  # never over a folder that has something in it

    def test_tampering_is_caught(self):
        b = nb.backup(self.cfg, self.root)
        f = next(p for p in b.rglob("avatar.txt"))
        f.write_text("changed")
        self.assertFalse(nb.verify(b)["ok"])
        self.assertFalse(nb.drill(self.root, b)["ok"])

    def test_keep_and_status(self):
        for _ in range(3):
            nb.backup(self.cfg, self.root)
        self.assertEqual(nb.prune(self.root, 2).__len__(), 1)
        s = nb.status(self.root)
        self.assertEqual(s["count"], 2)
        self.assertLess(s["age_hours"], 1)
        self.assertFalse(any(p.name.startswith(".partial") for p in self.root.iterdir()))


if __name__ == "__main__":
    unittest.main()
