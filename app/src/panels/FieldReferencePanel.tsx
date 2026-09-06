import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

// Mirrors kiwix_search::KiwixBook.
interface KiwixBook {
  id: string;
  name: string;
  title: string;
}

// Mirrors kiwix_search::KiwixHit.
interface KiwixHit {
  title: string;
  path: string;
  excerpt: string;
  book_title: string;
}

type SearchState = { kind: "idle" } | { kind: "loading" } | { kind: "done"; hits: KiwixHit[] } | { kind: "error"; message: string };

function FieldReferencePanel() {
  const [books, setBooks] = useState<KiwixBook[] | null>(null);
  const [booksError, setBooksError] = useState<string | null>(null);
  const [bookId, setBookId] = useState("");
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ kind: "idle" });
  const [kiwixHost, setKiwixHost] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ citadel_kiwix_host: string | null }>("get_station_profile").then((p) => setKiwixHost(p.citadel_kiwix_host));
    invoke<KiwixBook[]>("list_kiwix_books")
      .then((b) => {
        setBooks(b);
        if (b.length > 0) setBookId(b[0].id);
      })
      .catch((err) => setBooksError(String(err)));
  }, []);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!bookId || !query.trim()) return;
    setSearchState({ kind: "loading" });
    try {
      const hits = await invoke<KiwixHit[]>("search_kiwix_library", { bookId, query: query.trim() });
      setSearchState({ kind: "done", hits });
    } catch (err) {
      setSearchState({ kind: "error", message: String(err) });
    }
  }

  function openHit(hit: KiwixHit) {
    const host = (kiwixHost && kiwixHost.trim()) || "127.0.0.1:8095";
    openUrl(`http://${host}${hit.path}`);
  }

  return (
    <div className="panel-alerts">
      <p className="sync-lede">
        Real keyword search over your own offline library on Citadel (Ready.gov, field manuals, Stack
        Exchange archives, and whatever else is loaded) -- not AI, not semantic search. Results are
        real excerpts from real articles already stored locally; nothing here is generated.
      </p>

      {booksError && (
        <div className="panel-alerts-empty">
          Couldn't reach Citadel's field-reference library: {booksError}. Set the host in Settings →
          Station if it's not at the default address.
        </div>
      )}

      {books && books.length === 0 && !booksError && (
        <div className="panel-alerts-empty">Citadel's library is reachable but has no books loaded yet.</div>
      )}

      {books && books.length > 0 && (
        <form onSubmit={search} className="marker-form">
          <select value={bookId} onChange={(e) => setBookId(e.currentTarget.value)}>
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title || b.name}
              </option>
            ))}
          </select>
          <input value={query} onChange={(e) => setQuery(e.currentTarget.value)} placeholder="e.g. generator fuel safety" />
          <button type="submit" disabled={searchState.kind === "loading" || !query.trim()}>
            {searchState.kind === "loading" ? "Searching…" : "Search"}
          </button>
        </form>
      )}

      {searchState.kind === "error" && <div className="sync-result sync-result-error">Search failed: {searchState.message}</div>}

      {searchState.kind === "done" && searchState.hits.length === 0 && (
        <div className="panel-alerts-empty">No matches in this library for "{query}".</div>
      )}

      {searchState.kind === "done" &&
        searchState.hits.map((hit, i) => (
          <div key={i} className="alert-card">
            <div className="alert-header">
              <span>{hit.title}</span>
            </div>
            <div className="alert-area">{hit.excerpt}</div>
            <div className="field-hint">
              from {hit.book_title} —{" "}
              <button type="button" onClick={() => openHit(hit)} style={{ display: "inline" }}>
                Open full article
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}

export default FieldReferencePanel;
