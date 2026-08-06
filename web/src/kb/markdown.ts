/**
 * Markdown rendering helper for wiki page content (G2.S4.T3).
 * Wraps markdown-it; styling lives in the consumer's scoped CSS.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

/** Render a markdown source string to HTML. */
export function renderMarkdown(source: string): string {
  return md.render(source);
}
