// Allowlist filter for HTML that GitHub already rendered from markdown (`bodyHTML`).
// It keeps a small set of tags with no attributes (except https hrefs), drops script-like
// elements with their contents, and unwraps everything else so the text survives. The
// browser puts the output straight into innerHTML, so this is the only guard between a
// review body and the page. No dependencies: a tag tokenizer is enough because the input
// is already well-formed, entity-encoded HTML from GitHub, not arbitrary user text.

const KEEP = new Set([
  "p", "br", "ul", "ol", "li", "code", "pre", "a", "strong", "b", "em", "i", "h3", "h4",
  "blockquote", "table", "thead", "tbody", "tr", "th", "td", "del", "hr",
]);
const RENAME: Record<string, string> = { h1: "h3", h2: "h3", h5: "h4", h6: "h4" };
const DROP_CONTENT = new Set(["script", "style", "svg", "math", "template", "iframe", "object", "embed", "noscript"]);
const VOID = new Set(["br", "hr"]);

// One match per comment or tag. Group 1 = tag name, group 2 = raw attribute text.
const TAG = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s<>"'=/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`]+))?)*)\s*\/?>/g;

export function sanitizeHtml(input: string): string {
  let out = "";
  let last = 0;
  let skipping: string | null = null; // inside an element whose content we drop
  const open: string[] = []; // kept tags currently open, for balancing

  for (const m of input.matchAll(TAG)) {
    const text = input.slice(last, m.index);
    last = m.index + m[0].length;
    if (!skipping) out += escapeText(text);

    const raw = m[1];
    if (!raw) continue; // comment
    const closing = m[0].startsWith("</");
    const name = raw.toLowerCase();

    if (skipping) {
      if (closing && name === skipping) skipping = null;
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      if (!closing) skipping = name;
      continue;
    }
    const tag = RENAME[name] ?? name;
    if (!KEEP.has(tag)) continue; // unwrap: drop the tag, keep its children

    if (closing) {
      if (open.includes(tag)) {
        let t: string | undefined;
        do {
          t = open.pop();
          out += `</${t}>`;
        } while (t !== tag);
      }
      continue;
    }
    if (tag === "a") {
      const href = attr(m[2], "href");
      if (!href || !/^https:\/\//i.test(href)) continue; // unwrap non-https links
      out += `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener">`;
      open.push("a");
      continue;
    }
    out += `<${tag}>`;
    if (!VOID.has(tag)) open.push(tag);
  }
  if (!skipping) out += escapeText(input.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return out.trim();
}

function attr(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>\`]+))`, "i");
  const m = re.exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/** Text between tags is already entity-encoded by GitHub; only a stray "<" can remain. */
const escapeText = (s: string): string => s.replace(/</g, "&lt;");
