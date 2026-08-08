/**
 * Markdown rendering helper for wiki page content (G2.S4.T3).
 *
 * Renders GitHub-style markdown with task lists, heading anchors, syntax
 * highlighting (highlight.js) and linkify. Styling lives in the consumer's
 * scoped CSS (see `.wiki-content` in WikiView.vue).
 */
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";

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

/** Render a markdown source string to HTML. */
export function renderMarkdown(source: string): string {
  return md.render(source);
}
