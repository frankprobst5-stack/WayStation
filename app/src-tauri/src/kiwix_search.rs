//! Local field-reference library search over Citadel's Kiwix instance,
//! decided 2026-09-06 -- the Planned backlog's "local field-reference
//! knowledge base" item.
//!
//! Deliberately **not** presented as AI or semantic retrieval anywhere in
//! this module or its UI: Kiwix's real search API (confirmed live against
//! the actual running `citadel-kiwix` container before writing this) is
//! full-text keyword search over one ZIM library at a time, nothing more.
//! Calling that "RAG" or "AI-retrieved" -- language the original backlog
//! entry used before this was built -- would be a real, avoidable
//! inaccuracy in what the operator is told they're looking at. What's
//! shipped instead: real excerpts from a real local library, honestly
//! labeled as keyword search results.
//!
//! Talks directly to Kiwix's own host:port (Citadel's `docker-compose.yml`
//! exposes it directly, not behind the cockpit nginx the way
//! scanner/weather/chat are -- see `station_profile.citadel_kiwix_host`,
//! migration v44). Kiwix has no JSON search endpoint in the version
//! Citadel runs, only an HTML results page meant for a browser, so this
//! module parses that real HTML directly rather than inventing a
//! structured format Kiwix doesn't provide.

use crate::db::{self, Db};
use serde::Serialize;
use std::time::Duration;
use tauri::State;

fn citadel_kiwix_base(host: &Option<String>) -> String {
    let h = host.as_deref().unwrap_or("127.0.0.1:8095").trim().to_string();
    format!("http://{h}")
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("failed to build reqwest client")
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KiwixBook {
    pub id: String,
    pub name: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KiwixHit {
    pub title: String,
    /// Relative path on the Kiwix server, e.g.
    /// `/content/www.ready.gov_en_2024-12/www.ready.gov/power-outages` --
    /// the frontend joins this with the configured host to open the real
    /// article in the system browser.
    pub path: String,
    pub excerpt: String,
    pub book_title: String,
}

/// Strips HTML tags from Kiwix's search-result excerpt, which wraps the
/// matched term in `<b>...</b>`. A real regex/HTML-parser crate would be
/// overkill for one fixed, simple case -- this walks the string once and
/// drops anything between `<` and `>`, which is exactly as much HTML as
/// this specific field ever contains.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// Several real book titles in Citadel's catalog contain XML entities
/// ("Woodworking Q&amp;A", "Gardening &amp; Landscaping Q&A") -- a full
/// XML parser is more than this one field needs, but leaving the raw
/// entity in a title an operator reads would look broken, not honest.
fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
}

fn extract_between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let start_idx = s.find(start)? + start.len();
    let end_idx = s[start_idx..].find(end)? + start_idx;
    Some(&s[start_idx..end_idx])
}

/// Parses Kiwix's real OPDS v2 catalog feed (`/catalog/v2/entries`) into
/// the books this station can actually search. Pure and testable against
/// a real captured feed -- no network involved.
pub fn parse_catalog(xml: &str) -> Vec<KiwixBook> {
    let mut books = Vec::new();
    for entry in xml.split("<entry>").skip(1) {
        let entry = match entry.split_once("</entry>") {
            Some((body, _)) => body,
            None => entry,
        };
        let raw_id = extract_between(entry, "<id>", "</id>").unwrap_or("");
        let id = raw_id.strip_prefix("urn:uuid:").unwrap_or(raw_id).to_string();
        let name = extract_between(entry, "<name>", "</name>").unwrap_or("").to_string();
        let title = decode_entities(extract_between(entry, "<title>", "</title>").unwrap_or(""));
        if !id.is_empty() && !name.is_empty() {
            books.push(KiwixBook { id, name, title });
        }
    }
    books
}

/// Parses Kiwix's real search-results HTML (confirmed live 2026-09-06
/// against `citadel-kiwix`) into structured hits. Deliberately scopes to
/// the `<div class="results">...` section before splitting on `<li>` --
/// the page's own pagination footer also uses `<li>` for page-number
/// links, and parsing those as if they were results would silently
/// produce fake, empty-looking hits.
pub fn parse_search_html(html: &str) -> Vec<KiwixHit> {
    let results_section = match extract_between(html, "<div class=\"results\">", "<div class=\"footer\">") {
        Some(s) => s,
        None => return Vec::new(),
    };

    let mut hits = Vec::new();
    for chunk in results_section.split("<li>").skip(1) {
        let chunk = match chunk.split_once("</li>") {
            Some((body, _)) => body,
            None => chunk,
        };
        let path = extract_between(chunk, "href=\"", "\"").unwrap_or("").to_string();
        let title = extract_between(chunk, "\">", "</a>").map(|t| t.trim().to_string()).unwrap_or_default();
        let excerpt = extract_between(chunk, "<cite>", "</cite>").map(strip_tags).unwrap_or_default();
        let book_title = extract_between(chunk, "class=\"book-title\">from ", "</div>").unwrap_or("").trim().to_string();
        if !path.is_empty() {
            hits.push(KiwixHit { title, path, excerpt, book_title });
        }
    }
    hits
}

fn fetch_catalog(base: &str) -> Result<Vec<KiwixBook>, String> {
    let url = format!("{base}/catalog/v2/entries");
    let body = client()
        .get(&url)
        .send()
        .map_err(|e| format!("could not reach Kiwix at {url}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Kiwix returned an error: {e}"))?
        .text()
        .map_err(|e| e.to_string())?;
    Ok(parse_catalog(&body))
}

fn search(base: &str, book_id: &str, query: &str) -> Result<Vec<KiwixHit>, String> {
    let url = format!("{base}/search");
    let body = client()
        .get(&url)
        .query(&[("books.id", book_id), ("pattern", query), ("pageLength", "10")])
        .send()
        .map_err(|e| format!("could not reach Kiwix at {url}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Kiwix returned an error: {e}"))?
        .text()
        .map_err(|e| e.to_string())?;
    Ok(parse_search_html(&body))
}

#[tauri::command]
pub fn list_kiwix_books(db: State<Db>) -> Result<Vec<KiwixBook>, String> {
    let host = {
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).citadel_kiwix_host
    };
    fetch_catalog(&citadel_kiwix_base(&host))
}

#[tauri::command]
pub fn search_kiwix_library(db: State<Db>, book_id: String, query: String) -> Result<Vec<KiwixHit>, String> {
    let host = {
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).citadel_kiwix_host
    };
    search(&citadel_kiwix_base(&host), &book_id, &query)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real fragment of `citadel-kiwix`'s actual `/catalog/v2/entries`
    /// response, captured 2026-09-06 -- trimmed to two entries plus the
    /// feed-level wrapper, not hand-invented.
    const REAL_CATALOG_FRAGMENT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>f28a466f-5649-e144-509b-5667e246200b</id>
  <title>All Entries</title>
  <entry>
    <id>urn:uuid:04800191-6295-5893-6b05-9f11317755cf</id>
    <title>Woodworking Q&amp;A</title>
    <name>woodworking.stackexchange.com_en_all</name>
    <articleCount>8467</articleCount>
  </entry>
  <entry>
    <id>urn:uuid:17e9fb54-9554-d2cd-e15f-17cf750882d1</id>
    <title>Ready.gov</title>
    <name>www.ready.gov_en</name>
    <articleCount>2437</articleCount>
  </entry>
</feed>
"#;

    /// A real fragment of `citadel-kiwix`'s actual search-results HTML,
    /// captured 2026-09-06 against `?books.id=17e9fb54-...&pattern=generator+fuel`
    /// -- trimmed to two result `<li>`s plus the real pagination footer
    /// (which also uses `<li>`, the exact case `parse_search_html` has to
    /// not mistake for a third result).
    const REAL_SEARCH_FRAGMENT: &str = r#"<div class="results">
      <ul>
          <li>
            <a href="/content/www.ready.gov_en_2024-12/www.ready.gov/power-outages">
              Power Outages | Ready.gov
            </a>
              <cite><b>Fuel</b> spilled on hot engine parts can ignite. Follow manufacturer's instructions carefully.</cite>
              <div class="book-title">from Ready.gov</div>
              <div class="informations">1,025 words</div>
          </li>
          <li>
            <a href="/content/www.ready.gov_en_2024-12/www.ready.gov/hi/node/5151">
              Power Outages | Ready.gov
            </a>
              <cite><b>Fuel</b> spilled on hot engine parts can ignite.</cite>
              <div class="book-title">from Ready.gov</div>
              <div class="informations">1,027 words</div>
          </li>
      </ul>
    </div>

    <div class="footer">
        <ul>
            <li>
              <a class="selected" href="/search?pattern=generator%20fuel&start=0&pageLength=3">1</a>
            </li>
            <li>
              <a href="/search?pattern=generator%20fuel&start=3&pageLength=3">2</a>
            </li>
        </ul>
    </div>"#;

    #[test]
    fn parse_catalog_reads_real_book_ids_names_and_titles() {
        let books = parse_catalog(REAL_CATALOG_FRAGMENT);
        assert_eq!(books.len(), 2);
        assert_eq!(books[0], KiwixBook {
            id: "04800191-6295-5893-6b05-9f11317755cf".to_string(),
            name: "woodworking.stackexchange.com_en_all".to_string(),
            title: "Woodworking Q&A".to_string(),
        });
        assert_eq!(books[1].name, "www.ready.gov_en");
        // The OPDS <id> is "urn:uuid:X" but the real search API needs the
        // bare UUID (confirmed live) -- the prefix must actually be gone.
        assert!(!books[0].id.contains("urn:uuid"));
    }

    #[test]
    fn parse_catalog_on_empty_feed_is_honestly_empty() {
        assert!(parse_catalog("<feed></feed>").is_empty());
    }

    #[test]
    fn parse_search_html_extracts_real_hits_not_pagination_links() {
        let hits = parse_search_html(REAL_SEARCH_FRAGMENT);
        assert_eq!(hits.len(), 2, "must find exactly the 2 real results, not the footer's page-number <li>s too");
        assert_eq!(hits[0].path, "/content/www.ready.gov_en_2024-12/www.ready.gov/power-outages");
        assert_eq!(hits[0].title, "Power Outages | Ready.gov");
        assert_eq!(hits[0].book_title, "Ready.gov");
        assert!(hits[0].excerpt.contains("Fuel spilled on hot engine parts"), "excerpt: {:?}", hits[0].excerpt);
        // The real excerpt highlights the match with <b>Fuel</b> -- the
        // parsed text must not leak that tag into what the operator reads.
        assert!(!hits[0].excerpt.contains('<'), "tags must be stripped: {:?}", hits[0].excerpt);
    }

    #[test]
    fn parse_search_html_on_no_results_is_honestly_empty() {
        let html = r#"<div class="results"><ul></ul></div><div class="footer"></div>"#;
        assert!(parse_search_html(html).is_empty());
    }

    /// Live-only: exercises the real Kiwix container running as part of
    /// Citadel's stack, confirmed reachable by hand (2026-09-06) before
    /// this module was written.
    #[test]
    #[ignore]
    fn list_books_against_the_real_running_kiwix_finds_real_libraries() {
        let books = fetch_catalog("http://127.0.0.1:8095").expect("real Kiwix catalog fetch should succeed");
        assert!(!books.is_empty(), "the real running Kiwix instance has real libraries loaded");
        assert!(books.iter().any(|b| b.name == "www.ready.gov_en"), "Ready.gov library confirmed present by hand");
    }

    #[test]
    #[ignore]
    fn search_against_the_real_running_kiwix_finds_real_articles() {
        let hits = search("http://127.0.0.1:8095", "17e9fb54-9554-d2cd-e15f-17cf750882d1", "generator fuel")
            .expect("real Kiwix search should succeed");
        assert!(!hits.is_empty(), "this exact query returned 40 real results when checked by hand");
    }
}
