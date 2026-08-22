"""Read-side queries shared by the web server and the CLI."""
from __future__ import annotations

from . import db
from .naming import norm


def overview() -> dict:
    with db.connect() as conn:
        shelves = conn.execute(
            "SELECT root_label, root_kind, shelf, COUNT(*) n_series, "
            "SUM(n_items) n_items, SUM(n_missing) n_missing, SUM(n_undated) n_undated "
            "FROM series GROUP BY root_label, shelf "
            "ORDER BY root_label, shelf"
        ).fetchall()
        totals = conn.execute(
            "SELECT COUNT(*) n_series, SUM(n_items) n_items, "
            "SUM(n_missing) n_missing, SUM(n_undated) n_undated FROM series"
        ).fetchone()
        last = db.get_meta(conn, "last_scan")
    return {
        "shelves": [dict(r) for r in shelves],
        "totals": dict(totals) if totals else {},
        "last_scan": last,
    }


def series_list(root: str | None = None, shelf: str | None = None,
                q: str | None = None, only: str | None = None,
                offset: int = 0, limit: int = 120) -> dict:
    where, args = [], []
    if root:
        where.append("s.root_label=?")
        args.append(root)
    if shelf is not None and shelf != "":
        where.append("s.shelf=?")
        args.append(shelf)
    if only == "missing":
        where.append("s.n_missing > 0")
    elif only == "undated":
        where.append("s.n_undated > 0")
    if q:
        where.append("(s.norm_title LIKE ? OR s.norm_author LIKE ?)")
        like = f"%{norm(q)}%"
        args += [like, like]

    sql_from = ("FROM (SELECT *, "
                "      replace(replace(lower(title),' ',''),'　','') norm_title, "
                "      replace(replace(lower(COALESCE(author,'')),' ',''),'　','') norm_author "
                "      FROM series) s")
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    with db.connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) c {sql_from}{clause}", args).fetchone()["c"]
        rows = conn.execute(
            f"SELECT s.* {sql_from}{clause} "
            "ORDER BY s.root_label, s.shelf, s.author IS NULL, s.author, s.title "
            "LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d.pop("norm_title", None)
            d.pop("norm_author", None)
            out.append(d)

        # One window query for the whole page instead of a cover lookup per row:
        # at 120 rows that is 1 statement rather than 121.
        ids = [d["id"] for d in out]
        covers_by_series: dict[int, tuple] = {}
        if ids:
            marks = ",".join("?" * len(ids))
            for c in conn.execute(
                    "SELECT series_id, item_id, state FROM ("
                    "  SELECT i.series_id, i.id item_id, c.state, ROW_NUMBER() OVER ("
                    "    PARTITION BY i.series_id ORDER BY"
                    "      CASE WHEN c.state='ok' THEN 0 ELSE 1 END,"
                    "      i.is_extra, i.sort_date, i.sort_vol) rn"
                    "  FROM items i LEFT JOIN covers c ON c.item_id=i.id"
                    f"  WHERE i.is_missing=0 AND i.series_id IN ({marks})"
                    ") WHERE rn=1", ids):
                covers_by_series[c["series_id"]] = (c["item_id"], c["state"])
        for d in out:
            hit = covers_by_series.get(d["id"])
            d["cover_item_id"] = hit[0] if hit else None
            # The grid uses this to avoid requesting a cover that is known not
            # to exist -- a 404 per card is the most expensive kind of nothing.
            d["cover_state"] = hit[1] if hit else None
    return {"total": total, "offset": offset, "limit": limit, "series": out}


def series_detail(series_id: int) -> dict | None:
    with db.connect() as conn:
        s = conn.execute("SELECT * FROM series WHERE id=?", (series_id,)).fetchone()
        if not s:
            return None
        items = conn.execute(
            "SELECT i.*, c.state cover_state, c.source cover_source, "
            "r.percent read_percent, r.locator read_locator, r.finished read_finished "
            "FROM items i LEFT JOIN covers c ON c.item_id=i.id "
            "LEFT JOIN reading r ON r.path=i.path "
            "WHERE i.series_id=? "
            "ORDER BY i.is_extra, i.sort_date, i.sort_vol, i.title", (series_id,)
        ).fetchall()
    return {"series": dict(s), "items": [dict(r) for r in items]}


def missing(root: str | None = None, limit: int = 2000) -> dict:
    """Every volume represented by a placeholder -- the main 'what do I lack' view."""
    where, args = ["i.is_missing=1"], []
    if root:
        where.append("s.root_label=?")
        args.append(root)
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT i.*, s.title series_title, s.author, s.shelf, s.root_label, "
            "s.id series_id, s.series_key "
            "FROM items i JOIN series s ON s.id=i.series_id "
            f"WHERE {' AND '.join(where)} "
            "ORDER BY s.root_label, s.author, s.title, i.sort_vol, i.sort_date "
            "LIMIT ?", args + [limit]).fetchall()
    grouped: dict[str, dict] = {}
    for r in rows:
        d = dict(r)
        k = f"{d['author']}|{d['series_title']}"
        g = grouped.setdefault(k, {"author": d["author"], "title": d["series_title"],
                                   "shelf": d["shelf"], "root_label": d["root_label"],
                                   "series_id": d["series_id"],
                                   "series_key": d["series_key"], "items": []})
        g["items"].append(d)
    return {"count": len(rows), "groups": list(grouped.values())}


def item(item_id: int) -> dict | None:
    with db.connect() as conn:
        r = conn.execute(
            "SELECT i.*, s.title series_title, s.author, s.series_key, s.root_label "
            "FROM items i JOIN series s ON s.id=i.series_id WHERE i.id=?",
            (item_id,)).fetchone()
    return dict(r) if r else None
