import { describe, expect, it } from "vitest";

import { detectLanguage, highlightCode, renderCodeLines } from "@/github/highlight";

describe("detectLanguage", () => {
  it("maps common extensions to language ids", () => {
    expect(detectLanguage("index.ts")).toBe("typescript");
    expect(detectLanguage("app.tsx")).toBe("typescript");
    expect(detectLanguage("index.js")).toBe("javascript");
    expect(detectLanguage("main.py")).toBe("python");
    expect(detectLanguage("go.mod")).toBe("go");
    expect(detectLanguage("lib.rs")).toBe("rust");
    expect(detectLanguage("data.json")).toBe("json");
    expect(detectLanguage("config.yaml")).toBe("yaml");
    expect(detectLanguage("page.html")).toBe("html");
    expect(detectLanguage("style.css")).toBe("css");
    expect(detectLanguage("README.md")).toBe("markdown");
    expect(detectLanguage("run.sh")).toBe("bash");
    expect(detectLanguage("schema.sql")).toBe("sql");
    expect(detectLanguage("Main.java")).toBe("java");
  });

  it("is case-insensitive", () => {
    expect(detectLanguage("UPPER.TS")).toBe("typescript");
  });

  it("maps Dockerfile and falls back to plaintext", () => {
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    expect(detectLanguage(".gitignore")).toBe("plaintext");
    expect(detectLanguage("README")).toBe("plaintext");
  });
});

describe("highlightCode", () => {
  it("escapes HTML in plaintext", () => {
    expect(highlightCode("<b>bold</b> & more", "plaintext")).toBe("&lt;b&gt;bold&lt;/b&gt; &amp; more");
  });

  it("never emits raw user HTML (XSS safety)", () => {
    const out = highlightCode('<script>alert(1)</script>', "html");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("</script>");
    expect(out).toContain("&lt;script");
    expect(out).toContain("&gt;");
  });

  it("wraps TypeScript keywords, strings and numbers in token spans", () => {
    const out = highlightCode('const answer: number = 42;', "typescript");
    expect(out).toContain('<span class="tok-keyword">const</span>');
    expect(out).toContain('<span class="tok-type">number</span>');
    expect(out).toContain('<span class="tok-number">42</span>');
  });

  it("wraps strings in tok-string spans", () => {
    const out = highlightCode('const s = "hi there";', "typescript");
    expect(out).toContain('<span class="tok-string">&quot;hi there&quot;</span>');
  });

  it("wraps line comments in tok-comment spans", () => {
    const out = highlightCode("// a note\nconst x = 1;", "typescript");
    expect(out).toContain('<span class="tok-comment">// a note</span>');
  });

  it("wraps block comments in tok-comment spans", () => {
    const out = highlightCode("/* block */\nlet y = 2;", "javascript");
    expect(out).toContain('<span class="tok-comment">/* block */</span>');
  });

  it("highlights python def keywords and # comments", () => {
    const out = highlightCode("def greet():\n    # hi\n    return 1", "python");
    expect(out).toContain('<span class="tok-keyword">def</span>');
    expect(out).toContain('<span class="tok-comment"># hi</span>');
    expect(out).toContain('<span class="tok-keyword">return</span>');
  });

  it("highlights go func and package keywords", () => {
    const out = highlightCode("package main\nfunc main() {}", "go");
    expect(out).toContain('<span class="tok-keyword">package</span>');
    expect(out).toContain('<span class="tok-keyword">func</span>');
  });

  it("highlights json true/false/null as keywords", () => {
    const out = highlightCode('{"ok": true, "n": null}', "json");
    expect(out).toContain('<span class="tok-keyword">true</span>');
    expect(out).toContain('<span class="tok-keyword">null</span>');
  });

  it("highlights css hex colors as constants", () => {
    const out = highlightCode("body { color: #ff00aa; }", "css");
    expect(out).toContain('<span class="tok-constant">#ff00aa</span>');
  });

  it("highlights bash comments and strings", () => {
    const out = highlightCode('# run\ncd "/tmp"', "bash");
    expect(out).toContain('<span class="tok-comment"># run</span>');
    expect(out).toContain('<span class="tok-string">&quot;/tmp&quot;</span>');
  });
});

describe("renderCodeLines", () => {
  it("returns one entry per source line", () => {
    const lines = renderCodeLines("a\nb\nc", "plaintext");
    expect(lines.length).toBe(3);
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("keeps a trailing newline as an empty final line", () => {
    const lines = renderCodeLines("a\n", "plaintext");
    expect(lines).toEqual(["a", ""]);
  });

  it("escapes HTML on every line", () => {
    const lines = renderCodeLines("<b>\n</b>", "plaintext");
    expect(lines).toEqual(["&lt;b&gt;", "&lt;/b&gt;"]);
  });

  it("colors every line of a multi-line block comment", () => {
    const lines = renderCodeLines("/* start\nmiddle\nend */\nconst x = 1;", "javascript");
    expect(lines[0]).toContain('<span class="tok-comment">/* start</span>');
    expect(lines[1]).toBe('<span class="tok-comment">middle</span>');
    expect(lines[2]).toContain('<span class="tok-comment">end */</span>');
    expect(lines[3]).toContain('<span class="tok-keyword">const</span>');
  });
});
