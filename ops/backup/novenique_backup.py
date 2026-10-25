#!/usr/bin/env python3
"""Novenique server backups: every product on the shared Oracle server, one folder per night.

Standard library only, so it runs with the server's own python3 (no venv, no sqlite3 CLI).

  backup  [--config sources.json] [--root DIR] [--keep N]  -> <root>/novenique-<UTC ts>/ with MANIFEST.json + SHA256SUMS
  verify  <backup_dir>                                     -> re-hash every file against the manifest
  drill   [--root DIR] [<backup_dir>]                      -> verify, open every SQLite copy in a scratch folder, check it is
                                                              intact and its row counts match the manifest; live data is never
                                                              touched. Writes <root>/LAST_DRILL.json
  restore <backup_dir> <set> <target_dir>                  -> copy one product's files into an EMPTY folder (never in place)
  status  [--root DIR]                                     -> newest backup, its age and the last drill, as JSON

What is copied comes from sources.json: per product ("set"), SQLite files (copied with SQLite's online backup API, so
services keep running) and plain files or folders (copied as they are). Missing sources are skipped and listed in the
manifest, so one config serves a server where a product is not installed yet. Inside a backup, every source keeps its
absolute path under <set>/ (for example palasora/var/lib/palasora/data/economy.db), so a restore never has to guess.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

FORMAT = "novenique-backup-v1"
PREFIX = "novenique-"
HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = Path("/var/backups/novenique")


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def online_backup(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    s = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=30)
    d = sqlite3.connect(str(dst))
    try:
        s.backup(d, pages=1024, sleep=0.005)
        # the copy of a WAL database is in WAL mode too; keep it one self-contained file (no -wal/-shm beside it)
        d.execute("PRAGMA journal_mode=DELETE").fetchone()
    finally:
        d.close()
        s.close()


def _ro(p: Path) -> sqlite3.Connection:
    # immutable=1: read a copy without creating -wal/-shm files beside it
    return sqlite3.connect(f"file:{p}?mode=ro&immutable=1", uri=True)


def integrity(p: Path) -> str:
    c = _ro(p)
    try:
        return str(c.execute("pragma integrity_check").fetchone()[0])
    finally:
        c.close()


def counts(p: Path, limit: int = 200) -> dict[str, int]:
    c = _ro(p)
    try:
        names = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]
        return {t: int(c.execute(f'select count(*) from "{t}"').fetchone()[0]) for t in names[:limit]}
    finally:
        c.close()


def _expand(patterns: list[str]) -> tuple[list[Path], list[str]]:
    found, missing = [], []
    for pat in patterns:
        hits = sorted(glob.glob(pat))
        if hits:
            found += [Path(h) for h in hits]
        else:
            missing.append(pat)
    return found, missing


def _inside(set_dir: Path, src: Path) -> Path:
    return set_dir / str(src).lstrip("/")


def _copy_any(src: Path, dst: Path) -> list[Path]:
    """Copy a file or a whole folder; returns every file written."""
    if src.is_dir():
        shutil.copytree(src, dst, symlinks=True, dirs_exist_ok=True)
        return [p for p in dst.rglob("*") if p.is_file() and not p.is_symlink()]
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return [dst]


def load_config(path: Path) -> dict:
    cfg = json.loads(path.read_text())
    if not isinstance(cfg.get("sets"), list):
        raise SystemExit(f"{path}: needs a 'sets' list")
    return cfg


def backup(cfg: dict, root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    stamp = now()
    name = PREFIX + stamp
    n = 1
    while (root / name).exists():
        n += 1
        name = f"{PREFIX}{stamp}-{n}"
    part = root / f".partial-{name}"
    if part.exists():
        shutil.rmtree(part)
    part.mkdir(mode=0o700)
    started = time.time()
    files: list[dict] = []
    sets: dict[str, dict] = {}
    try:
        for s in cfg["sets"]:
            set_dir = part / s["name"]
            sq, sq_missing = _expand(s.get("sqlite", []))
            cp, cp_missing = _expand(s.get("copy", []))
            for src in sq:
                dst = _inside(set_dir, src)
                online_backup(src, dst)
                ok = integrity(dst)
                if ok != "ok":
                    raise RuntimeError(f"{src}: the copy failed its integrity check ({ok})")
                files.append({"set": s["name"], "path": str(dst.relative_to(part)), "source": str(src), "kind": "sqlite",
                              "integrity": ok, "rows": counts(dst)})
            for src in cp:
                for dst in _copy_any(src, _inside(set_dir, src)):
                    files.append({"set": s["name"], "path": str(dst.relative_to(part)), "source": str(src), "kind": "file"})
            sets[s["name"]] = {"sqlite": len(sq), "copied_sources": len(cp), "missing": sq_missing + cp_missing}
        for f in files:
            p = part / f["path"]
            f["size"], f["sha256"] = p.stat().st_size, sha256(p)
        manifest = {"format": FORMAT, "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "host": os.uname().nodename, "seconds": round(time.time() - started, 2), "sets": sets, "files": files}
        (part / "MANIFEST.json").write_text(json.dumps(manifest, indent=1))
        (part / "SHA256SUMS").write_text("".join(f"{f['sha256']}  {f['path']}\n" for f in files))
        part.rename(root / name)
    except BaseException:
        shutil.rmtree(part, ignore_errors=True)
        raise
    return root / name


def backups(root: Path) -> list[Path]:
    return sorted((p for p in root.glob(PREFIX + "*") if p.is_dir() and (p / "MANIFEST.json").exists()), key=lambda p: p.name)


def prune(root: Path, keep: int) -> list[str]:
    gone = []
    for p in backups(root)[:-keep] if keep > 0 else []:
        shutil.rmtree(p)
        gone.append(p.name)
    return gone


def verify(bdir: Path) -> dict:
    man = json.loads((bdir / "MANIFEST.json").read_text())
    if man.get("format") != FORMAT:
        return {"ok": False, "problems": [f"unknown format {man.get('format')!r}"]}
    problems = []
    for f in man["files"]:
        p = bdir / f["path"]
        if not p.is_file():
            problems.append(f"missing {f['path']}")
        elif p.stat().st_size != f["size"] or sha256(p) != f["sha256"]:
            problems.append(f"changed {f['path']}")
    return {"ok": not problems, "files": len(man["files"]), "problems": problems}


def drill(root: Path, bdir: Path | None = None) -> dict:
    bdir = bdir or (backups(root) or [None])[-1]
    if bdir is None:
        return {"ok": False, "problems": ["no backup to drill"]}
    v = verify(bdir)
    problems = list(v["problems"])
    man = json.loads((bdir / "MANIFEST.json").read_text())
    checked = 0
    with tempfile.TemporaryDirectory(prefix="novenique-drill-") as tmp:
        for f in man["files"]:
            if f["kind"] != "sqlite":
                continue
            copy = Path(tmp) / f["path"]
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(bdir / f["path"], copy)
            ok = integrity(copy)
            if ok != "ok":
                problems.append(f"{f['path']}: integrity {ok}")
            elif counts(copy) != f["rows"]:
                problems.append(f"{f['path']}: row counts differ from the manifest")
            checked += 1
    out = {"ok": not problems, "backup": bdir.name, "files": v.get("files", 0), "sqlite_checked": checked, "problems": problems,
           "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    if root.is_dir():
        (root / "LAST_DRILL.json").write_text(json.dumps(out, indent=1))
    return out


def restore(bdir: Path, set_name: str, target: Path) -> dict:
    v = verify(bdir)
    if not v["ok"]:
        raise SystemExit(f"{bdir.name} failed verification: {v['problems'][:5]}")
    if target.exists() and any(target.iterdir()):
        raise SystemExit(f"{target} is not empty: restore into an empty folder, then move files into place by hand")
    src = bdir / set_name
    if not src.is_dir():
        raise SystemExit(f"{bdir.name} has no set {set_name!r}")
    shutil.copytree(src, target, symlinks=True, dirs_exist_ok=True)
    return {"restored": set_name, "from": bdir.name, "into": str(target)}


def status(root: Path) -> dict:
    all_ = backups(root)
    out: dict = {"root": str(root), "count": len(all_)}
    if all_:
        man = json.loads((all_[-1] / "MANIFEST.json").read_text())
        made = datetime.fromisoformat(man["created_at"])
        out.update(newest=all_[-1].name, age_hours=round((datetime.now(timezone.utc) - made).total_seconds() / 3600, 1),
                   files=len(man["files"]), bytes=sum(f["size"] for f in man["files"]), sets=man["sets"])
    d = root / "LAST_DRILL.json"
    if d.exists():
        out["last_drill"] = json.loads(d.read_text())
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backup")
    b.add_argument("--config", type=Path, default=HERE / "sources.json")
    b.add_argument("--root", type=Path)
    b.add_argument("--keep", type=int)
    v = sub.add_parser("verify")
    v.add_argument("backup_dir", type=Path)
    d = sub.add_parser("drill")
    d.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    d.add_argument("backup_dir", type=Path, nargs="?")
    r = sub.add_parser("restore")
    r.add_argument("backup_dir", type=Path)
    r.add_argument("set")
    r.add_argument("target", type=Path)
    s = sub.add_parser("status")
    s.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    a = ap.parse_args(argv)

    if a.cmd == "backup":
        cfg = load_config(a.config)
        root = a.root or Path(cfg.get("root", DEFAULT_ROOT))
        bdir = backup(cfg, root)
        gone = prune(root, a.keep if a.keep is not None else int(cfg.get("keep", 14)))
        print(json.dumps({"ok": True, "backup": str(bdir), "pruned": gone}))
        return 0
    if a.cmd == "verify":
        res = verify(a.backup_dir)
    elif a.cmd == "drill":
        res = drill(a.root, a.backup_dir)
    elif a.cmd == "restore":
        res = restore(a.backup_dir, a.set, a.target)
        res["ok"] = True
    else:
        res = status(a.root)
        res["ok"] = True
    print(json.dumps(res, indent=1))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
