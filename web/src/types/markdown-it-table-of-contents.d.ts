declare module "markdown-it-table-of-contents" {
  import type MarkdownIt from "markdown-it";

  interface TableOfContentsOptions {
    includeLevel?: number[];
    containerClass?: string;
    markerPattern?: RegExp;
    listType?: "ul" | "ol";
    containerHeaderHtml?: string;
    containerFooterHtml?: string;
    slugify?: (text: string, rawToken?: unknown) => string;
    format?: (content: string, md: MarkdownIt) => string;
    transformLink?: (anchor: string) => string;
    transformContainerOpen?: (containerClass: string, containerHeaderHtml?: string) => string;
    transformContainerClose?: (containerFooterHtml?: string) => string;
    getTokensText?: (tokens: unknown[], rawToken?: unknown) => string;
  }

  const markdownItTableOfContents: MarkdownIt.PluginWithOptions<TableOfContentsOptions>;
  export default markdownItTableOfContents;
}
