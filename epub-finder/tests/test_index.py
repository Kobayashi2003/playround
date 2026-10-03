from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

from epub_finder.epub import read_epub
from epub_finder.index import SearchIndex


def make_epub(path: Path, body: str) -> None:
    with ZipFile(path, "w") as archive:
        archive.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>')
        archive.writestr("OPS/package.opf", '''<package xmlns:dc="http://purl.org/dc/elements/1.1/">
            <metadata><dc:title>测试书</dc:title><dc:creator>作者</dc:creator></metadata>
            <manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest>
            <spine><itemref idref="one"/></spine></package>''')
        archive.writestr("OPS/one.xhtml", f"<html><body><h1>第一章</h1><p>{body}</p></body></html>")


class EpubIndexTests(unittest.TestCase):
    def test_search_location_and_incremental_update(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "books"
            root.mkdir()
            epub = root / "sample.epub"
            make_epub(epub, "前文 关键词 后文。关键词 再次出现。")
            book = read_epub(epub)
            self.assertEqual(book.title, "测试书")
            self.assertEqual(book.chapters[0].title, "第一章")
            index = SearchIndex(Path(tmp) / "index.sqlite3")
            self.assertEqual(index.scan(root)[0], 1)
            self.assertEqual(index.scan(root)[0], 0)
            hits, truncated = index.search(root, "关键词")
            self.assertFalse(truncated)
            self.assertEqual(len(hits), 2)
            self.assertEqual(hits[0].paragraph_number, 2)
            self.assertEqual(hits[0].offset, 4)
            self.assertIn("后文", hits[0].excerpt)
            self.assertEqual(index.chapter_text(hits[0].book_id, 1)[1], "前文 关键词 后文。关键词 再次出现。")
            epub.unlink()
            index.scan(root)
            self.assertEqual(index.count_books(root), 0)

    def test_inline_markup_and_case_insensitive_search(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_epub(root / "sample.epub", "Hello <em>World</em> again")
            index = SearchIndex(root / "index.sqlite3")
            index.scan(root)
            hits, _ = index.search(root, "hello world")
            self.assertEqual(len(hits), 1)
            self.assertEqual(hits[0].offset, 1)


if __name__ == "__main__":
    unittest.main()
