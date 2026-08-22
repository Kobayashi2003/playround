"""Batch cover extraction, so the grid is not waiting on first paint."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from . import covers, db


def build(limit: int = 0, redo: bool = False, workers: int = 6,
          progress=None) -> dict:
    """Extract covers for items that do not have one yet."""
    with db.connect() as conn:
        sql = ("SELECT i.id,i.path,i.ext,i.is_dir FROM items i "
               "LEFT JOIN covers c ON c.item_id=i.id "
               "WHERE i.is_missing=0 ")
        sql += "" if redo else "AND (c.item_id IS NULL OR c.state='pending') "
        sql += "ORDER BY i.is_extra, i.sort_date"
        if limit:
            sql += f" LIMIT {int(limit)}"
        rows = [dict(r) for r in conn.execute(sql).fetchall()]

    if not rows:
        return {"processed": 0, "ok": 0, "none": 0, "error": 0}

    out = {"processed": 0, "ok": 0, "none": 0, "error": 0}
    results = []

    def work(r):
        return r["id"], covers.extract(r["path"], r["ext"], bool(r["is_dir"]),
                                       reuse=not redo)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for item_id, res in ex.map(work, rows):
            results.append((item_id, res))
            out["processed"] += 1
            out[res["state"] if res["state"] in out else "error"] += 1
            if progress and out["processed"] % 100 == 0:
                progress(out["processed"], len(rows))

    with db.connect() as conn:
        conn.executemany(
            "INSERT INTO covers(item_id,cache_name,mime,source,state,detail,updated_at) "
            "VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(item_id) DO UPDATE SET cache_name=excluded.cache_name,"
            "mime=excluded.mime,source=excluded.source,state=excluded.state,"
            "detail=excluded.detail,updated_at=excluded.updated_at",
            [(i, r["cache_name"], r["mime"], r["source"], r["state"], r["detail"],
              db.now()) for i, r in results])
    return out
