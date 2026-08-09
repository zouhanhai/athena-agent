/**
 * Markdown rendering helper for wiki page content (G2.S4.T3).
 *
 * Renders GitHub-style markdown with task lists, heading anchors, syntax
 * highlighting (highlight.js), linkify and (G3.S5.T5):
 *  - a nested table of contents (`[[toc]]` marker) for long documents;
 *  - stable slugified heading ids so TOC/permalink links jump to a section;
 *  - relative `<img src="images/...">` refs rewritten to the served
 *    `/api/kb/wiki/image?path=` URL so source images render in WikiView.
 *
 * Styling lives in the consumer's scoped CSS (see `.wiki-content` in
 * WikiView.vue).
 */
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";
import markdownItAnchor from "markdown-it-anchor";
import markdownItTableOfContents from "markdown-it-table-of-contents";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code class="language-${lang}">${
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
        }</code></pre>`;
      } catch {
        /* fall through to escaped output */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

/** Enable GitHub task lists ( `- [ ]` / `- [x]` ) with disabled checkboxes. */
md.use(taskLists, {
  enabled: true,
  label: true,
  labelAfter: true,
});

/** G3.S5.T5: stable slugified heading ids (duplicates get -2/-3) so anchors
 *  like `#section-2` resolve and TOC/permalink links can jump to a section. */
md.use(markdownItAnchor, {
  level: [1, 2, 3],
  tabIndex: -1,
  permalink: markdownItAnchor.permalink.ariaHidden({
    class: "wiki-heading-anchor",
    symbol: "#",
    placement: "after",
  }),
});

/** G3.S5.T5: nested table of contents rendered where the `[[toc]]` marker sits. */
md.use(markdownItTableOfContents, {
  includeLevel: [1, 2, 3],
  containerClass: "wiki-toc",
  listType: "ul",
});

/**
 * Rewrite a markdown image ref to the wiki-image serving URL (G3.S5.T5).
 * Only relative refs under `images/` are rewritten; the resolved path is
 * relative to the wiki root so the backend guard accepts it. Anything else is
 * returned unchanged.
 */
export function resolveWikiImageSrc(src: string, pagePath?: string): string {
  if (!pagePath || !/^images\//.test(src)) return src;
  const dir = pagePath.includes("/")
    ? pagePath.slice(0, pagePath.lastIndexOf("/"))
    : "";
  const wikiPath = `${dir}/${src}`;
  return `/api/kb/wiki/image?path=${encodeURIComponent(wikiPath)}`;
}

const defaultImageRender = md.renderer.rules.image!;

/** Rewrite relative wiki image refs to the served URL during render. */
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = String(tokens[idx].attrGet("src") ?? "");
  const pagePath = (env as { pagePath?: string } | undefined)?.pagePath;
  const resolved = resolveWikiImageSrc(src, pagePath);
  if (resolved !== src) tokens[idx].attrSet("src", resolved);
  return defaultImageRender(tokens, idx, options, env, self);
};

/** True when the source contains a `#`/`##`/`###` heading worth a TOC. */
export function hasWikiHeadings(source: string): boolean {
  return /^#{1,3}\s+/m.test(source);
}

export interface RenderMarkdownOptions {
  /** Project-relative path of the page being rendered (e.g. "wiki/concepts/foo.md").
   *  When set, relative `<img src="images/...">` refs are rewritten to the
   *  served wiki-image URL (G3.S5.T5). */
  pagePath?: string;
  /** Render a nested table of contents at the top of the page (G3.S5.T5). */
  toc?: boolean;
}

/** Render a markdown source string to HTML. */
export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): string {
  const body = options.toc ? `\n\n[[toc]]\n\n${source}` : source;
  return md.render(body, { pagePath: options.pagePath });
}
