import { describe, expect, it } from "vitest";
import {
  extractWikiHeadings,
  hasWikiHeadings,
  renderMarkdown,
  resolveWikiImageSrc,
} from "@/kb/markdown";

describe("renderMarkdown heading anchors + TOC (G3.S5.T5)", () => {
  it("gives headings stable slugified ids", () => {
    const html = renderMarkdown("# Section 2\n\n## Sub A\n\n### Sub B");
    expect(html).toContain('<h1 id="section-2"');
    expect(html).toContain('<h2 id="sub-a"');
    expect(html).toContain('<h3 id="sub-b"');
  });

  it("makes duplicate heading slugs unique", () => {
    const html = renderMarkdown("# Intro\n\n# Intro");
    expect(html).toContain('<h1 id="intro"');
    expect(html).toContain('<h1 id="intro-1"');
  });

  it("renders a nested table of contents at the top when toc is enabled", () => {
    const html = renderMarkdown("# Title\n\n## A\n\n### A.1\n\n## B", { toc: true });
    const tocStart = html.indexOf('<div class="wiki-toc">');
    expect(tocStart).toBeGreaterThan(-1);
    expect(tocStart).toBeLessThan(html.indexOf("<h1"));
    expect(html).toContain('<a href="#a">A</a>');
    expect(html).toContain('<a href="#a.1">A.1</a>');
    expect(html).toContain('<a href="#b">B</a>');
    const toc = html.slice(tocStart, html.indexOf("<h1"));
    expect(toc).toMatch(
      /<ul>[\s\S]*<a href="#a">A<\/a>[\s\S]*<ul>[\s\S]*<a href="#a.1">A.1<\/a>[\s\S]*<\/ul>[\s\S]*<a href="#b">B<\/a>/,
    );
  });

  it("does not render a TOC when toc is disabled", () => {
    const html = renderMarkdown("# Title\n\n## A");
    expect(html).not.toContain("wiki-toc");
  });
});

describe("hasWikiHeadings", () => {
  it("detects h1-h3 headings", () => {
    expect(hasWikiHeadings("# A")).toBe(true);
    expect(hasWikiHeadings("## A")).toBe(true);
    expect(hasWikiHeadings("### A")).toBe(true);
    expect(hasWikiHeadings("plain text\n\nmore")).toBe(false);
    expect(hasWikiHeadings("#### A")).toBe(false);
  });
});

describe("extractWikiHeadings (G3.S5.T6)", () => {
  it("extracts h1-h3 headings with ids matching the rendered anchors", () => {
    const headings = extractWikiHeadings("# Title\n\n## Setup\n\n### Sub\n\n#### Ignored");
    expect(headings).toEqual([
      { level: 1, id: "title", text: "Title" },
      { level: 2, id: "setup", text: "Setup" },
      { level: 3, id: "sub", text: "Sub" },
    ]);
  });

  it("uses the same dedup ids as markdown-it-anchor (duplicate slugs get -N)", () => {
    const headings = extractWikiHeadings("# Intro\n\n# Intro");
    expect(headings.map((h) => h.id)).toEqual(["intro", "intro-1"]);
  });

  it("extracts heading text from inline formatting and code", () => {
    const headings = extractWikiHeadings("## Setup `fast` **mode**");
    expect(headings).toEqual([{ level: 2, id: "setup-fast-mode", text: "Setup fast mode" }]);
  });

  it("returns an empty list when there are no h1-h3 headings", () => {
    expect(extractWikiHeadings("plain text\n\n#### h4 only")).toEqual([]);
    expect(extractWikiHeadings("")).toEqual([]);
  });
});

describe("resolveWikiImageSrc (G3.S5.T5)", () => {
  it("rewrites images/ refs to the served URL relative to the page dir", () => {
    expect(
      resolveWikiImageSrc(
        "images/report.pdf/image_000000_abc.png",
        "wiki/sommerseminar/report.md",
      ),
    ).toBe(
      "/api/kb/wiki/image?path=wiki%2Fsommerseminar%2Fimages%2Freport.pdf%2Fimage_000000_abc.png",
    );
  });

  it("leaves absolute/external and non-images refs unchanged", () => {
    expect(resolveWikiImageSrc("https://example.com/x.png", "wiki/a.md")).toBe(
      "https://example.com/x.png",
    );
    expect(resolveWikiImageSrc("/static/x.png", "wiki/a.md")).toBe("/static/x.png");
    expect(resolveWikiImageSrc("images/x.png")).toBe("images/x.png");
  });

  it("rewrites rendered <img> src to the served URL", () => {
    const html = renderMarkdown(
      "![A chart](images/report.pdf/image_000000_abc.png)",
      { pagePath: "wiki/sommerseminar/report.md" },
    );
    expect(html).toContain(
      'src="/api/kb/wiki/image?path=wiki%2Fsommerseminar%2Fimages%2Freport.pdf%2Fimage_000000_abc.png"',
    );
  });

  it("keeps image refs unchanged when no pagePath is given", () => {
    const html = renderMarkdown("![A chart](images/report.pdf/image_000000_abc.png)");
    expect(html).toContain('src="images/report.pdf/image_000000_abc.png"');
  });
});
