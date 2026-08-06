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
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

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

export class DoclingParser {
  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly outputDir: string;
  private readonly execFileImpl: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  private readonly readFileImpl: (path: string) => Promise<string>;
  private readonly mkdirImpl: (path: string) => Promise<void>;

  constructor(options: DoclingParserOptions = {}) {
    this.pythonBin = options.pythonBin ?? defaultDoclingPython();
    this.scriptPath = options.scriptPath ?? defaultDoclingScript();
    this.outputDir = options.outputDir ?? defaultSharedInputDir();
    this.execFileImpl = options.execFileImpl ?? ((file, args) => execFileAsync(file, args, { timeout: 300_000 }));
    this.readFileImpl = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
    this.mkdirImpl = options.mkdirImpl ?? (async (path: string) => {
      await mkdir(path, { recursive: true });
    });
  }

  /**
   * Parse a file path or URL via parse_doc.py → Markdown in the shared
   * input-dir, then read the produced Markdown back.
   */
  async parse(input: string): Promise<DoclingParseResult> {
    await this.mkdirImpl(this.outputDir);
    const { stdout } = await this.execFileImpl(this.pythonBin, [this.scriptPath, input, this.outputDir]);
    const outputPath = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (!outputPath) {
      throw new Error(`docling produced no output path for ${input}`);
    }
    const resolved = resolve(outputPath);
    const markdown = await this.readFileImpl(resolved);
    return {
      markdown,
      outputPath: resolved,
      stem: resolved.replace(/\.md$/i, "").split("/").pop() ?? "document",
    };
  }
}
