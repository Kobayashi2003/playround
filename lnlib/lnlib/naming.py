"""Parsing of the shelf's filename convention.

Names are a run of bracketed tags followed by a title. How many tags there are
says what they mean, which is the only rule the whole collection agrees on:

    [imprint][author][illustrator][YYMMDD] Title.epub   a novel
    [imprint][author][YYMMDD] Title.epub                no illustrator credited
    [author][YYMMDD] Title                              an artbook folder
    [author] Folder Title/                              a folder of books
    [YYMMDD] Volume Title.epub                          inside such a folder

Every file is one book and nothing here tries to work out which books belong
together: a title is read as it was written, and the volume number is only ever
taken from the name of the file it sits in. Whatever grouping the collection
has is the grouping it has on disk.

Everything here is pure string handling with no I/O.
"""
from __future__ import annotations

import re
import unicodedata

RE_TAGS = re.compile(r"^\s*((?:\[[^\]]*\]\s*)+)(.*)$", re.S)
RE_TAG = re.compile(r"\[([^\]]*)\]")
RE_DATE6 = re.compile(r"^\d{6}$")
# (一般コミック) [作者] 書名 -- the category a scan group files a book under,
# written before the credits. It says what shelf it came from, not who made it,
# so it is set aside and the tags after it are read as usual.
RE_CATEGORY = re.compile(r"^\s*[(（][^()（）]{1,20}[)）]\s*(?=\[)")
# A credit is a name, not a sentence. Some files open with the book's first line
# in brackets ([ある朝妻とさしむかいで食事をしていると、…]); anything this long
# is not a person and is left out of the credits.
MAX_CREDIT = 40

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


# How wide a run of digits is padded to in a sort key. Twelve covers a
# volume number, a year and an ISBN-10; a longer run than this sorts by its
# digits, which is still an order, just not a numeric one.
NUMBER_WIDTH = 12
RE_DIGIT_RUN = re.compile(r"\d+")


def natural(s: str) -> str:
    """A sort key in which a run of digits counts as the number it spells.

    `巨人 2` belongs before `巨人 10`, which is the order the volumes are
    actually in and not the order their names are in. Padding each run of
    digits to a fixed width is all SQLite needs to put them that way, and
    leading zeros are dropped first so `02` and `2` land together.

    This is for ordering only. Searching still matches against `norm`, where
    the number reads the way it was typed.
    """
    return RE_DIGIT_RUN.sub(
        lambda m: m.group().lstrip("0").zfill(NUMBER_WIDTH), norm(s))


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
    stem = RE_CATEGORY.sub("", stem, count=1)
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
    named = [t.strip() for t in tags
             if not RE_DATE6.match(t) and t.strip() and len(t.strip()) <= MAX_CREDIT]

    imprint = author = illustrator = None
    if len(named) >= 3:
        imprint, author, illustrator = named[0], named[1], named[2]
    elif len(named) == 2:
        imprint, author = named[0], named[1]
    elif len(named) == 1:
        author = named[0]
    return {"imprint": imprint, "author": author, "illustrator": illustrator,
            "date": date, "title": title}


def parse_folder(name: str) -> dict:
    """A content folder's own tags: '[白米良] ありふれた…' -> author + title.

    The folder is not a series any more, only a place several books sit in, so
    what it carries is credit the files inside may leave off.
    """
    got = read_tags(name.strip())
    got["title"] = got["title"] or name.strip()
    return got


def parse_item(filename: str, in_folder: bool) -> dict:
    """Split a filename into its credits, date and title.

    Inside a content folder the author lives on the folder, so the file is
    usually just '[YYMMDD] Title'; a lone tag there is the date, not a person.
    """
    stem = filename
    dot = stem.rfind(".")
    if dot > 0:
        stem = stem[:dot]
    stem = stem.strip()

    got = read_tags(stem)
    title = got["title"] or stem
    author = None if in_folder else got["author"]
    return {
        "author": (author or "").strip() or None,
        "imprint": got["imprint"],
        "illustrator": got["illustrator"],
        "date": yymmdd_to_iso(got["date"]),
        "date_raw": got["date"],
        "title": title.strip(),
    }


def split_author_suffix(title: str, author: str | None) -> tuple[str, str | None]:
    """'書名 - 作者' -> ('書名', '作者'), but only when the tail *is* this author.

    That is how a Calibre export names its files, and inside an author folder
    the folder already says who wrote them, so the tail is redundant. A title
    that merely contains " - " is left alone: the tail has to be the name.

    Calibre names the folder by the author's *sort* name and the file by the
    *display* name -- `ヒスイ, 翡翠/…- 翡翠 ヒスイ.epub` -- so the inverted form
    counts too, and when it is the one found, it is returned so the book can
    carry the name as it is actually written rather than as it is filed.
    """
    if not author:
        return title, None
    names = [author]
    if ", " in author:
        last, first = author.split(", ", 1)
        names.append(f"{first} {last}")
    for name in names:
        for sep in (" - ", " – ", "－"):
            tail = sep + name
            if title.endswith(tail) and len(title) > len(tail):
                return title[: -len(tail)].rstrip(), name
    # A name cut off by the filename length limit leaves only the separator.
    trimmed = title.rstrip()
    if trimmed.endswith(" -") and len(trimmed) > 2:
        return trimmed[:-2].rstrip(), None
    return title, None


def volume_of(title: str) -> str | None:
    """The volume number written in this one title, for sorting and display.

    Nothing is inferred from the neighbours: if the name does not say which
    volume it is, it does not have one here.
    """
    t = nfkc(title).strip()
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
    if m and roman(m.group(1)) is not None:
        return str(roman(m.group(1)))
    # The volume in brackets at the end: 五等分の花嫁【春夏秋冬】(1)
    m = re.search(r"[（(［\[【]\s*(\d{1,3})\s*[）)］\]】]\s*$", t)
    if m:
        return str(int(m.group(1)))
    m = re.search(r"(?<![0-9A-Za-z])(\d{1,3}(?:\.\d)?)\s*$", t)
    if m:
        v = m.group(1)
        return v if "." in v else str(int(v))
    # 緋弾のアリア IX -- a numeral at the end. Uppercase and preceded by space,
    # so a lowercase English word cannot be mistaken for one.
    m = re.search(r"[\s　]+([IVXLC]{1,8})\s*$", t)
    if m and roman(m.group(1)) is not None:
        return str(roman(m.group(1)))
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
