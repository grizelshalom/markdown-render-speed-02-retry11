// parse.js — fast dependency-free renderer matching marked 18.1.3.
//
// parse(md) returns exactly what marked 18.1.3's marked.parse(md) returns
// under its defaults (gfm on, breaks off, pedantic off, synchronous).
// Written from scratch here: a line-oriented block lexer plus an inline
// scanner that hops between interesting characters with one regex, so
// long stretches of plain text are skipped in bulk.
//
// Inline state shared across a whole document lives in a small object:
// whether an <a> is currently open (bare links stay off while it is)
// and whether the current run is inside a raw element (<pre> etc.),
// whose text passes through untouched. No state is kept between
// parse() calls: every call renders its input alone.

// ---------- small character helpers ----------

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const PUNCT_SET = new Set(PUNCT);

function punct(c) {
  if (!c) return false;
  const n = c.charCodeAt(0);
  if (n < 128) return PUNCT_SET.has(c);
  return /[\p{P}\p{S}]/u.test(c);
}

function ws(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' ';
}

function alnum(c) {
  if (!c) return false;
  const n = c.charCodeAt(0);
  if (n < 128) return (n >= 48 && n <= 57) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122);
  return /[\p{L}\p{N}]/u.test(c);
}

// ---------- escaping ----------

const ESC = { '"': '&quot;', "'": '&#39;', '&': '&amp;', '<': '&lt;', '>': '&gt;' };

export function escapeAll(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

const TEXT_ESC_RE = /&(?!(?:#\d{1,7}|#[Xx][\dA-Fa-f]{1,6}|[A-Za-z][\dA-Za-z]{0,31});)|[<>"']/g;
export function escapeText(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  return s.replace(TEXT_ESC_RE, (c) => ESC[c]);
}

const BS_ESC_RE = /\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g;
export function unescapeBackslash(s) {
  if (s.indexOf('\\') < 0) return s;
  return s.replace(BS_ESC_RE, '$1');
}

// Fold a reference label the way lookup does: expand the few characters
// whose Unicode folding grows them, collapse whitespace runs to one
// space, trim, lowercase. Backslashes stay put.
const FOLD_GROW = { 'ß': 'ss', 'ẞ': 'ss', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
export function foldLabel(s) {
  let out = '';
  for (const ch of s) out += FOLD_GROW[ch] || ch;
  return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Clean a URL the way marked does: encode it, then turn %25 back into %
// (a literal % survives, and an encoded %25 survives too, because
// encodeURI doubles it to %2525 first).
export function cleanUrl(href) {
  if (!href) return href;
  try {
    const enc = encodeURI(href);
    return enc.indexOf('%25') < 0 ? enc : enc.replace(/%25/g, '%');
  } catch (e) { return href; }
}

// Decode numeric character references and escape the result when it
// needs escaping, in one pass. Named references stay literal; a bare &
// becomes &amp;.
const RICH_RE = /&(#\d{1,7}|#[Xx][\dA-Fa-f]{1,6});|[<>"']|&(?!(?:#\d{1,7}|#[Xx][\dA-Fa-f]{1,6}|[A-Za-z][\dA-Za-z]{0,31});)/g;
const PLAIN_RE = /[<>"']/g;
export function escapeRich(s) {
  if (s.indexOf('&') < 0) {
    if (s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
    return s.replace(PLAIN_RE, (c) => ESC[c]);
  }
  return s.replace(RICH_RE, (whole, body) => {
    if (body !== undefined) {
      let cp;
      if (body[1] === 'x' || body[1] === 'X') cp = parseInt(body.slice(2), 16);
      else cp = parseInt(body.slice(1), 10);
      if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
      const ch = String.fromCodePoint(cp);
      return ESC[ch] || ch;
    }
    return ESC[whole];
  });
}

// A text node must not end in a partial entity prefix: merging the next
// text onto it could complete an entity that separate nodes would have
// escaped.
const TAIL_ENTITY = /&(?:#\d{0,7}|#[Xx][\dA-Fa-f]{0,6}|[A-Za-z][\dA-Za-z]{0,31})$/;

const NUM_ENTITY_RE = /&(#\d{1,7}|#[Xx][\dA-Fa-f]{1,6});/g;
export function decodeNumeric(s) {
  if (s.indexOf('&#') < 0) return s;
  return s.replace(NUM_ENTITY_RE, (whole, body) => {
    let cp;
    if (body[1] === 'x' || body[1] === 'X') cp = parseInt(body.slice(2), 16);
    else cp = parseInt(body.slice(1), 10);
    if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
    return String.fromCodePoint(cp);
  });
}

// ---------- inline patterns ----------

const URL_RUN = /[^\s<>`]+/y;
const DOMAIN_RE = /[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)+/y;
const LOCAL_TAIL = /[A-Za-z0-9._+\-]+$/;
const ANGLE_URL = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/y;
const ANGLE_MAIL = /<([A-Za-z0-9._+\-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.[A-Za-z0-9]+)>/y;
const COMMENT_RE = /<!--(>|->|-->|[\s\S]*?-->)/y;
const PI_RE = /<\?[\s\S]*?\?>/y;
const DECL_RE = /<![A-Za-z][^>]*>/y;
const CDATA_RE = /<!\[CDATA\[[\s\S]*?\]\]>/y;
const OPEN_TAG_RE = /<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:'[^']*'|"[^"]*"|[^\s"'=<>`]+))?)*\s*\/?>/y;
const CLOSE_TAG_RE = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/y;

const OPENS_A = /^<a /i;
const CLOSES_A = /^<\/a>/i;
const OPENS_RAW = /^<(pre|code|kbd|script)(\s|>)/i;
const CLOSES_RAW = /^<\/(pre|code|kbd|script)(\s|>)/i;

// GFM backpedal for a bare-URL candidate: marked's regex loop, applied
// until stable. A trailing ')' survives when it belongs to a balanced
// (...) group.
const PEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
function trimUrl(u) {
  let prev = u;
  for (;;) {
    const m = PEDAL.exec(u);
    const next = m ? m[0] : '';
    if (next === prev) return next;
    prev = next;
    u = next;
  }
}

// ---------- emphasis masking ----------
//
// marked masks the inline source before deciding which delimiters can
// open or close emphasis: backticks inside a code span and escaped
// punctuation become '+', and whole link spans, code spans and html
// tags become 'a's (length preserved, so offsets line up). A delimiter
// whose character is masked cannot open or close emphasis.

function maskCodeAndEscapes(src) {
  const n = src.length;
  const parts = [];
  let seg = 0;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const run = j - i;
      let k = j + 1;
      let close = -1;
      while (k < n) {
        if (src[k] === '`') {
          let e = k;
          while (e < n && src[e] === '`') e++;
          if (e - k === run) { close = k; break; }
          k = e;
        } else k++;
      }
      if (close !== -1) {
        let innerTick = false;
        for (let t = j; t < close; t++) {
          if (src[t] === '`') { innerTick = true; break; }
        }
        if (innerTick) {
          parts.push(src.slice(seg, i));
          let buf = src.slice(i, j);
          for (let t = j; t < close; t++) buf += src[t] === '`' ? '+' : src[t];
          buf += src.slice(close, close + run);
          parts.push(buf);
          i = close + run;
          seg = i;
        } else {
          i = close + run;
        }
        continue;
      }
      i = j;
      continue;
    }
    if (c === '\\' && i + 1 < n && punct(src[i + 1])) {
      parts.push(src.slice(seg, i));
      parts.push('++');
      i += 2;
      seg = i;
      continue;
    }
    i++;
  }
  if (parts.length === 0) return src;
  parts.push(src.slice(seg));
  return parts.join('');
}

const MASK_SPAN_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
function maskSpans(src) {
  let out = src;
  if (src.includes('`') || src.includes('\\')) out = maskCodeAndEscapes(out);
  return out.replace(MASK_SPAN_RE, (m0) => 'a'.repeat(m0.length));
}

// The `]` closing a link label that starts at src[open] === '[',
// mirroring marked's inline label scan: backslash escapes and code
// spans (a run of 2+ right before `]` is literal), brackets nest at
// most 2 deep. Returns the index of the `]` or -1.
function labelEnd(src, open) {
  let i = open + 1;
  let depth = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const run = j - i;
      if (run >= 2 && src[j] === ']') { i = j; continue; }
      let k = j;
      let found = -1;
      while (k < n) {
        if (src[k] === '`') {
          let e = k;
          while (e < n && src[e] === '`') e++;
          found = e;
          break;
        }
        k++;
      }
      if (found === -1) return -1;
      i = found;
      continue;
    }
    if (c === '[') {
      depth++;
      if (depth > 2) return -1;
      i++;
      continue;
    }
    if (c === ']') {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// The `]` closing a reference label starting at src[start], mirroring
// marked's block label scan: no nesting, backslash escapes skipped,
// backticks allowed, newlines allowed unless followed by a blank line,
// and the label may not be empty or whitespace-only. -1 on failure.
function refLabelEnd(src, start) {
  const n = src.length;
  let k = start;
  while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  if (k < n && src[k] === ']') return -1;
  let i = start;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') return -1;
    if (c === ']') return i;
    if (c === '\n') {
      let j = i + 1;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
      if (j < n && src[j] === '\n') return -1;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

function skipWs(src, i) {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
  return i;
}

// Parse `(dest "title")` starting at src[i] === '('. null on failure.
function readDest(src, i) {
  const n = src.length;
  let j = skipWs(src, i + 1);
  let dest = '';
  if (j < n && src[j] === '<') {
    let k = j + 1;
    while (k < n) {
      const c = src[k];
      if (c === '\\' && k + 1 < n && PUNCT.indexOf(src[k + 1]) !== -1) { k += 2; continue; }
      if (c === '>' || c === '\n' || c === '<') break;
      k++;
    }
    if (k >= n || src[k] !== '>') return null;
    dest = unescapeBackslash(src.slice(j + 1, k));
    j = k + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < n) {
      const c = src[j];
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '\\' && j + 1 < n && PUNCT.indexOf(src[j + 1]) !== -1) { j += 2; continue; }
      if (c === '(') { depth++; j++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; j++; continue;
      }
      if (c.charCodeAt(0) < 32) return null;
      j++;
    }
    dest = unescapeBackslash(src.slice(start, j));
  }
  j = skipWs(src, j);
  let title = null;
  if (j < n && (src[j] === '"' || src[j] === "'" || src[j] === '(')) {
    const q = src[j];
    const close = q === '(' ? ')' : q;
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = src[k];
      if (c === '\\' && k + 1 < n && PUNCT.indexOf(src[k + 1]) !== -1) { k += 2; continue; }
      if (c === close) { ok = true; break; }
      if (q === '(' && c === '(') return null;
      k++;
    }
    if (!ok) return null;
    title = src.slice(j + 1, k);
    j = skipWs(src, k + 1);
  }
  if (j >= n || src[j] !== ')') return null;
  return { href: dest, title, end: j + 1 };
}

function hasLink(nodes) {
  for (const nd of nodes) {
    if (nd.k === 'link') return true;
    if (nd.c && hasLink(nd.c)) return true;
  }
  return false;
}

function textOf(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 't') out += nd.raw ? nd.s : decodeNumeric(nd.s);
    else if (nd.k === 'code') out += nd.s;
    else if (nd.k === 'img') out += nd.alt;
    else if (nd.k === 'alink') out += nd.text;
    else if (nd.c) out += textOf(nd.c);
  }
  return out;
}

// ---------- emphasis / strikethrough ----------
//
// Delimiter record: {ch, len, orig, open, close, node, pos}. The resolver
// walks closers left to right and pairs each with the nearest earlier
// live opener of the same character.
//
// Closer-leftover rule (marked's emStrong): when a closer run is longer
// than the opener run, the extra delimiter chars land INSIDE the
// emphasis text (at its end) when the opener's own length plus the
// delimiters the forward scan skipped (rule-of-three) or counted as
// extra openers between them already covers the whole closer run.
// Otherwise the extra chars stay AFTER the emphasis as literal text.
// For an opener of length Lo and a closer of length Lc:
//   consumed = min(Lc, Lo + leftExtra + mid - closerCand)
// where leftExtra sums left-only delimiters between them, mid sums
// both-ways delimiters rule-of-three-skipped against the opener, and
// closerCand sums closer candidates between them. (consumed - use)
// chars of the closer run are appended to the emphasis text; the rest
// (Lc - consumed) stay after. This only applies when the opener has no
// leftover of its own — a leftover opener pairs with the closer
// remainder instead (***a*** -> <em><strong>a</strong></em>).
// Each emphasis node records the delimiters it consumed (its own opener
// and closer runs, plus its children's) in `used`, so an outer pairing
// can account for them.

// Does a node list contain a node that blocks an outer single-`*`
// emphasis: a `**` strong, or (when the outer opener is a `**` run)
// an `*` emphasis — one whose opener can only open and whose closing
// run is immediately followed by an alphanumeric character?
function hasBlocker(nodes, includeEm) {
  for (const nd of nodes) {
    if ((nd.k === 'strong' || (includeEm && nd.k === 'em')) && nd.afterAlnum && nd.openerPure) return true;
    if (nd.c && hasBlocker(nd.c, includeEm)) return true;
  }
  return false;
}

function resolveDelims(nodes, delims) {
  for (let di = 0; di < delims.length; di++) {
    const closer = delims[di];
    if (!closer.close || closer.len === 0) continue;
    let oi = di - 1;
    let opener = null;
    while (oi >= 0) {
      const cand = delims[oi];
      if (cand.ch === closer.ch && cand.open && cand.len > 0 && nodes.indexOf(cand.node) !== -1) {
        // strikethrough pairs only equal runs of one or two tildes
        if (closer.ch === '~' && (cand.len !== closer.len || cand.len > 2)) { oi--; continue; }
        // rule of three: only when one of the two delimiters can both
        // open and close, and the sum is a multiple of 3, and NOT both
        // lengths are multiples of 3
        const bothWays = (cand.open && cand.close) || (closer.open && closer.close);
        const odd = bothWays && ((cand.len + closer.len) % 3 === 0) && !(cand.len % 3 === 0 && closer.len % 3 === 0);
        if (odd) { oi--; continue; }
        // a single-`*` emphasis formed directly (neither delimiter a
        // leftover of a longer run) may not span a blocking `**` strong
        const use0 = cand.len >= 2 && closer.len >= 2 ? 2 : 1;
        const kind0 = closer.ch === '~' ? 'del' : (use0 === 2 ? 'strong' : 'em');
        if (kind0 === 'em' && closer.ch === '*' && cand.len === cand.orig && closer.len === closer.orig) {
          const op0 = nodes.indexOf(cand.node);
          const cl0 = nodes.indexOf(closer.node);
          if (op0 !== -1 && cl0 !== -1 && cl0 > op0 && hasBlocker(nodes.slice(op0 + 1, cl0), cand.len >= 2)) { oi--; continue; }
        }
        opener = cand; break;
      }
      oi--;
    }
    if (!opener) continue;
    const use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
    const kind = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const opPos = nodes.indexOf(opener.node);
    const clPos = nodes.indexOf(closer.node);
    if (opPos === -1 || clPos === -1 || clPos <= opPos) continue;
    const inner = nodes.slice(opPos + 1, clPos);
    // the character right after this closer's run, for the rule above
    const afterNode = nodes[clPos + 1];
    const afterCh = afterNode && afterNode.k === 't' ? afterNode.s[0] : '';
    const afterAlnum = /[A-Za-z0-9]/.test(afterCh);
    const innerSet = new Set(inner);
    // how much of the closer run does marked's forward scan consume?
    // (only for * / _ emphasis; ~ pairs are always equal runs)
    let consumed = use;
    if ((closer.ch === '*' || closer.ch === '_') && opener.len === use && closer.len > use) {
      const Lo = opener.len;
      let leftExtra = 0, mid = 0, closerCand = 0;
      const account = (d) => {
        if (d.ch !== closer.ch) return;
        if (d.open && !d.close) leftExtra += d.len;
        else if (d.open && d.close) {
          if (Lo % 3 !== 0 && (Lo + d.len) % 3 === 0) mid += d.len;
          else closerCand += d.len;
        } else closerCand += d.len;
      };
      for (const nd of inner) if (nd.used) for (const d of nd.used) account(d);
      for (const dm of delims) if (innerSet.has(dm.node)) account(dm);
      consumed = Math.min(closer.len, Lo + leftExtra + mid - closerCand);
      if (consumed < use) consumed = use;
      if (consumed > use) inner.push({ k: 't', s: closer.node.s.slice(0, consumed - use), raw: closer.node.raw });
    }
    const wrap = { k: kind, c: inner };
    if ((kind === 'strong' || kind === 'em') && closer.ch === '*') { wrap.afterAlnum = afterAlnum; wrap.openerPure = opener.open && !opener.close; }
    // delimiters consumed inside this emphasis, for outer pairings
    const used = [];
    for (const nd of inner) if (nd.used) used.push(...nd.used);
    used.push({ ch: opener.ch, len: opener.len, open: opener.open, close: opener.close });
    used.push({ ch: closer.ch, len: closer.len, open: closer.open, close: closer.close });
    wrap.used = used;
    const repl = [];
    if (opener.len > use) {
      const rem = { k: 't', s: opener.node.s.slice(0, opener.len - use), raw: opener.node.raw };
      repl.push(rem);
      opener.node = rem;
      opener.len = opener.len - use;
    } else {
      opener.len = 0;
    }
    repl.push(wrap);
    if (closer.len > consumed) {
      const rem = { k: 't', s: closer.node.s.slice(consumed), raw: closer.node.raw };
      repl.push(rem);
      closer.node = rem;
      closer.len = closer.len - consumed;
    } else {
      closer.len = 0;
    }
    nodes.splice(opPos, clPos - opPos + 1, ...repl);
    // drop one delimiter entry, shifting di when the removed entry sits
    // at or before it, so di keeps pointing at the same delimiter
    const dropOne = (dm) => {
      const idx = delims.indexOf(dm);
      if (idx === -1) return;
      delims.splice(idx, 1);
      if (idx <= di) di--;
    };
    // delimiters trapped inside the new emphasis node can never match
    // at this level again; drop them
    for (let d = delims.length - 1; d >= 0; d--) {
      const dm = delims[d];
      if (dm !== opener && dm !== closer && innerSet.has(dm.node)) dropOne(dm);
    }
    if (opener.len === 0) dropOne(opener);
    if (closer.len === 0) {
      dropOne(closer);
    } else {
      // the closer still has delimiters left: re-examine it so the
      // remainder can pair with the leftover opener
      // (***a*** -> <em><strong>a</strong></em>, not *<strong>a</strong>*)
      di--;
    }
  }
}

// ---------- the inline scanner ----------
//
// The scanner is a small class: the main loop jumps from one boundary
// token to the next with a single regex, and each token kind has its own
// handler, so runs of plain text are skipped in bulk instead of one
// character at a time.
//
// Returns a node list for src. `doc` is the document state {inLink,
// inRawBlock}: top-level calls share one object per parse() (an unclosed
// <a> tag suppresses later bare URLs / emails across paragraphs, exactly
// like marked); a link label is re-parsed with a fresh
// {inLink: true, inRawBlock: false}.

// One shared boundary regex for the inline scanner (single-threaded,
// and scan() resets lastIndex on every call, so sharing is safe).
const INLINE_BOUNDARY = /[\\`*_~\[\]<\n]|:\/\/|www\.|@/g;

class InlineParser {
  constructor(src, refs, doc) {
    this.src = src;
    this.refs = refs;
    this.doc = doc;
    this.len = src.length;
    this.out = [];
    this.delims = [];
    this.openers = []; // {node, start, image} — unclosed '[' brackets
    this.pending = '';
    this.pos = 0;
    // Masked copy for emphasis: only needed when a delimiter char is
    // present AND something could mask one — a backtick (code span), a
    // '[' (link span) or a '<' (html tag). Escaped punctuation is masked
    // too, but an escaped delimiter is never a delimiter node, so it
    // cannot hide one; skipping the two regex scans otherwise is free.
    this.masked = (src.includes('*') || src.includes('_') || src.includes('~'))
      && (src.includes('`') || src.includes('[') || src.includes('<'))
      ? maskSpans(src) : null;
  }

  // A text node may not end in a partial entity prefix: merging
  // following text onto it could complete an entity (`&` + `amp;`)
  // that separate nodes would have escaped, changing the output.
  flush() {
    if (!this.pending) return;
    const last = this.out[this.out.length - 1];
    if (last && last.k === 't' && last.m && last.raw === this.doc.inRawBlock &&
      !TAIL_ENTITY.test(last.s)) {
      last.s += this.pending;
    } else {
      this.out.push({ k: 't', s: this.pending, raw: this.doc.inRawBlock, m: true });
    }
    this.pending = '';
  }

  // After a failed-link re-parse, the last fresh node may be an
  // autolink that ran to the end of the re-parse source (label + ']').
  // In the outer source that autolink can continue past the ']' — marked
  // tokenizes the label text in the main flow, so the URL is not cut
  // off there. Re-scan it from the outer source and extend the node,
  // returning the scanner position to continue from, or null.
  extendAutolink(fresh, labelRaw, op) {
    const lastFresh = fresh[fresh.length - 1];
    if (!lastFresh || lastFresh.k !== 'alink') return null;
    const reparseSrc = labelRaw + ']';
    const urlText = lastFresh.text;
    if (!reparseSrc.endsWith(urlText)) return null;
    const startInReparse = reparseSrc.length - urlText.length;
    if (startInReparse >= labelRaw.length) return null;
    const outerStart = op.start + startInReparse;
    let ext = null;
    let isScheme = false;
    const src = this.src;
    if (urlText.indexOf('://') !== -1) {
      isScheme = true;
      const schemeLen = urlText.indexOf('://');
      URL_RUN.lastIndex = outerStart + schemeLen + 3;
      const bm = URL_RUN.exec(src);
      if (bm) ext = trimUrl(urlText.slice(0, schemeLen) + '://' + bm[0]);
    } else if (urlText.startsWith('www.')) {
      URL_RUN.lastIndex = outerStart;
      const bm = URL_RUN.exec(src);
      if (bm) ext = trimUrl(bm[0]);
    }
    if (!ext || ext.length <= urlText.length) return null;
    lastFresh.text = ext;
    lastFresh.href = cleanUrl(isScheme ? ext : 'http://' + ext);
    return outerStart + ext.length;
  }

  // Re-parse a failed label with autolinks on, splicing the fresh nodes
  // in where the label's nodes were. Used when a link fails to form
  // but the label contains something link-like.
  reparseLabel(op, labelRaw) {
    const opPos = this.out.indexOf(op.node);
    const fresh = parseInline(labelRaw + ']', this.refs, this.doc);
    const removed = new Set(this.out.slice(opPos + 1));
    for (let d = this.delims.length - 1; d >= 0; d--) {
      if (removed.has(this.delims[d].node)) this.delims.splice(d, 1);
    }
    this.out.splice(opPos + 1, this.out.length - (opPos + 1), ...fresh);
    this.pending = '';
    const extEnd = this.extendAutolink(fresh, labelRaw, op);
    if (extEnd !== null) return extEnd;
    return null;
  }

  scan() {
    const BOUNDARY = INLINE_BOUNDARY;
    const src = this.src;
    BOUNDARY.lastIndex = 0;
    let m;
    while ((m = BOUNDARY.exec(src)) !== null) {
      const pos = m.index;
      const tok = m[0];
      if (pos > this.pos) { this.pending += src.slice(this.pos, pos); }
      this.pos = pos + tok.length;
      const c = tok[0];
      if (tok === '://') { this.onScheme(pos); BOUNDARY.lastIndex = this.pos; continue; }
      if (tok === 'www.') { this.onWww(pos); BOUNDARY.lastIndex = this.pos; continue; }
      if (tok === '@') { this.onAt(pos); BOUNDARY.lastIndex = this.pos; continue; }
      if (c === '\n') { this.onNewline(pos); BOUNDARY.lastIndex = this.pos; continue; }
      if (c === '\\') { this.onBackslash(pos); BOUNDARY.lastIndex = this.pos; continue; }
      if (c === '`') { this.onBacktick(pos); BOUNDARY.lastIndex = this.pos; continue; }
      if (c === '*' || c === '_' || c === '~') { this.onDelim(pos, c); BOUNDARY.lastIndex = this.pos; continue; }
      if (c === '[') { this.onOpen(pos); continue; }
      if (c === ']') { this.onClose(pos); BOUNDARY.lastIndex = this.pos; continue; }
      if (c === '<') { this.onLt(pos); BOUNDARY.lastIndex = this.pos; continue; }
      this.pending += tok;
    }
    if (this.pos < this.len) { this.pending += src.slice(this.pos); }
    this.flush();
    // an unclosed image opener keeps its `!`
    for (const op of this.openers) {
      if (op.image) op.node.s = '![';
    }
    // Drop masked delimiters: they cannot open or close emphasis.
    if (this.delims.length) {
      const live = this.masked
        ? this.delims.filter((d) => this.masked[d.pos] === d.ch)
        : this.delims;
      resolveDelims(this.out, live);
    }
    return this.out;
  }

  onScheme(pos) {
    const src = this.src;
    if (this.doc.inLink || this.openers.length > 0) { this.pending += '://'; this.pos = pos + 3; return; }
    // scan back for the scheme inside pending
    let s = this.pending.length - 1;
    while (s >= 0 && /[A-Za-z0-9+.-]/.test(this.pending[s])) s--;
    const scheme = this.pending.slice(s + 1);
    if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}$/.test(scheme)) {
      URL_RUN.lastIndex = pos + 3;
      const bm = URL_RUN.exec(src);
      if (bm) {
        let url = scheme + '://' + bm[0];
        url = trimUrl(url);
        if (url.length > scheme.length + 3) {
          this.pending = this.pending.slice(0, s + 1);
          this.flush();
          this.out.push({ k: 'alink', href: cleanUrl(url), text: url });
          this.pos = pos + 3 + (url.length - scheme.length - 3);
          return;
        }
      }
    }
    this.pending += '://';
  }

  onWww(pos) {
    const src = this.src;
    if (this.doc.inLink || this.openers.length > 0) { this.pending += 'www.'; return; }
    // marked's text rule only stops for www. at the start of a line
    // or after whitespace, *, _, ~ or (
    const prev = pos > 0 ? src[pos - 1] : '';
    if (prev && !(ws(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(')) {
      this.pending += 'www.';
      return;
    }
    URL_RUN.lastIndex = pos;
    const bm = URL_RUN.exec(src);
    if (bm) {
      let url = trimUrl(bm[0]);
      if (url.length > 4) {
        this.flush();
        this.out.push({ k: 'alink', href: cleanUrl('http://' + url), text: url });
        this.pos = pos + url.length;
        return;
      }
    }
    this.pending += 'www.';
  }

  onAt(pos) {
    const src = this.src;
    const n = this.len;
    if (this.doc.inLink || this.openers.length > 0) { this.pending += '@'; return; }
    // The local part may start in an earlier text node: an emphasis
    // delimiter run (e.g. the `_` in a.b-c_d) splits pending, so rebuild
    // the tail from the trailing text nodes plus pending. Track which
    // tail segments are delimiter runs: a local part that begins
    // inside one is an emphasis opener, not part of the address —
    // but only when a closer for it exists ahead.
    const segs = [{ s: this.pending, delim: false }];
    for (let k = this.out.length - 1; k >= 0; k--) {
      if (this.out[k].k !== 't' || this.out[k].esc) break;
      segs.unshift({ s: this.out[k].s, delim: this.delims.some((d) => d.node === this.out[k]) });
    }
    const tail = segs.map((g) => g.s).join('');
    const lm = LOCAL_TAIL.exec(tail);
    if (!lm) { this.pending += '@'; return; }
    let local = lm[0];
    DOMAIN_RE.lastIndex = pos + 1;
    const dom = DOMAIN_RE.exec(src);
    if (!dom) { this.pending += '@'; return; }
    let email = local + '@' + dom[0];
    const endPos = pos + 1 + (email.length - local.length - 1);
    // does the local part begin inside a `_` delimiter run?
    const startIdx = tail.length - local.length;
    let acc = 0, lead = 0;
    for (const g of segs) {
      if (acc + g.s.length <= startIdx) { acc += g.s.length; continue; }
      if (g.delim && g.s[0] === '_') lead = acc + g.s.length - startIdx;
      break;
    }
    if (lead > 0) {
      // a closer for that opener ahead means the run is emphasis,
      // not part of the address
      let hasCloser = false;
      let j = endPos;
      while (j < n && !hasCloser) {
        if (src[j] === '\n' && src[j + 1] === '\n') break;
        if (src[j] === '_') {
          let k = j;
          while (k < n && src[k] === '_') k++;
          const pv = j > 0 ? src[j - 1] : '';
          const nx = k < n ? src[k] : '';
          const pvWs = pv === '' || ws(pv);
          const nxWs = nx === '' || ws(nx);
          const pvPu = pv !== '' && punct(pv);
          const nxPu = nx !== '' && punct(nx);
          const lf = !nxWs && (!nxPu || pvWs || pvPu);
          const rf = !pvWs && (!pvPu || nxWs || nxPu);
          if (rf && (!lf || nxPu)) hasCloser = true;
          j = k;
        } else j++;
      }
      if (hasCloser) {
        local = local.slice(lead);
        email = local + '@' + dom[0];
      }
    }
    const after = src[endPos];
    if (after && /[A-Za-z0-9_-]/.test(after)) {
      // a trailing `_` run is not part of the address when it is
      // an emphasis closer for an open `_` delimiter
      let ok = false;
      if (after === '_') {
        let e = endPos;
        while (e < n && src[e] === '_') e++;
        const afterRun = src[e];
        if ((!afterRun || !/[A-Za-z0-9]/.test(afterRun)) &&
          this.delims.some((d) => d.ch === '_' && d.open && this.out.indexOf(d.node) !== -1)) ok = true;
      }
      if (!ok) { this.pending += '@'; return; }
    }
    const fullLen = email.length - local.length - 1;
    // a `mailto:` or `xmpp:` scheme immediately before the local
    // part is absorbed into the link (no other scheme is)
    let scheme = '';
    let cut = tail.length - local.length;
    const before = tail.slice(0, cut);
    const schemeM = /(?:^|[^A-Za-z0-9])(mailto:|xmpp:)$/.exec(before);
    if (schemeM) { scheme = schemeM[1]; cut -= scheme.length; }
    // an xmpp link also takes one following path segment
    let extra = '';
    if (scheme === 'xmpp:' && src[endPos] === '/') {
      let e = endPos + 1;
      while (e < n && src[e] !== '/' && src[e] !== ';' && !ws(src[e]) && src[e] !== '<' && src[e] !== '>') e++;
      const seg = trimUrl(src.slice(endPos + 1, e));
      if (seg) extra = '/' + seg;
    }
    // drop the consumed chars (scheme + local part) from the end
    // of the trailing text run, trimming whole nodes and shrinking
    // any delimiter run that is cut short
    let drop = tail.length - cut;
    if (drop <= this.pending.length) {
      this.pending = this.pending.slice(0, this.pending.length - drop);
    } else {
      drop -= this.pending.length;
      this.pending = '';
      while (drop > 0 && this.out.length > 0) {
        const last = this.out[this.out.length - 1];
        if (last.k !== 't') break;
        if (last.s.length <= drop) {
          drop -= last.s.length;
          for (let d = this.delims.length - 1; d >= 0; d--) {
            if (this.delims[d].node === last) this.delims.splice(d, 1);
          }
          this.out.pop();
        } else {
          last.s = last.s.slice(0, last.s.length - drop);
          for (const dm of this.delims) {
            if (dm.node === last) dm.len -= drop;
          }
          drop = 0;
        }
      }
    }
    this.flush();
    const linkText = scheme + email + extra;
    this.out.push({ k: 'alink', href: scheme === '' ? 'mailto:' + email : linkText, text: linkText });
    this.pos = pos + 1 + fullLen + extra.length;
  }

  onNewline(pos) {
    const src = this.src;
    const n = this.len;
    if (/  +$/.test(this.pending)) {
      this.pending = this.pending.replace(/ +$/, '');
      this.flush();
      this.out.push({ k: 'br' });
      // a hard break eats the next line's leading spaces
      let i = this.pos;
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      this.pos = i;
    } else {
      this.pending += '\n';
    }
  }

  onBackslash(pos) {
    const src = this.src;
    const n = this.len;
    const nx = src[this.pos];
    if (nx === '\n') {
      this.flush();
      this.out.push({ k: 'br' });
      let i = this.pos + 1;
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      this.pos = i;
      return;
    }
    if (nx && PUNCT.indexOf(nx) !== -1) {
      // An escaped char is its own text node: a backslash-escaped `&`
      // must not combine with following text into an entity reference,
      // and an escaped char breaks an email's local part.
      this.flush();
      this.out.push({ k: 't', s: nx, esc: true });
      this.pos++;
      return;
    }
    this.pending += '\\';
  }

  onBacktick(pos) {
    const src = this.src;
    const n = this.len;
    let j = pos;
    while (j < n && src[j] === '`') j++;
    const run = j - pos;
    // find a closing run of exactly the same length
    let k = j;
    let close = -1;
    while (k < n) {
      if (src[k] === '`') {
        let e = k;
        while (e < n && src[e] === '`') e++;
        if (e - k === run) { close = k; break; }
        k = e;
      } else k++;
    }
    // inside a link label a code span may only close before the
    // label's `]` — an unbalanced run must not swallow the `]` and
    // everything up to a far-away run
    if (close !== -1 && this.openers.length > 0) {
      const le = labelEnd(src, this.openers[this.openers.length - 1].start - 1);
      if (le !== -1 && close > le) close = -1;
    }
    if (close !== -1) {
      let content = src.slice(j, close);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      this.flush();
      this.out.push({ k: 'code', s: content });
      this.pos = close + run;
      return;
    }
    this.pending += src.slice(pos, j);
    this.pos = j;
  }

  onDelim(pos, c) {
    const src = this.src;
    const n = this.len;
    let j = pos;
    while (j < n && src[j] === c) j++;
    const run = j - pos;
    const prev = pos > 0 ? src[pos - 1] : '';
    const next = j < n ? src[j] : '';
    const prevWs = prev === '' || ws(prev);
    const nextWs = next === '' || ws(next);
    const prevPunct = prev !== '' && punct(prev);
    const nextPunct = next !== '' && punct(next);
    const leftFlank = !nextWs && (!nextPunct || prevWs || prevPunct);
    const rightFlank = !prevWs && (!prevPunct || nextWs || nextPunct);
    let canOpen, canClose;
    if (c === '_') {
      canOpen = leftFlank && (!rightFlank || prevPunct);
      canClose = rightFlank && (!leftFlank || nextPunct);
    } else {
      canOpen = leftFlank;
      canClose = rightFlank;
    }
    this.flush();
    const node = { k: 't', s: src.slice(pos, j), raw: this.doc.inRawBlock };
    this.out.push(node);
    this.delims.push({ ch: c, len: run, orig: run, open: canOpen, close: canClose, node, pos });
    this.pos = j;
  }

  onOpen(pos) {
    let image = false;
    if (this.pending.endsWith('!')) {
      image = true;
      this.pending = this.pending.slice(0, -1);
    }
    this.flush();
    const node = { k: 't', s: '[', raw: this.doc.inRawBlock };
    this.out.push(node);
    this.openers.push({ node, start: pos + 1, image });
    this.pos = pos + 1;
  }

  onClose(pos) {
    const src = this.src;
    if (this.openers.length === 0) { this.pending += ']'; return; }
    const op = this.openers[this.openers.length - 1];
    const labelRaw = src.slice(op.start, pos);
    let href = null, title = null, end = -1, isRef = false;
    const after = src[pos + 1];
    // a link only forms when the label is a valid marked label ending
    // exactly here: inline-label rules for inline links and reflinks,
    // block-label rules for shortcut references
    const le = labelEnd(src, op.start - 1);
    const be = refLabelEnd(src, op.start);
    if (after === '(' && le === pos) {
      const parsed = readDest(src, pos + 1);
      if (parsed) { href = parsed.href; title = parsed.title; end = parsed.end; }
      else if (be === pos) {
        // not a valid inline link: fall back to a shortcut reference
        const ref = this.refs.get(foldLabel(labelRaw));
        if (ref) { href = ref.href; title = ref.title; end = pos + 1; isRef = true; }
      }
    } else if (after === '[' && le === pos) {
      if (src[pos + 2] === ']') {
        // [label][] — an empty ref means the label itself (nolink
        // form: the ref is a block label, so the label must be one too)
        if (be === pos) {
          const ref = this.refs.get(foldLabel(labelRaw));
          if (ref) { href = ref.href; title = ref.title; end = pos + 3; isRef = true; }
        }
      } else {
        const re = refLabelEnd(src, pos + 2);
        if (re !== -1) {
          const refRaw = src.slice(pos + 2, re);
          const ref = this.refs.get(foldLabel(refRaw));
          if (ref) { href = ref.href; title = ref.title; end = re + 1; isRef = true; }
        }
      }
    } else if (be === pos) {
      const ref = this.refs.get(foldLabel(labelRaw));
      if (ref) { href = ref.href; title = ref.title; end = pos + 1; isRef = true; }
    }
    if (href === null) {
      this.openers.pop();
      // a failed image keeps its `!`
      if (op.image) op.node.s = '![';
      // a bare URL inside a failed label still links: re-parse the
      // label (plus its `]`) with autolinks on, in the current state
      if (/www\.|:\/\/|@|</.test(labelRaw)) {
        const extEnd = this.reparseLabel(op, labelRaw);
        if (extEnd !== null) { this.pos = extEnd; return; }
      } else {
        this.pending += ']';
      }
      return;
    }
    // re-parse the label with extended autolinks off and inRawBlock
    // reset; a link inside the label blocks the outer link.
    const labelNodes = parseInline(labelRaw, this.refs, { inLink: true, inRawBlock: false });
    if (!op.image && hasLink(labelNodes)) {
      this.openers.pop();
      if (op.image) op.node.s = '![';
      if (/www\.|:\/\/|@|</.test(labelRaw)) {
        const extEnd = this.reparseLabel(op, labelRaw);
        if (extEnd !== null) { this.pos = extEnd; return; }
      } else {
        this.pending += ']';
      }
      return;
    }
    this.openers.pop();
    // splice out everything from the opener node to this `]`
    const opPos = this.out.indexOf(op.node);
    // drop delimiters recorded inside the replaced range
    const removed = new Set(this.out.slice(opPos));
    for (let d = this.delims.length - 1; d >= 0; d--) {
      if (removed.has(this.delims[d].node)) this.delims.splice(d, 1);
    }
    this.out.splice(opPos);
    // the pending text is label text: it is replaced by the link node,
    // so discard it instead of flushing it out as a stray text node
    this.pending = '';
    if (op.image) {
      this.out.push({ k: 'img', href, title, alt: textOf(labelNodes) });
    } else {
      this.out.push({ k: 'link', href, title, c: labelNodes });
    }
    this.pos = end;
  }

  onLt(pos) {
    const src = this.src;
    ANGLE_URL.lastIndex = pos;
    ANGLE_MAIL.lastIndex = pos;
    let m2 = ANGLE_URL.exec(src) || ANGLE_MAIL.exec(src);
    if (m2) {
      this.flush();
      const raw = m2[1];
      const isEmail = raw.indexOf('@') !== -1 && raw.indexOf(':') === -1;
      const href = isEmail ? 'mailto:' + raw : raw;
      this.out.push({ k: 'alink', href: cleanUrl(href), text: raw });
      this.pos = pos + m2[0].length;
      return;
    }
    COMMENT_RE.lastIndex = pos;
    PI_RE.lastIndex = pos;
    DECL_RE.lastIndex = pos;
    CDATA_RE.lastIndex = pos;
    OPEN_TAG_RE.lastIndex = pos;
    CLOSE_TAG_RE.lastIndex = pos;
    m2 = COMMENT_RE.exec(src) || PI_RE.exec(src) || DECL_RE.exec(src) ||
      CDATA_RE.exec(src) || OPEN_TAG_RE.exec(src) || CLOSE_TAG_RE.exec(src);
    if (m2) {
      this.flush();
      this.out.push({ k: 'html', s: m2[0] });
      // a raw html tag flips the document inline state
      if (OPENS_A.test(m2[0])) this.doc.inLink = true;
      else if (CLOSES_A.test(m2[0])) this.doc.inLink = false;
      if (OPENS_RAW.test(m2[0])) this.doc.inRawBlock = true;
      else if (CLOSES_RAW.test(m2[0])) this.doc.inRawBlock = false;
      this.pos = pos + m2[0].length;
      return;
    }
    this.pending += '<';
  }
}

export function parseInline(src, refs, doc) {
  return new InlineParser(src, refs, doc).scan();
}

// Render inline nodes to HTML. Text inside a raw block (<pre>, <code>,
// <kbd>, <script>) is emitted as-is: no escaping, no entity decoding.
export function renderInline(nodes) {
  const out = [];
  for (const nd of nodes) {
    if (nd.k === 't') out.push(nd.raw ? nd.s : escapeRich(nd.s));
    else if (nd.k === 'code') out.push('<code>' + escapeAll(nd.s) + '</code>');
    else if (nd.k === 'br') out.push('<br>');
    else if (nd.k === 'html') out.push(nd.s);
    else if (nd.k === 'em') out.push('<em>' + renderInline(nd.c) + '</em>');
    else if (nd.k === 'strong') out.push('<strong>' + renderInline(nd.c) + '</strong>');
    else if (nd.k === 'del') out.push('<del>' + renderInline(nd.c) + '</del>');
    else if (nd.k === 'alink') out.push('<a href="' + escapeAll(nd.href) + '">' + escapeAll(nd.text) + '</a>');
    else if (nd.k === 'link') {
      let s = '<a href="' + escapeText(cleanUrl(nd.href)) + '"';
      if (nd.title !== null && nd.title !== undefined) s += ' title="' + escapeText(unescapeBackslash(nd.title)) + '"';
      s += '>' + renderInline(nd.c) + '</a>';
      out.push(s);
    } else if (nd.k === 'img') {
      let s = '<img src="' + escapeText(cleanUrl(nd.href)) + '" alt="' + escapeText(nd.alt) + '"';
      if (nd.title !== null && nd.title !== undefined) s += ' title="' + escapeText(unescapeBackslash(nd.title)) + '"';
      s += '>';
      out.push(s);
    }
  }
  return out.join('');
}

// ---------- block lexing ----------
//
// The block lexer works line by line. Lines travel in a small context
// object: {lines, endsNL, isSub, inItem, lazy} where `lazy` is the set
// of line indices absorbed as lazy paragraph continuations (the inner
// lexer treats them as paragraph text), and `endsNL` says whether the
// source (or sub-content) ends with a newline. A context for a quote or
// list item is built fresh from its stripped lines.

const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section', 'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul']);

function blankLine(l) {
  return /^\s*$/.test(l);
}

// Indent of a line in columns (a tab advances to the next multiple of 4).
// Returns {col, i} where i is the index of the first non-space/tab char.
function lineIndent(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { col, i };
}

// Number of leading space/tab characters (not columns) of a line.
function leadingWs(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

// Strip n columns of leading indent from a line (tab-aware; a tab that
// straddles the boundary becomes spaces).
function stripCols(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const next = col + 4 - (col % 4);
      if (next <= n) { col = next; i++; }
      else return ' '.repeat(next - n) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

const ATX_RE = /^(#{1,6})(?:[ \t]+(.*))?$/;
const HR_RE = /^(?:\*[ \t]*){3,}$|^(?:-[ \t]*){3,}$|^(?:_[ \t]*){3,}$/;
const SETEXT_RE = /^([=]+|[-]+)[ \t]*$/;
const FENCE_RE = /^(```+|~~~+)(.*)$/;

// A line that opens a fenced code block: a backtick fence whose info
// string contains a backtick is not a fence at all.
function isFence(content) {
  const m = FENCE_RE.exec(content);
  if (!m) return false;
  if (m[1][0] === '`' && m[2].indexOf('`') !== -1) return false;
  return true;
}

const DELIM_ROW_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const MARKER_RE = /^([*+-]|\d{1,9}[.)])([ \t]+|$)/;

function splitRow(line) {
  // Marked's splitCells: a pipe is a cell separator unless escaped
  // (odd backslash count). Code spans do NOT protect pipes.
  const row = line.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((s) => s.trim().replace(/\\\|/g, '|'));
}

function readAligns(line) {
  const cells = splitRow(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    if (c[0] === ':' && c[c.length - 1] === ':') aligns.push('center');
    else if (c[0] === ':') aligns.push('left');
    else if (c[c.length - 1] === ':') aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

// Try to parse a link reference definition starting at lines[p].
// Returns {ref: {href, title}, used, label} or null.
function readLinkDef(lines, p) {
  const line = lines[p];
  const { col, i } = lineIndent(line);
  if (col > 3 || line[i] !== '[') return null;
  // The label may span lines: scan forward for the first unescaped `]`,
  // skipping code spans. A label containing `[` is not a definition.
  let labelRaw = '';
  let li = -1;
  let lpos = -1;
  {
    let acc = '';
    let done = false;
    for (let q = p; q < lines.length && !done; q++) {
      const l = lines[q];
      let k = q === p ? i + 1 : 0;
      while (k < l.length) {
        const c = l[k];
        if (c === '\\' && k + 1 < l.length) { acc += l.slice(k, k + 2); k += 2; continue; }
        if (c === '`') {
          let j = k;
          while (j < l.length && l[j] === '`') j++;
          const run = j - k;
          let e = j, found = -1;
          while (e < l.length) {
            if (l[e] === '`') {
              let f = e;
              while (f < l.length && l[f] === '`') f++;
              if (f - e === run) { found = f; break; }
              e = f;
            } else e++;
          }
          if (found !== -1) { acc += l.slice(k, found); k = found; continue; }
          acc += l.slice(k, j); k = j; continue;
        }
        if (c === '[') return null;
        if (c === ']') { labelRaw = acc; li = q; lpos = k + 1; done = true; break; }
        acc += c; k++;
      }
      if (!done) acc += '\n';
    }
    if (!done) return null;
  }
  if (!labelRaw.trim()) return null;
  let cur = li;
  let rest = lines[li].slice(lpos);
  // ':' then optional whitespace
  const m = /^[ \t]*:[ \t]*/.exec(rest);
  if (!m) return null;
  rest = rest.slice(m[0].length);
  // destination may be on the next line
  if (rest === '') {
    if (cur + 1 >= lines.length) return null;
    cur++;
    rest = lines[cur].slice(lineIndent(lines[cur]).i);
    if (rest === '') return null;
  }
  let dest = '';
  if (rest[0] === '<') {
    let k = 1;
    while (k < rest.length) {
      const c = rest[k];
      if (c === '\\' && k + 1 < rest.length && PUNCT.indexOf(rest[k + 1]) !== -1) { k += 2; continue; }
      if (c === '>' || c === '\n' || c === '<') break;
      k++;
    }
    if (k >= rest.length || rest[k] !== '>') return null;
    dest = unescapeBackslash(rest.slice(1, k));
    rest = rest.slice(k + 1);
  } else {
    let depth = 0;
    let k = 0;
    while (k < rest.length) {
      const c = rest[k];
      if (c === ' ' || c === '\t') break;
      if (c === '\\' && k + 1 < rest.length && PUNCT.indexOf(rest[k + 1]) !== -1) { k += 2; continue; }
      if (c === '(') { depth++; k++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; k++; continue;
      }
      if (c.charCodeAt(0) < 32) return null;
      k++;
    }
    if (k === 0) return null;
    dest = unescapeBackslash(rest.slice(0, k));
    rest = rest.slice(k);
  }
  // a title must be separated from the destination by whitespace
  if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
  // optional title: it may start on this line or the next, and may span
  // lines (its raw text, newlines included, is kept)
  let title = null;
  const r = rest.replace(/^[ \t]+/, '');
  if (r === '') {
    if (cur + 1 < lines.length) {
      const l2 = lines[cur + 1];
      const r2 = l2.slice(lineIndent(l2).i);
      if (r2 !== '' && (r2[0] === '"' || r2[0] === "'" || r2[0] === '(')) {
        const parsed = readTitle(lines, cur + 1, r2);
        if (parsed) { title = parsed.title; cur = parsed.line; }
      }
    }
  } else if (r[0] === '"' || r[0] === "'" || r[0] === '(') {
    const parsed = readTitle(lines, cur, r);
    if (!parsed) return null;
    title = parsed.title;
    cur = parsed.line;
  } else {
    return null;
  }
  return { ref: { href: dest, title }, used: cur - p + 1, label: foldLabel(labelRaw) };
}

// Parse a title starting at the beginning of `first` on lines[start].
// Returns {title, line} where line holds the closing quote, or null.
// The title may span lines; only whitespace may follow the closing
// quote on its line.
function readTitle(lines, start, first) {
  const q = first[0];
  const close = q === '(' ? ')' : q;
  let text = '';
  let line = start;
  let s = first.slice(1);
  for (;;) {
    let k = 0;
    while (k < s.length) {
      const c = s[k];
      if (c === '\\' && k + 1 < s.length && PUNCT.indexOf(s[k + 1]) !== -1) { text += s.slice(k, k + 2); k += 2; continue; }
      if (c === close) {
        if (s.slice(k + 1).trim() !== '') return null;
        return { title: text, line };
      }
      if (q === '(' && c === '(') return null;
      text += c; k++;
    }
    line++;
    if (line >= lines.length) return null;
    // a title may not span a blank line
    if (blankLine(lines[line])) return null;
    text += '\n';
    s = lines[line];
  }
}

// Match an HTML block start on `content` (already stripped of <=3 indent).
// Returns {type, endRe} where endRe tests a line for the block's end, or
// null. type 7 ends at a blank line (endRe null).
function htmlBlockKind(content) {
  if (content[0] !== '<') return null;
  const low = content.toLowerCase();
  let m = /^<(pre|script|style|textarea)([\s>]|$)/.exec(low);
  if (m) return { type: 1, endRe: new RegExp('</' + m[1] + '[\\s>]', 'i') };
  if (low.startsWith('<!--')) return { type: 2, endRe: /-->/ };
  if (low.startsWith('<?')) return { type: 3, endRe: /\?>/ };
  if (/^<![a-z]/i.test(content)) return { type: 4, endRe: />/ };
  if (low.startsWith('<![cdata[')) return { type: 5, endRe: /\]\]>/ };
  m = /^<\/?([a-z][a-z0-9-]*)([\s>\/]|$)/i.exec(content);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return { type: 6, endRe: null };
  // type 7: a complete, well-formed tag alone on the line (a closing
  // tag takes no attributes, and a quoted attribute value may not end
  // on an escaped quote)
  if (content[1] === '/') {
    CLOSE_TAG_RE.lastIndex = 0;
    const cm = CLOSE_TAG_RE.exec(content);
    if (cm && /^[ \t]*$/.test(content.slice(cm[0].length))) return { type: 7, endRe: null };
  } else {
    OPEN_TAG_RE.lastIndex = 0;
    const tm = OPEN_TAG_RE.exec(content);
    if (tm && /^[ \t]*$/.test(content.slice(tm[0].length))) return { type: 7, endRe: null };
  }
  return null;
}

// ---------- the block lexer ----------
//
// lexBlocks(ctx, refs) returns {list, blankDef}: the block tokens for
// the context's lines, plus whether a link reference definition appeared
// after a blank line (that makes an enclosing list loose even though the
// definition renders nothing).

function lexBlocks(ctx, refs) {
  const lines = ctx.lines;
  const srcEndsNL = ctx.endsNL;
  const N = lines.length;
  const tokens = [];
  let blankDef = false;
  let p = 0;
  // A token pushed after a blank line (and not the first token) is
  // flagged: a list item whose top-level tokens contain such a flag
  // directly holds two blocks separated by a blank line, which makes
  // its list loose. Blanks buried inside a nested container do not
  // flag the outer item, because they never reach this level.
  let sawBlank = false;
  const pushTok = (tk) => {
    if (sawBlank && tokens.length) tk.afterBlank = true;
    tokens.push(tk);
    sawBlank = false;
  };
  while (p < N) {
    const line = lines[p];
    if (blankLine(line)) { sawBlank = true; p++; continue; }
    const { col: ind, i: indEnd } = lineIndent(line);
    if (ind >= 4) {
      // indented code block
      const codeLines = [];
      while (p < N) {
        const l = lines[p];
        if (blankLine(l)) {
          let q = p + 1;
          while (q < N && blankLine(lines[q])) q++;
          if (q < N && lineIndent(lines[q]).col >= 4) { codeLines.push(stripCols(l, 4)); p++; continue; }
          break;
        }
        if (lineIndent(l).col >= 4) { codeLines.push(stripCols(l, 4)); p++; continue; }
        break;
      }
      while (codeLines.length && codeLines[codeLines.length - 1] === '') codeLines.pop();
      pushTok({ t: 'code', text: codeLines.join('\n') + '\n' });
      continue;
    }
    const content = line.slice(indEnd);
    // fenced code
    const fence = FENCE_RE.exec(content);
    if (fence) {
      const marker = fence[1];
      const info = fence[2].trim();
      if (marker[0] === '`' && info.indexOf('`') !== -1) {
        // not a fence: falls through to paragraph
      } else {
        const ch = marker[0];
        // marked's indentCodeCompensation is character-based and only
        // applies to backtick fences: each content line loses up to
        // the fence line's own leading-whitespace length, in chars
        // (a tab is one char, not four columns). Tilde fences get no
        // compensation at all.
        const compLen = ch === '`' ? indEnd : 0;
        const inner = [];
        p++;
        while (p < N) {
          const l = lines[p];
          const li = lineIndent(l);
          const lc = l.slice(li.i);
          if (li.col <= 3 && lc[0] === ch) {
            let e = 0;
            while (e < lc.length && lc[e] === ch) e++;
            if (e >= marker.length && /^[ \t]*$/.test(lc.slice(e))) { p++; break; }
          }
          inner.push(compLen ? l.slice(Math.min(leadingWs(l), compLen)) : l);
          p++;
        }
        pushTok({ t: 'fence', lang: unescapeBackslash(info.split(/\s+/)[0]) || null, text: inner.length ? inner.join('\n') + (inner[inner.length - 1] !== '' ? '\n' : '') : '' });
        continue;
      }
    }
    // ATX heading
    const atx = ATX_RE.exec(content);
    if (atx && (atx[2] === undefined || content[atx[1].length] === ' ' || content[atx[1].length] === '\t')) {
      let text = (atx[2] || '').replace(/[ \t]+$/, '');
      if (/^#+$/.test(text)) text = '';
      else text = text.replace(/[ \t]+#+$/, '');
      pushTok({ t: 'heading', level: atx[1].length, text });
      p++;
      continue;
    }
    // horizontal rule
    if (HR_RE.test(content)) { pushTok({ t: 'hr' }); p++; continue; }
    // blockquote
    if (content[0] === '>') {
      const { sub, used } = readQuote(ctx, p);
      // marked rtrims the quote's raw before splitting it, so the
      // sub-content never ends with a newline
      pushTok({ t: 'quote', children: lexBlocks(sub, refs).list });
      p += used;
      continue;
    }
    // list
    const lm = MARKER_RE.exec(content);
    if (lm) {
      const { list, used } = readList(ctx, p, refs);
      if (list) { pushTok(list); p += used; continue; }
    }
    // HTML block (types 1-7 at block level)
    const hb = htmlBlockKind(content);
    if (hb) {
      const htmlLines = [line]; // raw first line: keeps up to 3 leading spaces
      p++;
      if (hb.endRe) {
        if (!hb.endRe.test(content)) {
          while (p < N) {
            const l = lines[p];
            htmlLines.push(l);
            p++;
            if (hb.endRe.test(l)) break;
          }
        }
      } else {
        while (p < N && !blankLine(lines[p])) { htmlLines.push(lines[p]); p++; }
      }
      // An end-tag-terminated block (types 1-5) keeps the newline after
      // its last line whenever the source has exactly one newline after
      // it — that is, when the next line is anything but empty (a
      // whitespace-only line still counts: marked's html regex swallows
      // only the one newline before it). An empty next line means two
      // newlines in a row, which trimTrailingBlankLines removes
      // entirely. A block that runs to EOF keeps it only if the source
      // ends with one. A block ended by a blank line (types 6/7) keeps
      // no trailing newline.
      const trail = hb.endRe
        ? (p === N ? (srcEndsNL ? '\n' : '') : (lines[p] === '' ? '' : '\n'))
        : (p === N && srcEndsNL ? '\n' : '');
      pushTok({ t: 'html', text: htmlLines.join('\n') + trail });
      continue;
    }
    // link reference definition(s) at block start
    const def = readLinkDef(lines, p);
    if (def) {
      // a definition after a blank line is a second block in this
      // container (it makes a list loose even though it renders nothing)
      if (sawBlank && tokens.length) blankDef = true;
      if (!refs.has(def.label)) refs.set(def.label, def.ref);
      p += def.used;
      continue;
    }
    // paragraph (with setext / table / interrupt handling)
    const para = readPara(ctx, p, refs);
    for (const tk of para.tokens) pushTok(tk);
    p = para.next;
  }
  return { list: tokens, blankDef };
}

// Collect a paragraph starting at lines[p]; returns {tokens, next}.
// A paragraph may yield a paragraph token plus a table token when a
// delimiter row turns its last line into a table header.
function readPara(ctx, p, refs) {
  const lines = ctx.lines;
  const N = lines.length;
  const paraLines = [];
  const first = lines[p];
  paraLines.push(first); // raw: a paragraph keeps its leading spaces
  p++;
  while (p < N) {
    const line = lines[p];
    // a line absorbed as a lazy continuation is paragraph text, whatever
    // it looks like (a list marker, a setext `=` line, ...)
    if (ctx.lazy && ctx.lazy.has(p)) { paraLines.push(line); p++; continue; }
    // a whitespace-only line is paragraph text only when it is the last
    // line and the source does not end with a newline (a container's
    // sub-content never ends with one)
    if (line !== '' && /^\s+$/.test(line) && p === N - 1 && (ctx.isSub || !ctx.endsNL)) {
      paraLines.push(line);
      p++;
      break;
    }
    if (blankLine(line)) break;
    const { col, i } = lineIndent(line);
    const content = line.slice(i);
    // setext underline
    if (col <= 3 && SETEXT_RE.test(content)) {
      const level = content[0] === '=' ? 1 : 2;
      // a setext heading strips the leading whitespace of its first line
      // and the trailing whitespace of its last line, and nothing else
      const text = paraLines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      return { tokens: [{ t: 'heading', level, text }], next: p + 1 };
    }
    // table: this line is a delimiter row and the last paragraph line is the header
    if (col <= 3 && content.indexOf('|') !== -1 && DELIM_ROW_RE.test(content)) {
      const aligns = readAligns(content);
      if (aligns) {
        const headerLine = paraLines[paraLines.length - 1];
        const header = splitRow(headerLine);
        if (header.length === aligns.length) {
          paraLines.pop();
          const rows = [];
          p++;
          // a whitespace-only line is a row of empty cells only when it
          // contains a tab; a spaces-only (or empty) line ends the table
          while (p < N && lines[p] !== '' && !/^ +$/.test(lines[p])) {
            // a line that starts a new block ends the table
            const { col: rc, i: ri } = lineIndent(lines[p]);
            const rcontent = lines[p].slice(ri);
            if (rc <= 3) {
              if (rcontent[0] === '>' || ATX_RE.test(rcontent) || isFence(rcontent) || HR_RE.test(rcontent) || MARKER_RE.test(rcontent)) break;
              const rhb = htmlBlockKind(rcontent);
              if (rhb && rhb.type !== 7) break;
            }
            rows.push(splitRow(lines[p]));
            p++;
          }
          const ncols = aligns.length;
          const pad = (cells) => {
            const c = cells.slice(0, ncols);
            while (c.length < ncols) c.push('');
            return c;
          };
          const out = [];
          if (paraLines.length) out.push({ t: 'para', text: paraLines.join('\n') });
          out.push({ t: 'table', header: pad(header), aligns, rows: rows.map(pad) });
          return { tokens: out, next: p };
        }
      }
    }
    // interrupting blocks
    if (col <= 3) {
      if (ATX_RE.exec(content)) break;
      if (isFence(content)) break;
      if (HR_RE.test(content)) break;
      if (content[0] === '>') break;
      const hb2 = htmlBlockKind(content);
      if (hb2 && hb2.type !== 7) break;
      const lm = MARKER_RE.exec(content);
      if (lm) {
        const ordered = /^\d/.test(lm[1]);
        const nonEmpty = lm[2] !== '';
        if (!ordered && nonEmpty) break;
        // inside a list item any ordered marker interrupts a paragraph;
        // elsewhere only one starting with 1 does
        if (ordered && nonEmpty && (ctx.inItem || parseInt(lm[1], 10) === 1)) break;
      }
    }
    paraLines.push(line);
    p++;
  }
  return { tokens: [{ t: 'para', text: paraLines.join('\n') }], next: p };
}

// Does a line start a block that interrupts a paragraph (used for lazy
// continuation decisions in quotes and list items)?
function breaksPara(content) {
  if (ATX_RE.test(content)) return true;
  if (isFence(content)) return true;
  if (HR_RE.test(content)) return true;
  if (content[0] === '>') return true;
  if (SETEXT_RE.test(content)) return true;
  const hb = htmlBlockKind(content);
  if (hb && hb.type !== 7) return true;
  const lm = MARKER_RE.exec(content);
  if (lm) return true;
  return false;
}

// A stripped quote line is paragraph text (so a following marker-less line
// may lazily continue it) when it is non-blank and starts no block.
function lazyText(content) {
  if (content.trim() === '') return false;
  return !breaksPara(content);
}

// What the last non-blank line of a container's collected lines ends in:
// 'para' when it ends in open paragraph text, 'list' when it ends in a
// list item whose content ends in paragraph text, null otherwise
// (indented code, a fence, a heading, an empty item, ...). Quote markers
// and list markers are stripped recursively to reach the innermost text.
function tailKind(line) {
  let s = line;
  let sawList = false;
  for (;;) {
    const { col, i } = lineIndent(s);
    if (col > 3) return null;
    const c = s.slice(i);
    if (c[0] === '>') { s = stripQuote(s); continue; }
    const lm = MARKER_RE.exec(c);
    if (lm) {
      let j = lm[1].length;
      let col2 = col + lm[1].length;
      let wsc = 0;
      while (j < c.length && (c[j] === ' ' || c[j] === '\t')) {
        if (c[j] === ' ') { wsc++; col2++; j++; }
        else { const nx = col2 + 4 - (col2 % 4); wsc += nx - col2; col2 = nx; j++; }
        if (wsc >= 5) break;
      }
      if (j >= c.length) return null;
      sawList = true;
      s = wsc >= 5 ? expandStrip(c.slice(lm[1].length), 1, col + lm[1].length) : c.slice(j);
      continue;
    }
    if (!lazyText(c)) return null;
    return sawList ? 'list' : 'para';
  }
}

// Remove `n` columns from the front of `s` (which starts at true column
// `startCol`), then expand the remaining leading whitespace to spaces
// using true tab-stop columns. This is how a container (blockquote or
// list item) strips its prefix: a tab that straddles the strip point, and
// every tab after it, becomes the exact number of spaces its true columns
// span — so `>\t\tfoo` yields content indented 6, not 4.
function expandStrip(s, n, startCol) {
  let col = startCol, i = 0;
  const target = startCol + n;
  while (i < s.length && col < target) {
    const ch = s[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const nx = col + 4 - (col % 4);
      if (nx <= target) { col = nx; i++; }
      else {
        let out = ' '.repeat(nx - target);
        let c2 = nx;
        let j = i + 1;
        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) {
          if (s[j] === ' ') { out += ' '; c2++; j++; }
          else { const w = 4 - (c2 % 4); out += ' '.repeat(w); c2 += w; j++; }
        }
        return out + s.slice(j);
      }
    } else break;
  }
  let out = '';
  let j = i;
  let c2 = col;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) {
    if (s[j] === ' ') { out += ' '; c2++; j++; }
    else { const w = 4 - (c2 % 4); out += ' '.repeat(w); c2 += w; j++; }
  }
  return out + s.slice(j);
}

function stripQuote(line) {
  const { col, i } = lineIndent(line);
  return expandStrip(line.slice(i + 1), 1, col + 1);
}

// Push a line into a container's sub-content, carrying over a lazy-text
// flag from the source line (or an explicit one) so the inner lexer
// treats it as paragraph text.
function pushInner(sub, text, ctx, srcIdx, lazyFlag) {
  sub.lines.push(text);
  if (lazyFlag || (ctx.lazy && ctx.lazy.has(srcIdx))) {
    if (!sub.lazy) sub.lazy = new Set();
    sub.lazy.add(sub.lines.length - 1);
  }
}

// Tracks whether a fenced code block is open across a container's
// lines (mirroring the inner lexer's fence rules), so a marker-less
// line inside a fence ends the container instead of being absorbed
// as lazy paragraph text.
function fenceTrack() {
  let fence = null;
  return {
    get open() { return fence !== null; },
    update(line) {
      const { col, i } = lineIndent(line);
      if (col > 3) return;
      const content = line.slice(i);
      if (fence) {
        if (content[0] === fence.ch) {
          let e = 0;
          while (e < content.length && content[e] === fence.ch) e++;
          if (e >= fence.run && /^[ \t]*$/.test(content.slice(e))) fence = null;
        }
      } else {
        const m = FENCE_RE.exec(content);
        if (m) {
          const marker = m[1];
          const info = m[2].trim();
          if (!(marker[0] === '`' && info.indexOf('`') !== -1)) fence = { ch: marker[0], run: marker.length };
        }
      }
    },
  };
}

function readQuote(ctx, p) {
  const lines = ctx.lines;
  const N = lines.length;
  const sub = { lines: [], endsNL: false, isSub: true, inItem: false, lazy: null };
  const ft = fenceTrack();
  const push = (text, srcIdx, lazyFlag) => { pushInner(sub, text, ctx, srcIdx, lazyFlag); ft.update(text); };
  let prevLazy = false;
  let used = 0;
  while (p + used < N) {
    const line = lines[p + used];
    const srcIdx = p + used;
    // a blank line ends the quote: a following quote starts a new one
    if (blankLine(line)) break;
    const { col, i } = lineIndent(line);
    if (col <= 3 && line.slice(i)[0] === '>') {
      push(stripQuote(line), srcIdx);
      used++;
      prevLazy = false;
      continue;
    }
    // a blank quote line ends the paragraph: only the immediately
    // preceding line counts as the lazy tail
    const tail = sub.lines.length ? sub.lines[sub.lines.length - 1] : null;
    const kind = tail === null ? null : tailKind(tail);
    // a marker-less line inside an open fence ends the quote: the
    // fence is left unclosed and the line belongs outside
    if (ft.open) break;
    if (kind) {
      const content = line.slice(i);
      // a setext `=` line is absorbed as paragraph text
      if (SETEXT_RE.test(content) && content[0] === '=') {
        if (col <= 3) {
          if (kind === 'para' && prevLazy) push('    ' + line, srcIdx);
          else push(line, srcIdx, true);
        } else if (kind === 'para') {
          push(stripCols(line, 4), srcIdx, true);
        } else {
          push(line, srcIdx, true);
        }
        used++;
        prevLazy = true;
        continue;
      }
      const lm = MARKER_RE.exec(content);
      if (lm && !HR_RE.test(content)) {
        // a list marker line is lazy only when it cannot start a new
        // item (indent over 3); after a paragraph it is paragraph text
        // (4 columns stripped), after a list it is kept as-is so the
        // inner lexer can make it a nested list
        if (col > 3) {
          if (kind === 'para') push(stripCols(line, 4), srcIdx, true);
          else push(line, srcIdx);
          used++;
          prevLazy = true;
          continue;
        }
        break;
      }
      if (!lazyText(content)) break;
      // plain paragraph text: after a paragraph, 4 columns are stripped
      // from an indented line; after a list, the line is kept as-is
      if (kind === 'para' && col >= 4) push(stripCols(line, 4), srcIdx);
      else push(line, srcIdx);
      used++;
      prevLazy = true;
      continue;
    }
    break;
  }
  return { sub, used };
}

// Parse one list item's lines. `contentIndent` is the column where the
// item's content starts. Returns {itemCtx, next, blankInside} where
// next is the index after the item's lines.
function readItem(ctx, p, contentIndent, firstContent, baseIndent) {
  const lines = ctx.lines;
  const N = lines.length;
  const itemCtx = { lines: [], endsNL: false, isSub: true, inItem: false, lazy: null };
  let blankInside = false;
  let i = p;
  const lastLine = () => {
    if (itemCtx.lines.length) return itemCtx.lines[itemCtx.lines.length - 1];
    return firstContent;
  };
  const hasContent = () => {
    if (firstContent.trim() !== '') return true;
    for (const l of itemCtx.lines) if (l.trim() !== '') return true;
    return false;
  };
  while (i < N) {
    const line = lines[i];
    const srcIdx = i;
    if (blankLine(line)) {
      // look ahead to the next non-blank line
      let q = i + 1;
      while (q < N && blankLine(lines[q])) q++;
      if (q >= N) { i = q; break; }
      // a blank line ends an item that has no content yet
      if (!hasContent()) break;
      const qi = lineIndent(lines[q]);
      if (qi.col >= contentIndent) {
        // blank line(s) inside the item
        blankInside = true;
        while (i < q) { itemCtx.lines.push(''); i++; }
        continue;
      }
      // blank line ends the item (a following item marker starts a new
      // item of the same list; anything else ends the list)
      break;
    }
    const { col, i: indEnd } = lineIndent(line);
    if (col >= contentIndent) {
      pushInner(itemCtx, expandStrip(line, contentIndent, 0), ctx, srcIdx);
      i++;
      continue;
    }
    // lazy continuation: only while the item's content ends in an open
    // paragraph
    const kind = tailKind(lastLine());
    if (kind) {
      const content = line.slice(indEnd);
      if (SETEXT_RE.test(content) && content[0] === '=') {
        if (col <= 3) pushInner(itemCtx, line, ctx, srcIdx, true);
        else if (kind === 'para') pushInner(itemCtx, stripCols(line, 4), ctx, srcIdx, true);
        else pushInner(itemCtx, line, ctx, srcIdx, true);
        i++;
        continue;
      }
      const lm = MARKER_RE.exec(content);
      if (lm && !HR_RE.test(content)) {
        // a list marker line is lazy only when it cannot start a new
        // item of this list (indent over base + 3)
        if (col > baseIndent + 3) {
          if (kind === 'para') pushInner(itemCtx, stripCols(line, 4), ctx, srcIdx, true);
          else pushInner(itemCtx, line, ctx, srcIdx);
          i++;
          continue;
        }
        break;
      }
      if (!lazyText(content)) break;
      if (kind === 'para' && col >= 4) pushInner(itemCtx, stripCols(line, 4), ctx, srcIdx);
      else pushInner(itemCtx, line, ctx, srcIdx);
      i++;
      continue;
    }
    break;
  }
  return { itemCtx, next: i, blankInside };
}

function readList(ctx, p, refs) {
  const lines = ctx.lines;
  const N = lines.length;
  const first = lines[p];
  const fi = lineIndent(first);
  const baseIndent = fi.col;
  const content0 = first.slice(fi.i);
  const lm0 = MARKER_RE.exec(content0);
  if (!lm0) return { list: null, used: 0 };
  const marker0 = lm0[1];
  const ordered = /^\d/.test(marker0);
  const delim = ordered ? marker0.slice(-1) : null;
  const bullet = ordered ? null : marker0;
  const startNum = ordered ? parseInt(marker0, 10) : null;
  const items = [];
  let loose = false;
  let i = p;
  let guard = 0;
  while (i < N && guard++ < 10000) {
    const line = lines[i];
    if (blankLine(line)) { i++; continue; }
    const li = lineIndent(line);
    if (li.col > 3) break;
    const lc = line.slice(li.i);
    // a thematic-break line is not a list item: it ends the list
    if (HR_RE.test(lc)) break;
    const m = MARKER_RE.exec(lc);
    if (!m) break;
    const mk = m[1];
    if (ordered) {
      if (!/^\d/.test(mk) || mk.slice(-1) !== delim) break;
    } else {
      if (mk !== bullet) break;
    }
    // content indent for this item
    const markerCol = li.col;
    const markerEndCol = markerCol + mk.length;
    let j = li.i + mk.length;
    let col = markerEndCol;
    let wsCols = 0;
    let wsEnd = j;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
      if (line[j] === ' ') { wsCols++; col++; j++; }
      else { const nx = col + 4 - (col % 4); wsCols += nx - col; col = nx; j++; }
      wsEnd = j;
      if (wsCols >= 5) break;
    }
    const hasContent = wsEnd < line.length && line.slice(wsEnd).trim() !== '';
    let contentIndent;
    let firstContent;
    if (!hasContent) {
      contentIndent = markerEndCol + 1;
      firstContent = '';
    } else if (wsCols >= 5) {
      contentIndent = markerEndCol + 1;
      // only one column of the run is the marker separator; the rest of
      // the whitespace is content, materialized to true columns
      firstContent = expandStrip(line.slice(li.i + mk.length), 1, markerEndCol);
    } else {
      contentIndent = col;
      firstContent = line.slice(wsEnd);
    }
    const res = readItem(ctx, i + 1, contentIndent, firstContent, baseIndent);
    const itemLines = [firstContent, ...res.itemCtx.lines];
    // lazy-text flags live on the item's own lines; shift them by one
    // for the prepended first line
    const itemCtx = { lines: itemLines, endsNL: false, isSub: true, inItem: true, lazy: null };
    if (res.itemCtx.lazy) {
      itemCtx.lazy = new Set();
      for (const idx of res.itemCtx.lazy) itemCtx.lazy.add(idx + 1);
    }
    // drop trailing blank lines of the item
    while (itemCtx.lines.length && itemCtx.lines[itemCtx.lines.length - 1] === '') itemCtx.lines.pop();
    // task list checkbox?
    let task = null;
    if (itemCtx.lines.length) {
      const tm = /^\[([ xX])\]([ \t]+)(.*)$/.exec(itemCtx.lines[0]);
      if (tm && tm[3].trim() !== '') {
        task = tm[1] !== ' ';
        itemCtx.lines[0] = tm[3];
      }
    }
    const lexed = lexBlocks(itemCtx, refs);
    items.push({ tokens: lexed.list, task });
    // a list is loose when an item directly holds two blocks separated
    // by a blank line (a blank buried in a nested container does not
    // count — it flags only the nested list's own items); a reference
    // definition after a blank line counts as a second block too
    if (items[items.length - 1].tokens.some((t) => t.afterBlank) || lexed.blankDef) loose = true;
    i = res.next;
    // a blank line between this item and the next makes the list loose
    let q = i;
    let sawBlank = false;
    while (q < N && blankLine(lines[q])) { sawBlank = true; q++; }
    if (sawBlank && q < N) {
      const qi = lineIndent(lines[q]);
      if (qi.col <= 3) {
        const qc = lines[q].slice(qi.i);
        const qm = MARKER_RE.exec(qc);
        if (qm) {
          const qmk = qm[1];
          const same = ordered ? (/^\d/.test(qmk) && qmk.slice(-1) === delim) : (qmk === bullet);
          if (same) loose = true;
        }
      }
    }
    if (i >= N) break;
    // if the next non-blank line is not a marker of this list, stop
    let r = i;
    while (r < N && blankLine(lines[r])) r++;
    if (r >= N) { i = r; break; }
    const ri = lineIndent(lines[r]);
    if (ri.col > 3) break;
    const rc = lines[r].slice(ri.i);
    const rm = MARKER_RE.exec(rc);
    if (!rm) break;
    const rmk = rm[1];
    if (ordered) {
      if (!/^\d/.test(rmk) || rmk.slice(-1) !== delim) break;
    } else if (rmk !== bullet) break;
    i = r;
  }
  if (!items.length) return { list: null, used: 0 };
  return { list: { t: 'list', ordered, start: startNum, loose, items }, used: i - p };
}

// ---------- rendering ----------
//
// renderBlocks(tokens, refs, rctx) where rctx is {tight, task, doc}.
// `doc` is the shared document inline state ({inLink, inRawBlock});
// inRawBlock is reset before every top-level inline run (paragraph,
// heading, table cell), while inLink persists across the whole document.

function renderBlocks(tokens, refs, rctx) {
  const out = [];
  const doc = rctx.doc;
  const inline = (text) => {
    doc.inRawBlock = false;
    return renderInline(parseInline(text, refs, doc));
  };
  for (const tk of tokens) {
    if (tk.t === 'code') out.push('<pre><code>' + escapeAll(tk.text) + '</code></pre>\n');
    else if (tk.t === 'fence') {
      out.push('<pre><code' + (tk.lang ? ' class="language-' + escapeText(tk.lang) + '"' : '') + '>' + escapeAll(tk.text) + '</code></pre>\n');
    } else if (tk.t === 'heading') {
      out.push('<h' + tk.level + '>' + inline(tk.text) + '</h' + tk.level + '>\n');
    } else if (tk.t === 'hr') out.push('<hr>\n');
    else if (tk.t === 'para') {
      const inner = inline(tk.text);
      if (rctx.task) {
        const taskHtml = rctx.task;
        rctx.task = null;
        out.push('<p>' + taskHtml + inner + '</p>\n');
      } else if (rctx.tight) out.push(inner);
      else out.push('<p>' + inner + '</p>\n');
    } else if (tk.t === 'quote') {
      out.push('<blockquote>\n' + renderBlocks(tk.children, refs, { tight: false, doc }) + '</blockquote>\n');
    } else if (tk.t === 'list') {
      const tag = tk.ordered ? 'ol' : 'ul';
      let head = '<' + tag + (tk.ordered && tk.start !== 1 ? ' start="' + tk.start + '"' : '') + '>\n';
      for (const item of tk.items) {
        head += '<li>';
        const taskHtml = (item.task !== null && item.task !== undefined)
          ? (item.task ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ')
          : null;
        const itemCtx = { tight: !tk.loose, doc };
        // in a loose list the checkbox belongs inside the first paragraph
        if (taskHtml && tk.loose && item.tokens.length && item.tokens[0].t === 'para') {
          itemCtx.task = taskHtml;
        } else if (taskHtml) {
          head += taskHtml;
        }
        head += renderBlocks(item.tokens, refs, itemCtx);
        head += '</li>\n';
      }
      head += '</' + tag + '>\n';
      out.push(head);
    } else if (tk.t === 'html') out.push(tk.text);
    else if (tk.t === 'table') {
      let s = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < tk.header.length; c++) {
        const al = tk.aligns[c];
        s += '<th' + (al ? ' align="' + al + '"' : '') + '>' + inline(tk.header[c]) + '</th>\n';
      }
      s += '</tr>\n</thead>\n';
      if (tk.rows.length) {
        s += '<tbody>';
        for (const row of tk.rows) {
          s += '<tr>\n';
          for (let c = 0; c < row.length; c++) {
            const al = tk.aligns[c];
            s += '<td' + (al ? ' align="' + al + '"' : '') + '>' + inline(row[c]) + '</td>\n';
          }
          s += '</tr>\n';
        }
        s += '</tbody>';
      }
      s += '</table>\n';
      out.push(s);
    }
  }
  return out.join('');
}

// ---------- entry point ----------
//
// No state is kept between calls: each parse() renders its input alone,
// exactly as if no earlier call had happened.

export const parse = (markdown) => {
  const raw = String(markdown);
  // Empty input renders to empty output; skip the lexer entirely.
  if (raw === '') return '';
  const src = raw.indexOf('\r') === -1 ? raw : raw.replace(/\r\n?/g, '\n');
  const refs = new Map();
  const doc = { inLink: false, inRawBlock: false };
  const lines = src === '' ? [] : src.split('\n');
  if (src.endsWith('\n')) lines.pop();
  const ctx = { lines, endsNL: src.endsWith('\n'), isSub: false, inItem: false, lazy: null };
  const tokens = lexBlocks(ctx, refs).list;
  return renderBlocks(tokens, refs, { tight: false, doc });
};
