// Handles finding sources for a given topic.
// Uses DuckDuckGo's HTML results page, which is totally free and needs no API key.
// We also fetch and clean the actual page content so the LLM has real text to work with.

export interface SearchResult {
  title: string;
  url: string;
  desc: string;
}

// Searches DuckDuckGo by scraping the HTML results page.
// The second param is unused but kept so workflow.ts doesn't need to change
// if someone wants to swap in a different search provider later.
export async function searchWeb(
  topic: string,
  _unused: string,
  maxResults = 5
): Promise<SearchResult[]> {
  const query = encodeURIComponent(`${topic} latest 2024 2025`);
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${query}`;

  const res = await fetch(ddgUrl, {
    headers: {
      // DDG returns a CAPTCHA for obvious bot user agents, so we use a real browser UA
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    throw new Error(`DDG search failed with status ${res.status}`);
  }

  const html = await res.text();
  return parseDDGResults(html, maxResults);
}

// Parses DDG's HTML result blocks.
// Each result is a <div class="result"> with a title link and a snippet link inside.
// The href on the title link is a DDG redirect, the real URL is in the uddg query param.
function parseDDGResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  const blockRe =
    /<div[^>]+class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRe.exec(html)) !== null && results.length < max) {
    const block = blockMatch[1];

    const titleMatch =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const title = titleMatch ? stripTags(titleMatch[1]).trim() : "";

    // Pull the uddg param out of DDG's redirect href to get the real destination URL
    const hrefMatch = /href="([^"]+)"/i.exec(
      block.slice(0, block.indexOf("result__a") + 200)
    );
    let url = "";
    if (hrefMatch) {
      try {
        const uddg = new URL(
          "https://duckduckgo.com" + hrefMatch[1]
        ).searchParams.get("uddg");
        url = uddg ? decodeURIComponent(uddg) : "";
      } catch {
        // skip malformed urls
      }
    }

    const snippetMatch =
      /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(
        block
      );
    const desc = snippetMatch ? stripTags(snippetMatch[1]).trim() : "";

    // Skip anything that points back to DDG itself or has no usable URL
    if (title && url && url.startsWith("http") && !url.includes("duckduckgo.com")) {
      results.push({ title, url, desc });
    }
  }

  return results;
}

// Fetches a page and returns clean plain text, capped at 8KB so we don't
// blow through the LLM context window.
export async function fetchPage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ResearchBot/1.0)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return "";

    const html = await res.text();
    return stripHtml(html).slice(0, 8000);
  } catch {
    // If a page fails to load we just skip it, no point crashing the whole pipeline
    return "";
  }
}

// Strips HTML tags, decodes common entities, and collapses whitespace.
// Not perfect but good enough for feeding into an LLM.
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Strips HTML tags from a short string, used when parsing DDG result blocks
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
