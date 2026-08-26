/**
 * DoclingParser - invokes the docling unified parsing script (G2.S5.T1) to
 * convert any docling-supported input (file path or URL) to Markdown written
 * into the shared input-dir, and reads the produced Markdown back.
 *
 * The script prints the absolute output path on stdout so the caller can
 * locate the produced file without re-deriving the stem.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseTocInput, type TocNode } from "../agents/header-toc.js";

const execFileAsync = promisify(execFile);

/** Read the docling outline sidecar (`<md>.outline.json`); null when absent/unusable. */
async function readOutline(readFileImpl: (path: string) => Promise<string>, mdPath: string): Promise<TocNode | null> {
  try {
    return parseTocInput(await readFileImpl(`${mdPath}.outline.json`));
  } catch {
    return null;
  }
}

export interface DoclingParseOptions {
  /** Input file path or URL to parse. */
  input: string;
}

export interface DoclingParseResult {
  /** Parsed Markdown content. */
  markdown: string;
  /** Absolute path of the Markdown file written to the shared input-dir. */
  outputPath: string;
  /** File stem (basename without .md) of the produced Markdown. */
  stem: string;
  /**
   * Absolute directory where parse_doc.py exported the extracted picture
   * images (G3.S5.T5). Always present when --images-dir is passed; the dir may
   * not exist (or be empty) when the document has no images.
   */
  imagesDir: string;
  /**
   * G4.S10.T6: docling-detected heading outline (PDF bookmark layer) parsed from
   * the `<stem>.outline.json` sidecar written next to the markdown. Null when the
   * document has no usable outline. Feeds the `pdf-outline` header-grading source
   * (TOC-first refine) — never blocks parsing when absent.
   */
  outline: TocNode | null;
}

export interface DoclingParserOptions {
  /**
   * Python interpreter of the docling venv (Python 3.12, 6900XT).
   * Default: ~/docling-venv/bin/python (overridable via DOCLING_PYTHON_BIN).
   */
  pythonBin?: string;
  /** Path to parse_doc.py. Default: <this file>/../../scripts/parse_doc.py. */
  scriptPath?: string;
  /** Shared input-dir to write Markdown into. Default: ~/athena-data/input. */
  outputDir?: string;
  /** Injectable execFile implementation for unit tests. */
  execFileImpl?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Injectable readFile implementation for unit tests. */
  readFileImpl?: (path: string) => Promise<string>;
  /** Injectable mkdir for unit tests. */
  mkdirImpl?: (path: string) => Promise<void>;
  /**
   * G4.S8.T16 (parse cache): hash a local input file (SHA-256 hex). Return
   * null for inputs that cannot be hashed (URLs / network) so they always
   * re-parse. Default: sha256 of the file bytes (local paths only).
   */
  hashFileImpl?: (path: string) => Promise<string | null>;
  /** G4.S8.T16: does a file exist? (cache probe). Default: fs stat. */
  existsImpl?: (path: string) => Promise<boolean>;
  /** G4.S8.T16: write the sidecar hash file. Default: fs write. */
  writeSmallFileImpl?: (path: string, content: string) => Promise<void>;
}

export function defaultDoclingPython(): string {
  return process.env.DOCLING_PYTHON_BIN ?? join(homedir(), "docling-venv", "bin", "python");
}

export function defaultDoclingScript(): string {
  return process.env.DOCLING_SCRIPT_PATH ?? fileURLToPath(new URL("../../scripts/parse_doc.py", import.meta.url));
}

export function defaultSharedInputDir(): string {
  return process.env.SHARED_INPUT_DIR ?? join(homedir(), "athena-data", "input");
}

/**
 * Best-effort mirror of parse_doc.py `derive_stem()` (G3.S5.T5). Only used to
 * build a stable per-document image export dir (`<outputDir>/images/<stem>`);
 * parse_doc.py uses the dir exactly as passed, so TS and Python need not agree
 * byte-for-byte.
 */
function deriveStemHint(input: string): string {
  let raw: string;
  if (/^https?:\/\//.test(input)) {
    try {
      const u = new URL(input);
      const path = u.pathname && u.pathname !== "/" ? u.pathname : "/index";
      raw = `${u.host}${path}`;
      if (u.search) raw += `-${u.search.slice(1, 33)}`;
    } catch {
      raw = "url";
    }
  } else {
    raw = input.split(/[\\/]/).pop() ?? "document";
  }
  const sanitized = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return sanitized || "document";
}

export class DoclingParser {
  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly outputDir: string;
  private readonly execFileImpl: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  private readonly readFileImpl: (path: string) => Promise<string>;
  private readonly mkdirImpl: (path: string) => Promise<void>;
  private readonly hashFileImpl: (path: string) => Promise<string | null>;
  private readonly existsImpl: (path: string) => Promise<boolean>;
  private readonly writeSmallFileImpl: (path: string, content: string) => Promise<void>;

  constructor(options: DoclingParserOptions = {}) {
    this.pythonBin = options.pythonBin ?? defaultDoclingPython();
    this.scriptPath = options.scriptPath ?? defaultDoclingScript();
    this.outputDir = options.outputDir ?? defaultSharedInputDir();
    this.execFileImpl = options.execFileImpl ?? ((file, args) => execFileAsync(file, args));
    this.readFileImpl = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
    this.mkdirImpl = options.mkdirImpl ?? (async (path: string) => {
      await mkdir(path, { recursive: true });
    });
    this.hashFileImpl =
      options.hashFileImpl ??
      (async (path: string): Promise<string | null> => {
        if (/^https?:\/\//.test(path)) return null;
        try {
          const data = await readFile(path);
          return createHash("sha256").update(data).digest("hex");
        } catch {
          return null;
        }
      });
    this.existsImpl =
      options.existsImpl ??
      (async (path: string): Promise<boolean> => {
        try {
          return (await readFile(path)).length >= 0;
        } catch {
          return false;
        }
      });
    this.writeSmallFileImpl =
      options.writeSmallFileImpl ??
      (async (path: string, content: string) => {
        await writeFile(path, content, "utf8");
      });
  }

  /**
   * Parse a file path or URL via parse_doc.py → Markdown in the shared
   * input-dir, then read the produced Markdown back.
   *
   * G4.S8.T16 (parse cache): when the input is a LOCAL file whose SHA-256
   * matches the `<md>.sha256` sidecar written by a previous parse, the
   * existing Markdown + images are reused WITHOUT re-running docling. This is
   * what lets a re-upload of the same file resume at refinement instead of
   * paying the full docling/VLM pass again. The sidecar makes staleness
   * detectable: a NEW upload (different bytes → different hash) always
   * re-parses.
   */
  async parse(input: string): Promise<DoclingParseResult> {
    await this.mkdirImpl(this.outputDir);
    const stem = deriveStemHint(input);
    const imagesDir = join(this.outputDir, "images", stem);
    const expectedMd = join(this.outputDir, `${stem}.md`);

    // Cache probe: local input + md exists + sidecar hash matches → reuse.
    if (!/^https?:\/\//.test(input)) {
      const hash = await this.hashFileImpl(input);
      if (hash) {
        const sidecarPath = `${expectedMd}.sha256`;
        const mdExists = await this.existsImpl(expectedMd);
        const sidecarExists = await this.existsImpl(sidecarPath);
        if (mdExists && sidecarExists) {
          const stored = (await this.readFileImpl(sidecarPath)).trim();
          if (stored === hash) {
            const markdown = await this.readFileImpl(expectedMd);
            return {
              markdown,
              outputPath: expectedMd,
              stem: expectedMd.replace(/\.md$/i, "").split("/").pop() ?? "document",
              imagesDir,
              outline: await readOutline(this.readFileImpl, expectedMd),
            };
          }
        }
      }
    }

    const { stdout } = await this.execFileImpl(this.pythonBin, [
      this.scriptPath,
      input,
      this.outputDir,
      "--images-dir",
      imagesDir,
    ]);
    const outputPath = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (!outputPath) {
      throw new Error(`docling produced no output path for ${input}`);
    }
    const resolved = resolve(outputPath);
    const markdown = await this.readFileImpl(resolved);

    // Write the source-hash sidecar so a re-upload of the SAME bytes skips
    // docling next time. Best-effort: cache miss on hash failure is fine.
    if (!/^https?:\/\//.test(input)) {
      const hash = await this.hashFileImpl(input);
      if (hash) {
        await this.writeSmallFileImpl(`${resolved}.sha256`, hash);
      }
    }
    return {
      markdown,
      outputPath: resolved,
      stem: resolved.replace(/\.md$/i, "").split("/").pop() ?? "document",
      imagesDir,
      outline: await readOutline(this.readFileImpl, resolved),
    };
  }
}
