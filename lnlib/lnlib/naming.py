"""Parsing of the shelf's filename convention.

Names are a run of bracketed tags followed by a title. How many tags there are
says what they mean, which is the only rule the whole collection agrees on:

    [imprint][author][illustrator][YYMMDD] Title.epub   a novel
    [imprint][author][YYMMDD] Title.epub                no illustrator credited
    [author][YYMMDD] Title                              an artbook folder
    [author] Series Title/                              a series folder
    [YYMMDD] Volume Title.epub                          inside a series folder

Novels are no longer grouped by folder -- a shelf is a flat pile of files -- so
the series a volume belongs to has to be recovered from its title, which is
what `series_of` does. A volume the owner does not have is a .txt file named
exactly like the real thing, so the two sit in the same inferred series.

Everything here is pure string handling with no I/O.
"""
from __future__ import annotations

import re
import unicodedata

RE_TAGS = re.compile(r"^\s*((?:\[[^\]]*\]\s*)+)(.*)$", re.S)
RE_TAG = re.compile(r"\[([^\]]*)\]")
RE_DATE6 = re.compile(r"^\d{6}$")
RE_DATE = re.compile(r"\[(?P<date>\d{6})\]")

# A book split in half keeps the volume number and adds 上 / 下; the marker has
# to come off before the number can be seen. Whitespace is required so that a
# title merely ending in one of these words is left alone.
RE_PART_TAIL = re.compile(r"[\s　]+(?:上|中|下|前編|後編|前巻|後巻)\s*$")

# Trailing pieces that are decoration rather than part of the series name.
RE_TILDE_TAIL = re.compile(r"[~〜～][^~〜～]*[~〜～]\s*$")
RE_TAIL_NUM = re.compile(
    r"[\s　]*(?:第)?\s*\d{1,3}(?:\.\d)?\s*(?:巻|話|時間目)?\s*$")
# The volume in brackets at the end: 五等分の花嫁【春夏秋冬】(1)
RE_TAIL_BRACKET_NUM = re.compile(
    r"[\s　]*[（(［\[【]\s*(?P<vol>\d{1,3})\s*[）)］\]】][\s　]*$")
RE_TAIL_ROMAN = re.compile(r"[\s　]+[IVXLCivxlc]{1,8}\s*$")
# 灼眼のシャナIII -- a numeral welded straight onto the title. Only counted
# after a Japanese character, so an English word ending in "IX" is left
# alone, and a lone L or C is not a volume (彼女のL is a title, not book 50).
RE_TAIL_ROMAN_GLUED = re.compile(r"(.)((?:[IVXLC]{2,}|[IVX]))\s*$")
# "Title 03 Subtitle" and "Title3 Subtitle": the volume number sits between the
# series name and a per-volume subtitle. The lookbehind keeps the whole number
# together, so a title opening with a year cannot be split down the middle.
RE_MID_NUM = re.compile(
    r"^(?P<base>.{3,}?)[\s　]*(?<!\d)(?P<vol>\d{1,3})"
    r"(?:[\s　]+|[.．][\s　]*)(?P<sub>\S.*)$")
# The same shape with a roman numeral: 緋弾のアリア IX 蒼き閃光. Uppercase only,
# so a lowercase English word cannot be mistaken for a numeral.
RE_MID_ROMAN = re.compile(
    r"^(?P<base>.{3,}?)[\s　]+(?P<vol>[IVXLC]{1,8})[\s　]+(?P<sub>\S.*)$")

_ROMAN_VALUE = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}


def roman(text: str) -> int | None:
    """Read a roman numeral, or None if it is not one.

    A table would have been shorter, but 緋弾のアリア is on volume XXXIX and a
    table always stops somewhere.
    """
    t = (text or "").strip().upper()
    if not t or any(c not in _ROMAN_VALUE for c in t):
        return None
    total = 0
    for i, c in enumerate(t):
        v = _ROMAN_VALUE[c]
        nxt = _ROMAN_VALUE.get(t[i + 1]) if i + 1 < len(t) else None
        total += -v if nxt and nxt > v else v
    return total or None


class _RomanTable(dict):
    """`x in ROMAN` / `ROMAN[x]` for any numeral, not just the first thirty."""

    def __contains__(self, key):
        return roman(key) is not None

    def __getitem__(self, key):
        got = roman(key)
        if got is None:
            raise KeyError(key)
        return got

    def get(self, key, default=None):
        got = roman(key)
        return default if got is None else got


ROMAN = _RomanTable()

# Titles that carry no volume number of their own.
EXTRA_HINTS = (
    "book☆walker", "bookwalker", "特典", "限定", "書き下ろし", "ショートストーリー",
    "画集", "art works", "artworks", "イラスト", "ペーパー", "短編集", "小篇集",
    "アンソロジー", "ドラマcd", "設定資料", "ファンブック", "合本版", "ss集",
)


def nfkc(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "")


def norm(s: str) -> str:
    """Aggressive fold used for matching titles, never for display."""
    s = nfkc(s).lower()
    s = re.sub(r"[\s　]+", "", s)
    return re.sub(r"[!！?？。、,，.．・…~〜'\"'\"「」『』（）()\[\]【】〈〉《》:：;；/／\\+\-–—]", "", s)


def is_extra(title: str) -> bool:
    low = nfkc(title).lower()
    return any(h in low for h in EXTRA_HINTS)


def yymmdd_to_iso(d: str | None) -> str | None:
    """'161225' -> '2016-12-25'. Years below 70 are 20xx, the rest 19xx."""
    if not d or len(d) != 6 or not d.isdigit():
        return None
    yy, mm, dd = int(d[:2]), d[2:4], d[4:6]
    year = 2000 + yy if yy < 70 else 1900 + yy
    return f"{year}-{mm}-{dd}"


def iso_to_yymmdd(iso: str | None) -> str | None:
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", iso or "")
    return m.group(1)[2:] + m.group(2) + m.group(3) if m else None


def split_tags(stem: str) -> tuple[list[str], str]:
    """Leading [bracketed] tags and whatever follows them."""
    m = RE_TAGS.match(stem)
    if not m:
        return [], stem.strip()
    return RE_TAG.findall(m.group(1)), m.group(2).strip()


def read_tags(stem: str) -> dict:
    """Split a name into imprint / author / illustrator / date / title.

    The tags carry no labels, so their count is what tells them apart. Three or
    more means the publisher leads; two means publisher and author; one is the
    author alone. A six digit tag is the release date wherever it appears.
    """
    tags, title = split_tags(stem)
    date = next((t for t in tags if RE_DATE6.match(t)), None)
    named = [t.strip() for t in tags if not RE_DATE6.match(t) and t.strip()]

    imprint = author = illustrator = None
    if len(named) >= 3:
        imprint, author, illustrator = named[0], named[1], named[2]
    elif len(named) == 2:
        imprint, author = named[0], named[1]
    elif len(named) == 1:
        author = named[0]
    return {"imprint": imprint, "author": author, "illustrator": illustrator,
            "date": date, "title": title}


def parse_series_dir(name: str) -> tuple[str | None, str]:
    """'[白米良] ありふれた職業で世界最強' -> ('白米良', 'ありふれた…')."""
    got = read_tags(name.strip())
    return got["author"], (got["title"] or name.strip())


def parse_item(filename: str, in_series_dir: bool) -> dict:
    """Split a filename into author / date / title.

    Inside a series folder the author lives on the folder, so the file is
    usually just '[YYMMDD] Title'; a lone tag there is the date, not a person.
    """
    stem = filename
    dot = stem.rfind(".")
    if dot > 0:
        stem = stem[:dot]
    stem = stem.strip()

    got = read_tags(stem)
    title = got["title"] or stem
    author = None if in_series_dir else got["author"]
    return {
        "author": (author or "").strip() or None,
        "imprint": got["imprint"],
        "illustrator": got["illustrator"],
        "date": yymmdd_to_iso(got["date"]),
        "date_raw": got["date"],
        "title": title.strip(),
    }


def series_of(title: str) -> tuple[str, str | None]:
    """The series a volume title belongs to, and its volume number.

    A shelf of novels is a flat pile of files, so this is what puts
    'ひきこまり吸血姫の悶々12' next to the .txt standing in for volume 11.
    Peeling is repeated because a title can carry several layers of decoration:
    '無職転生 ~異世界行ったら本気だす~4' loses the subtitle, then the number.
    """
    t = nfkc(title).strip()
    volume = None
    for _ in range(4):
        before = t
        t = RE_TILDE_TAIL.sub("", t).strip()
        t = RE_PART_TAIL.sub("", t).strip()
        m = RE_TAIL_BRACKET_NUM.search(t)
        if m:
            if volume is None:
                volume = m.group("vol")
            t = t[:m.start()].strip()
        m = RE_TAIL_NUM.search(t)
        if m:
            found = re.search(r"\d{1,3}(?:\.\d)?", m.group(0))
            if volume is None and found:
                volume = found.group(0)
            t = t[:m.start()].strip()
        m = RE_TAIL_ROMAN_GLUED.search(t)
        if m and ord(m.group(1)) > 127:
            got = roman(m.group(2))
            if got:
                if volume is None:
                    volume = str(got)
                t = t[:m.start(2)].strip()
        m = RE_TAIL_ROMAN.search(t)
        if m:
            got = roman(m.group(0))
            if got:
                if volume is None:
                    volume = str(got)
                t = t[:m.start()].strip()
        t = t.rstrip("　 ・-–—")
        if t == before:
            break

    m = RE_MID_NUM.match(t)
    if m:
        t = m.group("base").strip()
        if volume is None:
            volume = m.group("vol")
    else:
        m = RE_MID_ROMAN.match(t)
        if m and m.group("vol") in ROMAN:
            t = m.group("base").strip()
            if volume is None:
                volume = str(ROMAN[m.group("vol")])

    if not t:                       # a title that was nothing but decoration
        return nfkc(title).strip(), volume
    if volume is not None:
        volume = volume.lstrip("0") or "0"
    return t, volume


def guess_volume(title: str, series_title: str | None = None) -> str | None:
    """Best-effort volume number for sorting. Display never depends on this."""
    t = nfkc(title).strip()
    if series_title:
        st = nfkc(series_title).strip()
        if t.startswith(st):
            t = t[len(st):].strip()
    if not t:
        return None
    # 第01巻 / 第3話 -- how every scanned comic volume is named.
    m = re.search(r"第\s*(\d{1,3})\s*[巻話]", t)
    if m:
        return str(int(m.group(1)))
    m = re.match(r"^[（(〈<［\[]?\s*(\d{1,3}(?:\.\d)?)\s*[）)〉>］\]]?", t)
    if m:
        v = m.group(1)
        return v if "." in v else str(int(v))
    m = re.match(r"^([IVX]{1,6})(?![A-Za-z])", t, re.I)
    if m and m.group(1).upper() in ROMAN:
        return str(ROMAN[m.group(1).upper()])
    m = re.search(r"(?<![0-9A-Za-z])(\d{1,3}(?:\.\d)?)\s*$", t)
    if m:
        v = m.group(1)
        return v if "." in v else str(int(v))
    return None


def sort_key(date_iso: str | None, volume: str | None, title: str):
    """Chronological where possible, then by volume, then by title."""
    vol = 1e9
    if volume:
        try:
            vol = float(volume)
        except ValueError:
            pass
    return (date_iso or "9999-99-99", vol, nfkc(title))
