/**
 * Lightweight per-language syntax highlighting for the Code tab (G3.S4.T2).
 *
 * Each language defines comment/string/keyword rules; a single combined regex
 * tokenizes the source into spans. All source text is HTML-escaped before it
 * is emitted, so the output is safe to render with v-html.
 */

const TOKEN_CLASSES = [
  "comment",
  "string",
  "keyword",
  "type",
  "number",
  "constant",
  "tag",
] as const;

type TokenClass = (typeof TOKEN_CLASSES)[number];

interface LanguageDef {
  id: string;
  keywords: string[];
  types?: string[];
  constants?: string[];
  /** Regex source for a single line comment (without the flags). */
  lineComment?: string;
  /** Regex source for a block comment's open/close. */
  blockComment?: [string, string];
  /** Regex source matching string literals. */
  string: string;
  /** Regex source matching tag markup (html/xml-ish). */
  tag?: string;
}

const SHARED_NUMBER = String.raw`\b(?:0x[0-9a-fA-F_]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`;

const TS_JS_KEYWORDS =
  "break case catch class const continue debugger default delete do else enum export extends finally for function if import in instanceof new return super switch this throw try typeof var void while with yield await async let static get set of as from interface type declare namespace module abstract implements private protected public readonly";

function tsTypes(): string[] {
  return ["string", "number", "boolean", "any", "unknown", "never", "object", "symbol", "bigint", "undefined"];
}

function goTypes(): string[] {
  return [
    "string", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64",
    "uintptr", "bool", "byte", "rune", "error", "any", "float32", "float64",
  ];
}

function rustTypes(): string[] {
  return [
    "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
    "f32", "f64", "bool", "char", "str", "String", "Vec", "Option", "Result", "Box",
  ];
}

const LANGUAGE_DEFS: Record<string, LanguageDef> = {
  typescript: {
    id: "typescript",
    keywords: TS_JS_KEYWORDS.split(" "),
    types: tsTypes(),
    lineComment: "//[^\\n]*",
    blockComment: ["/\\*", "\\*/"],
    string: String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + "`(?:[^`\\\\]|\\\\.)*`",
  },
  javascript: {
    id: "javascript",
    keywords: TS_JS_KEYWORDS.split(" "),
    lineComment: "//[^\\n]*",
    blockComment: ["/\\*", "\\*/"],
    string: String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + "`(?:[^`\\\\]|\\\\.)*`",
  },
  python: {
    id: "python",
    keywords:
      "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "),
    constants: ["None", "True", "False"],
    types: ["self", "cls", "int", "float", "str", "bool", "list", "dict", "set", "tuple"],
    lineComment: "#[^\\n]*",
    string:
      String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|` + String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`,
  },
  go: {
    id: "go",
    keywords:
      "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var".split(" "),
    types: goTypes(),
    constants: ["true", "false", "nil", "iota"],
    lineComment: "//[^\\n]*",
    blockComment: ["/\\*", "\\*/"],
    string: String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + "`[^`]*`",
  },
  rust: {
    id: "rust",
    keywords:
      "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split(" "),
    types: rustTypes(),
    constants: ["None", "Some", "Ok", "Err"],
    lineComment: "//[^\\n]*",
    blockComment: ["/\\*", "\\*/"],
    string: String.raw`"(?:[^"\\\n]|\\.)*"|` + "`[^`]*`",
  },
  java: {
    id: "java",
    keywords:
      "public private protected class interface enum extends implements static final void int long double float boolean char byte short new return if else for while do switch case break continue try catch finally throw throws import package synchronized abstract volatile transient native this instanceof super null true false record var".split(" "),
    types: ["String", "Integer", "Long", "Double", "Boolean", "Object", "List", "Map", "Set"],
    lineComment: "//[^\\n]*",
    blockComment: ["/\\*", "\\*/"],
    string: String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`,
  },
  json: {
    id: "json",
    keywords: ["true", "false", "null"],
    string: String.raw`"(?:[^"\\]|\\.)*"`,
  },
  yaml: {
    id: "yaml",
    keywords: ["true", "false", "null", "yes", "no", "on", "off"],
    lineComment: "#[^\\n]*",
    string: String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`,
  },
  html: {
    id: "html",
    keywords: [],
    lineComment: "",
    blockComment: ["<!--", "-->"],
    string: String.raw`"[^"]*"|'[^']*'`,
    tag: String.raw`<\/?[a-zA-Z][a-zA-Z0-9-]*|/?>`,
  },
  css: {
    id: "css",
    keywords: [],
    constants: ["#[0-9a-fA-F]{3,8}\\b"],
    lineComment: "",
    blockComment: ["/\\*", "\\*/"],
    string: String.raw`"[^"]*"|'[^']*'`,
  },
  markdown: {
    id: "markdown",
    keywords: [],
    lineComment: "",
    string: "[`][^`\\n]*[`]|\\[[^\\]]*\\]\\([^)]*\\)",
  },
  bash: {
    id: "bash",
    keywords:
      "if then else elif fi for while do done case esac function in echo cd ls mkdir rm cp mv export source set shift return exit export local".split(" "),
    lineComment: "#[^\\n]*",
    string: String.raw`"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|` + "`[^`]*`",
  },
  sql: {
    id: "sql",
    keywords:
      "select from where insert into values update set delete create table drop alter join left right inner outer on as and or not null is in like between group by order having limit distinct union all exists case when then else end primary key foreign references index view procedure function begin commit rollback".split(" "),
    lineComment: "--[^\\n]*",
    blockComment: ["/\\*", "\\*/"],
    string: String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`,
  },
  cpp: {
    id: "cpp",
    keywords:
      "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override new delete this friend operator using".split(" "),
    types: ["std", "string", "vector", "map", "shared_ptr", "unique_ptr", "size_t", "bool", "int8_t", "int32_t", "int64_t", "uint32_t", "uint64_t"],
    constants: ["NULL", "nullptr", "true", "false"],
    lineComment: "//[^\\n]*",
    blockComment: ["/\\*", "\\*/"],
    string: String.raw`"(?:[^"\\\n]|\\.)*"|'[^'\n]*'`,
  },
  csharp: {
    id: "csharp",
    keywords:
      "using namespace class interface enum struct public private protected internal static readonly const override virtual abstract sealed partial async await void int string bool double decimal float var new return if else for foreach while do switch case break continue try catch finally throw".split(" "),
    types: ["var", "Task", "List", "Dictionary", "Action", "Func", "object"],
    lineComment: "//[^\\n]*",
    blockComment: ["/\\*", "\\*/"],
    string: String.raw`"(?:[^"\\\n]|\\.)*"|'[^'\n]*'`,
  },
  php: {
    id: "php",
    keywords:
      "function class public private protected static echo print return if else elseif for foreach while do switch case break continue try catch throw new namespace use require include extends implements interface const var global this".split(" "),
    constants: ["true", "false", "null", "TRUE", "FALSE", "NULL"],
    lineComment: "//[^\\n]*",
    blockComment: ["/\\*", "\\*/"],
    string: String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`,
  },
  ruby: {
    id: "ruby",
    keywords:
      "def end class module if elsif else unless case when while until for do begin ensure rescue return yield require attr_accessor attr_reader attr_writer".split(" "),
    constants: ["nil", "true", "false", "self", "super", "new"],
    lineComment: "#[^\\n]*",
    string: String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`,
  },
  dockerfile: {
    id: "dockerfile",
    keywords:
      "FROM RUN CMD ENTRYPOINT COPY ADD EXPOSE ENV ARG WORKDIR USER LABEL VOLUME ONBUILD STOPSIGNAL HEALTHCHECK SHELL MAINTAINER".split(" "),
    lineComment: "#[^\\n]*",
    string: String.raw`"[^"]*"|'[^']*'`,
  },
  plaintext: {
    id: "plaintext",
    keywords: [],
    string: "",
  },
};

function buildRegex(def: LanguageDef): RegExp {
  const alternations: string[] = [];
  const groups: Record<TokenClass, string> = {
    comment: "",
    string: def.string,
    keyword: def.keywords.length ? `\\b(?:${def.keywords.join("|")})\\b` : "",
    type: def.types?.length ? `\\b(?:${def.types.join("|")})\\b` : "",
    number: SHARED_NUMBER,
    constant: def.constants?.length ? `(?:${def.constants.join("|")})` : "",
    tag: def.tag ?? "",
  };

  if (def.lineComment || def.blockComment) {
    if (def.lineComment && def.blockComment) {
      groups.comment = `(?:${def.lineComment}|${def.blockComment[0]}[\\s\\S]*?${def.blockComment[1]})`;
    } else if (def.lineComment) {
      groups.comment = def.lineComment;
    } else {
      groups.comment = `${def.blockComment![0]}[\\s\\S]*?${def.blockComment![1]}`;
    }
  }

  for (const name of TOKEN_CLASSES) {
    if (groups[name]) {
      alternations.push(`(?<${name}>${groups[name]})`);
    }
  }
  return new RegExp(alternations.join("|"), "gm");
}

const COMPILED = new Map<string, RegExp>();

function regexFor(id: string): RegExp {
  let regex = COMPILED.get(id);
  if (!regex) {
    regex = buildRegex(LANGUAGE_DEFS[id] ?? LANGUAGE_DEFS.plaintext!);
    COMPILED.set(id, regex);
  }
  return regex;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface HighlightSegment {
  cls: TokenClass | "plain";
  text: string;
}

/**
 * Tokenize `source` into contiguous segments covering the whole input. Each
 * segment carries a token class (or "plain"); multi-line tokens stay a single
 * segment so line rendering can color each line consistently.
 */
export function tokenize(source: string, language: string): HighlightSegment[] {
  const regex = regexFor(language);
  regex.lastIndex = 0;
  const segments: HighlightSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    if (match.index > last) {
      segments.push({ cls: "plain", text: source.slice(last, match.index) });
    }
    const token = match[0];
    const groups = match.groups;
    const cls = TOKEN_CLASSES.find((c) => groups?.[c] !== undefined) ?? "plain";
    segments.push({ cls, text: token });
    last = match.index + token.length;
    if (token.length === 0) {
      regex.lastIndex += 1;
    }
  }
  if (last < source.length) {
    segments.push({ cls: "plain", text: source.slice(last) });
  }
  return segments;
}

function segmentHtml(segment: HighlightSegment): string {
  const html = escapeHtml(segment.text);
  return segment.cls === "plain" ? html : `<span class="tok-${segment.cls}">${html}</span>`;
}

/**
 * Highlight `source` in the given language, returning escaped HTML with token
 * spans. All source text is escaped first, so the output is safe for v-html.
 */
export function highlightCode(source: string, language: string): string {
  return tokenize(source, language).map(segmentHtml).join("");
}

/**
 * Highlight `source` per line, returning one escaped HTML string per source
 * line (including a trailing empty line for a final newline). Multi-line
 * tokens are colored on every line they span.
 */
export function renderCodeLines(source: string, language: string): string[] {
  const lines: string[] = [];
  let current: string[] = [];
  for (const segment of tokenize(source, language)) {
    const pieces = segment.text.split("\n");
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) {
        lines.push(current.join(""));
        current = [];
      }
      if (pieces[i]) {
        current.push(segmentHtml({ cls: segment.cls, text: pieces[i] }));
      }
    }
  }
  lines.push(current.join(""));
  return lines;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  vue: "html",
  py: "python",
  go: "go",
  mod: "go",
  sum: "go",
  rs: "rust",
  java: "java",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  css: "css",
  scss: "css",
  less: "css",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  dockerfile: "dockerfile",
};

/** Map a file name to a language id (by extension; falls back to plaintext). */
export function detectLanguage(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower === "dockerfile" || /^dockerfile\./.test(lower)) {
    return "dockerfile";
  }
  const match = /\.([a-z0-9]+)$/.exec(lower);
  return EXT_TO_LANG[match?.[1] ?? ""] ?? "plaintext";
}
