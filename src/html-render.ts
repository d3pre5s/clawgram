/**
 * Markdown → Telegram HTML rendering for outbound text (2.15.0).
 *
 * The account's reply format is `html`, and the agent writes what language
 * models write: markdown. GramJS's HTML parser does not touch markdown, so
 * every `**bold**` reached a live work chat with its asterisks showing —
 * 2026-08-12 00:13 UTC, a 2167-character monthly report worth of them. The
 * converse configuration is no better: GramJS's markdown mode knows five
 * delimiters and no links, so the HTML links the agent is told to use would
 * arrive as tag soup. Neither mode alone can carry what the agent produces,
 * which is markdown, Telegram HTML, or both in one message.
 *
 * This renderer runs in front of GramJS's HTML parser and emits HTML that
 * parser maps onto Telegram entities:
 *
 * - Markdown becomes tags: `**b**`, `*i*`, `_i_`, `__b__`, `~~s~~`,
 *   `||spoiler||`, `` `code` ``, ``` fences (with language), `[text](url)`,
 *   `# heading` (a bold line), `> quote` (a blockquote).
 * - HTML the parser understands passes through, its attributes reduced to
 *   the meaningful set. Bot-API-only names are mapped to what GramJS knows
 *   (`tg-spoiler` → `spoiler`, `ins` → `u`, `strike` → `s`, `h1..h6` → `b`);
 *   `<br>` becomes a newline.
 * - Structural HTML Telegram cannot render (`<p>`, `<ul>`, `<li>`…) is
 *   dropped exactly as the parser silently drops it today, keeping the text.
 * - Everything else — a stray `<`, a bare `&`, a `<плейсхолдер>` — is
 *   escaped, so it survives the parser as literal text instead of being
 *   half-eaten as a failed tag.
 *
 * Markdown inside code — spans, fences, `<code>`/`<pre>` bodies — is never
 * converted; code arrives verbatim. Already-valid Telegram HTML passes
 * through unchanged, which is what keeps the links that are authored as
 * `<a href="…">` working.
 */

/** Tags GramJS's HTML parser turns into entities, plus aliases it does not
 * know mapped onto ones it does. `canonical` is what gets emitted; `attrs`
 * is the full set of attributes worth keeping for that tag. */
const TELEGRAM_TAGS: Record<string, { canonical: string; attrs?: readonly string[] }> = {
  b: { canonical: "b" },
  strong: { canonical: "strong" },
  i: { canonical: "i" },
  em: { canonical: "em" },
  u: { canonical: "u" },
  ins: { canonical: "u" },
  s: { canonical: "s" },
  del: { canonical: "del" },
  strike: { canonical: "s" },
  spoiler: { canonical: "spoiler" },
  "tg-spoiler": { canonical: "spoiler" },
  a: { canonical: "a", attrs: [ "href" ] },
  code: { canonical: "code", attrs: [ "class" ] },
  pre: { canonical: "pre" },
  blockquote: { canonical: "blockquote", attrs: [ "expandable" ] },
  "tg-emoji": { canonical: "tg-emoji", attrs: [ "emoji-id" ] },
  h1: { canonical: "b" },
  h2: { canonical: "b" },
  h3: { canonical: "b" },
  h4: { canonical: "b" },
  h5: { canonical: "b" },
  h6: { canonical: "b" },
};

/** Structural HTML the parser swallows today; keep swallowing it rather than
 * turning a `<ul>` the agent wrote into visible angle brackets. */
const DROP_TAGS = new Set([
  "p", "div", "span", "ul", "ol", "li", "hr", "table", "thead", "tbody",
  "tr", "td", "th", "details", "summary", "img", "small", "sup", "sub",
  "font", "center", "section", "article", "header", "footer", "main", "nav",
]);

const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/;
const ATTR_RE = /([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
/** A character reference the parser will decode; everything else is a bare `&`. */
const ENTITY_RE = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;
const WORD_RE = /[\p{L}\p{N}_]/u;
/** GFM backslash-escapable punctuation, so `\*` means a literal asterisk. */
const ESCAPABLE = new Set([ ..."\\`*_{}[]()#+-.!|~<>" ]);

type Emphasis = { len: number; open: string; close: string };

const EMPHASIS: Record<string, readonly Emphasis[]> = {
  "*": [
    { len: 3, open: "<b><i>", close: "</i></b>" },
    { len: 2, open: "<b>", close: "</b>" },
    { len: 1, open: "<i>", close: "</i>" },
  ],
  "_": [
    { len: 3, open: "<b><i>", close: "</i></b>" },
    { len: 2, open: "<b>", close: "</b>" },
    { len: 1, open: "<i>", close: "</i>" },
  ],
  "~": [ { len: 2, open: "<s>", close: "</s>" } ],
  "|": [ { len: 2, open: "<spoiler>", close: "</spoiler>" } ],
};

/** `&`/`<`/`>` escaped unconditionally — for code bodies generated from
 * markdown, where a `&amp;` the author typed must arrive as `&amp;`. */
function escapeAll(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Like {@link escapeAll}, but an already-written character reference is kept,
 * so hand-authored HTML (`a &lt; b`) is not double-escaped into `&amp;lt;`. */
function escapeKeepEntities(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[ i ];
    if (c === "&") {
      const m = ENTITY_RE.exec(text.slice(i));
      if (m) {
        out += m[ 0 ];
        i += m[ 0 ].length - 1;
      } else {
        out += "&amp;";
      }
    } else if (c === "<") {
      out += "&lt;";
    } else if (c === ">") {
      out += "&gt;";
    } else {
      out += c;
    }
  }
  return out;
}

/** Attribute values may arrive raw (`?a=1&b=2`) or escaped (`&amp;`); decode
 * the few references that matter, then encode once. Idempotent either way. */
function escapeAttr(value: string): string {
  const decoded = value
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'");
  return decoded
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** URL schemes worth turning into a link entity. Anything else stays text:
 * a relative path or a bare word in `[x](y)` position is not a Telegram link. */
const URL_RE = /^(https?:\/\/|tg:\/\/|mailto:)/i;

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of raw.matchAll(ATTR_RE)) {
    attrs.set(m[ 1 ].toLowerCase(), m[ 2 ] ?? m[ 3 ] ?? m[ 4 ] ?? "");
  }
  return attrs;
}

function buildOpenTag(canonical: string, allowed: readonly string[] | undefined, attrs: Map<string, string>): string {
  let out = `<${canonical}`;
  for (const name of allowed ?? []) {
    if (!attrs.has(name)) continue;
    const value = attrs.get(name) ?? "";
    if (name === "href" && !URL_RE.test(value.trim())) continue;
    if (name === "class" && !/^language-[\w+#.-]+$/.test(value)) continue;
    if (name === "emoji-id" && !/^\d+$/.test(value)) continue;
    out += value === "" && name === "expandable" ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`;
  }
  return out + ">";
}

function tryCodeSpan(s: string, i: number): { html: string; next: number } | null {
  let run = 0;
  while (s[ i + run ] === "`") run++;

  let k = i + run;
  while (k < s.length) {
    if (s[ k ] !== "`") {
      k++;
      continue;
    }
    let end = k;
    while (s[ end ] === "`") end++;
    if (end - k === run) {
      let inner = s.slice(i + run, k);
      if (inner.includes("\n\n")) return null;
      // GFM: one space is stripped from each side when both are present,
      // so `` ` code ` `` can hold a leading backtick.
      if (inner.length >= 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "") {
        inner = inner.slice(1, -1);
      }
      return { html: `<code>${escapeAll(inner)}</code>`, next: end };
    }
    k = end;
  }
  return null;
}

function tryLink(s: string, i: number): { html: string; next: number } | null {
  let depth = 1;
  let j = i + 1;
  for (; j < s.length; j++) {
    const c = s[ j ];
    if (c === "\n") return null;
    if (c === "\\") j++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  if (depth !== 0 || s[ j + 1 ] !== "(") return null;

  let pdepth = 1;
  let k = j + 2;
  for (; k < s.length; k++) {
    const c = s[ k ];
    if (c === "\n") return null;
    if (c === "\\") k++;
    else if (c === "(") pdepth++;
    else if (c === ")" && --pdepth === 0) break;
  }
  if (pdepth !== 0) return null;

  const label = s.slice(i + 1, j);
  let dest = s.slice(j + 2, k).trim();
  if (dest.startsWith("<") && dest.endsWith(">")) dest = dest.slice(1, -1);
  const ws = dest.search(/\s/);
  if (ws !== -1) dest = dest.slice(0, ws); // an optional "title" is dropped
  if (label.length === 0 || !URL_RE.test(dest)) return null;

  return { html: `<a href="${escapeAttr(dest)}">${renderInline(label)}</a>`, next: k + 1 };
}

function tryEmphasis(s: string, i: number): { html: string; next: number } | null {
  const ch = s[ i ];
  const variants = EMPHASIS[ ch ];
  if (!variants) return null;

  let run = 0;
  while (s[ i + run ] === ch) run++;

  for (const v of variants) {
    if (run < v.len) continue;
    const after = s[ i + v.len ];
    // Left flank: the run must hug its content. `2 * 3` stays arithmetic.
    if (after === undefined || /\s/.test(after)) continue;
    // `_` must not open inside a word, or snake_case_names grow italics.
    if (ch === "_" && i > 0 && WORD_RE.test(s[ i - 1 ])) continue;

    const delim = ch.repeat(v.len);
    let j = s.indexOf(delim, i + v.len);
    while (j !== -1) {
      const between = s.slice(i + v.len, j);
      if (between.includes("\n\n")) break; // an emphasis does not cross a blank line
      const before = s[ j - 1 ];
      const afterClose = s[ j + v.len ];
      const closes = before !== undefined && !/\s/.test(before)
        && (ch !== "_" || afterClose === undefined || !WORD_RE.test(afterClose));
      if (closes && between.length > 0) {
        return { html: v.open + renderInline(between) + v.close, next: j + v.len };
      }
      j = s.indexOf(delim, j + 1);
    }
  }
  return null;
}

/** Inline pass: markdown spans, allowed HTML, and escaping, over text that
 * the block pass already cleared of fences, headings and quotes. */
function renderInline(s: string): string {
  let out = "";
  let i = 0;

  while (i < s.length) {
    const c = s[ i ];

    if (c === "\\" && i + 1 < s.length && ESCAPABLE.has(s[ i + 1 ])) {
      const next = s[ i + 1 ];
      out += next === "<" ? "&lt;" : next === ">" ? "&gt;" : next;
      i += 2;
      continue;
    }

    if (c === "<") {
      const m = TAG_RE.exec(s.slice(i));
      if (m) {
        const closing = m[ 1 ] === "/";
        const name = m[ 2 ].toLowerCase();
        if (name === "br") {
          if (!closing) out += "\n";
          i += m[ 0 ].length;
          continue;
        }
        const spec = TELEGRAM_TAGS[ name ];
        if (spec) {
          if (closing) {
            out += `</${spec.canonical}>`;
            i += m[ 0 ].length;
            continue;
          }
          if (spec.canonical === "code" || spec.canonical === "pre") {
            // Code bodies pass through untouched by markdown: `**` inside
            // <code> is content, not emphasis.
            const close = s.toLowerCase().indexOf(`</${name}>`, i + m[ 0 ].length);
            if (close !== -1) {
              out += buildOpenTag(spec.canonical, spec.attrs, parseAttrs(m[ 3 ]))
                + escapeKeepEntities(s.slice(i + m[ 0 ].length, close))
                + `</${spec.canonical}>`;
              i = close + name.length + 3;
              continue;
            }
            // An unclosed <code> is not markup; fall through to a literal `<`.
          } else {
            out += buildOpenTag(spec.canonical, spec.attrs, parseAttrs(m[ 3 ]));
            i += m[ 0 ].length;
            continue;
          }
        } else if (DROP_TAGS.has(name)) {
          i += m[ 0 ].length;
          continue;
        }
      }
      out += "&lt;";
      i++;
      continue;
    }

    if (c === "&") {
      const m = ENTITY_RE.exec(s.slice(i));
      if (m) {
        out += m[ 0 ];
        i += m[ 0 ].length;
      } else {
        out += "&amp;";
        i++;
      }
      continue;
    }

    if (c === ">") {
      out += "&gt;";
      i++;
      continue;
    }

    if (c === "`") {
      const span = tryCodeSpan(s, i);
      if (span) {
        out += span.html;
        i = span.next;
        continue;
      }
      let run = 0;
      while (s[ i + run ] === "`") run++;
      out += s.slice(i, i + run);
      i += run;
      continue;
    }

    if (c === "[") {
      const link = tryLink(s, i);
      if (link) {
        out += link.html;
        i = link.next;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    if (c === "*" || c === "_" || c === "~" || c === "|") {
      const em = tryEmphasis(s, i);
      if (em) {
        out += em.html;
        i = em.next;
        continue;
      }
      let run = 0;
      while (s[ i + run ] === c) run++;
      out += s.slice(i, i + run);
      i += run;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/;
const FENCE_CLOSE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;

/**
 * Render agent-authored text — markdown, Telegram HTML, or a mix — into
 * HTML for GramJS's `html` parse mode. Block constructs are handled here;
 * everything between them goes through {@link renderInline} as one chunk,
 * so an emphasis may span a soft line break but never a blank line.
 */
function renderTelegramHtml(input: string): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let plain: string[] = [];

  const flush = () => {
    if (plain.length > 0) {
      out.push(renderInline(plain.join("\n")));
      plain = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[ i ];

    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      const marker = fence[ 1 ][ 0 ];
      const minLen = fence[ 1 ].length;
      const info = (fence[ 2 ].trim().split(/\s+/)[ 0 ] ?? "");
      const lang = /^[\w+#.-]+$/.test(info) ? info : "";

      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        const close = FENCE_CLOSE_RE.exec(lines[ j ]);
        if (close && close[ 1 ][ 0 ] === marker && close[ 1 ].length >= minLen) {
          closed = true;
          break;
        }
        body.push(lines[ j ]);
      }

      flush();
      const code = escapeAll(body.join("\n"));
      out.push(lang
        ? `<pre><code class="language-${lang}">${code}</code></pre>`
        : `<pre>${code}</pre>`);
      i = closed ? j + 1 : lines.length;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      out.push(`<b>${renderInline(heading[ 2 ].trim())}</b>`);
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flush();
      const quoted: string[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const q = QUOTE_RE.exec(lines[ j ]);
        if (!q) break;
        quoted.push(q[ 1 ]);
      }
      out.push(`<blockquote>${renderInline(quoted.join("\n"))}</blockquote>`);
      i = j;
      continue;
    }

    plain.push(line);
    i++;
  }

  flush();
  return out.join("\n");
}

export { renderTelegramHtml };
