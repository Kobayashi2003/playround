/* The shapes the server sends. One row is one book; there is no series. */

export interface BookCard {
  readonly id: number;
  readonly title: string;
  readonly author: string | null;
  readonly shelf: string;
  readonly folder: string;
  readonly root_label: string;
  readonly root_kind: string;
  readonly date: string | null;
  readonly volume: string | null;
  readonly ext: string;
  readonly format: string;
  readonly is_extra: number;
  readonly is_dir: number;
  /** 0 once a scan looked for the file and did not find it. A question, not a
      verdict: the record stays until someone confirms the absence. */
  readonly present: number;
  readonly cover_state: string | null;
  readonly read_percent?: number | null;
  readonly read_finished?: number | null;
}

export interface Book extends BookCard {
  readonly path: string;
  readonly filename: string;
  readonly imprint: string | null;
  readonly illustrator: string | null;
  readonly size: number;
  readonly mtime: number;
  readonly first_seen: number;
  readonly last_seen: number;
  readonly cover_source: string | null;
  readonly read_locator: string | null;
  readonly read_position: number | null;
  readonly read_at: number | null;
}

export interface Facet {
  readonly format: string;
  readonly n: number;
}

export interface BookPage {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly order: string;
  readonly format: string | null;
  readonly facets: readonly Facet[];
  readonly books: readonly BookCard[];
}

export interface ShelfCount {
  readonly root_label: string;
  readonly root_kind: string;
  readonly shelf: string;
  readonly n_books: number;
  readonly n_undated: number;
  readonly n_absent: number;
}

export interface FormatCount {
  readonly format: string;
  readonly n_books: number;
  readonly bytes: number;
  readonly n_absent: number;
}

export interface Overview {
  readonly shelves: readonly ShelfCount[];
  readonly formats: readonly FormatCount[];
  readonly totals: {
    readonly n_books?: number;
    readonly n_undated?: number;
    readonly n_absent?: number;
    readonly n_formats?: number;
    readonly bytes?: number;
  };
  readonly n_trash: number;
  /** Which incarnation of the index this is. It changes only when the books
      table is rebuilt from nothing, which is the only thing that can make ids
      mean something else — a scan alone no longer does. */
  readonly index_epoch: number | null;
  readonly last_scan: { readonly at?: number; readonly books?: number } | null;
}

export interface FormatDetail {
  readonly format: string;
  readonly n_books: number;
  readonly bytes: number;
  readonly n_dirs: number;
  readonly n_authors: number;
  readonly first_date: string | null;
  readonly last_date: string | null;
}

export interface ShelfFormat {
  readonly root_label: string;
  readonly shelf: string;
  readonly format: string;
  readonly n_books: number;
}

export interface FolderRow {
  readonly root_label: string;
  readonly shelf: string;
  readonly folder: string;
  readonly author: string | null;
  readonly n_books: number;
  readonly n_formats: number;
}

export interface TrashRow {
  readonly id: number;
  readonly path: string;
  readonly title: string;
  readonly author: string | null;
  readonly format: string;
  readonly size: number;
  /** kept = only the record went; trashed = the file moved too; vanished =
      the file was already gone when the record was retired. */
  readonly file_state: "kept" | "trashed" | "vanished";
  readonly trash_path: string | null;
  readonly reason: string;
  readonly trashed_at: number;
}

export interface Progress {
  readonly path: string;
  readonly locator: string | null;
  readonly position: number;
  readonly percent: number;
  readonly finished: number;
  readonly updated_at: number;
}

export interface ReadingRow extends BookCard {
  readonly percent: number;
  readonly finished: number;
  readonly updated_at: number;
}

/** What the reader needs to open one book; an epub carries nothing extra. */
export type Manifest =
  & {
    readonly book: Book;
    readonly progress: Progress | null;
    readonly detail?: string;
  }
  & (
    | { readonly kind: "epub" }
    | { readonly kind: "pdf" }
    | { readonly kind: "images"; readonly pages: readonly string[];
        readonly direction: "ltr" | "rtl" }
    | { readonly kind: "text"; readonly text: string; readonly encoding: string }
    | { readonly kind: "gone"; readonly retired: boolean }
    | { readonly kind: "external" | "error" }
  );

export type SortOrder =
  "author" | "date" | "date_asc" | "title" | "added" | "format";

export interface ShelfQuery {
  readonly root?: string;
  readonly shelf?: string;
  readonly folder?: string;
  readonly q?: string;
  readonly only?: "undated" | "extra" | "absent" | "present";
  readonly format?: string;
  readonly order?: SortOrder;
}

/* ------------------------------------------------------------ presentation */
/** What each format is called on screen, and what can be read here. */
export const FORMAT_LABEL: Record<string, string> = {
  epub: "EPUB",
  pdf: "PDF",
  cbz: "CBZ",
  cbr: "CBR",
  azw3: "AZW3",
  mobi: "MOBI",
  txt: "テキスト",
  images: "画像フォルダ",
};

export const formatLabel = (f: string) => FORMAT_LABEL[f] ?? f.toUpperCase();

/** Formats with an in-browser renderer. The rest open in a desktop app. */
export const READABLE = new Set(["epub", "pdf", "cbz", "images", "txt"]);

export function bytes(n: number | null | undefined): string {
  let size = Number(n || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${i <= 1 ? Math.round(size) : size.toFixed(1)} ${units[i]}`;
}
