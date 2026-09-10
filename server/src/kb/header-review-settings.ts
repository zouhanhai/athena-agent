/**
 * G4.S10.T7 — per-project header-review settings (file-backed).
 *
 * The gate flag (`enabled`), the tiny-doc auto-skip threshold (`minHeaders`)
 * and the bulk template-demotion word list are PROJECT-level configuration,
 * persisted as a small JSON file in the shared data dir so they survive
 * restarts and are editable from the Admin console / the card editor.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_HEADER_REVIEW_MIN_HEADERS,
  DEFAULT_HEADER_REVIEW_TEMPLATE_WORDS,
} from "./header-review.js";

export interface HeaderReviewSettings {
  /** Gate flag: documents pause in `pending_header_review` after parsing. */
  enabled: boolean;
  /** Tiny-doc auto-skip: docs with fewer than this many headings bypass the gate. */
  minHeaders: number;
  /** Bulk template-demotion word list (exact header text matches → bold). */
  templateWords: string[];
}

export interface HeaderReviewSettingsStore {
  get(): Promise<HeaderReviewSettings>;
  update(patch: Partial<HeaderReviewSettings>): Promise<HeaderReviewSettings>;
  /** Editable word list persisted per project (bulk demotion). */
  setTemplateWords(words: string[]): Promise<HeaderReviewSettings>;
}

export function defaultHeaderReviewSettingsPath(): string {
  return process.env.HEADER_REVIEW_SETTINGS_PATH
    ?? join(homedir(), "athena-data", "settings", "header-review.json");
}

/** Sanitize a settings patch: types + the word list normalized (trim, drop empties). */
export function sanitizeSettingsPatch(patch: Partial<HeaderReviewSettings>): Partial<HeaderReviewSettings> {
  const out: Partial<HeaderReviewSettings> = {};
  if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
  if (typeof patch.minHeaders === "number" && Number.isFinite(patch.minHeaders)) {
    out.minHeaders = Math.max(1, Math.round(patch.minHeaders));
  }
  if (Array.isArray(patch.templateWords)) {
    const words = patch.templateWords
      .map((w) => (typeof w === "string" ? w.replace(/\s+/g, " ").trim() : ""))
      .filter((w) => w.length > 0);
    if (words.length > 0) out.templateWords = [...new Set(words)];
  }
  return out;
}

export interface FileHeaderReviewSettingsStoreOptions {
  path?: string;
  readFileImpl?: (path: string) => Promise<string>;
  writeFileImpl?: (path: string, content: string) => Promise<void>;
  mkdirImpl?: (path: string) => Promise<void>;
}

export class FileHeaderReviewSettingsStore implements HeaderReviewSettingsStore {
  private readonly path: string;
  private readonly readFileImpl: (path: string) => Promise<string>;
  private readonly writeFileImpl: (path: string, content: string) => Promise<void>;
  private readonly mkdirImpl: (path: string) => Promise<void>;
  private cache?: HeaderReviewSettings;

  constructor(options: FileHeaderReviewSettingsStoreOptions = {}) {
    this.path = options.path ?? defaultHeaderReviewSettingsPath();
    this.readFileImpl = options.readFileImpl ?? ((p: string) => readFile(p, "utf8"));
    this.writeFileImpl = options.writeFileImpl ?? ((p: string, c: string) => writeFile(p, c, "utf8"));
    this.mkdirImpl = options.mkdirImpl ?? (async (p: string): Promise<void> => { await mkdir(p, { recursive: true }); });
  }

  async get(): Promise<HeaderReviewSettings> {
    if (this.cache) return { ...this.cache };
    try {
      const raw = JSON.parse(await this.readFileImpl(this.path)) as Partial<HeaderReviewSettings>;
      this.cache = {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
        minHeaders:
          typeof raw.minHeaders === "number" && Number.isFinite(raw.minHeaders)
            ? raw.minHeaders
            : DEFAULT_HEADER_REVIEW_MIN_HEADERS,
        templateWords:
          Array.isArray(raw.templateWords) && raw.templateWords.every((w) => typeof w === "string")
            ? raw.templateWords
            : [...DEFAULT_HEADER_REVIEW_TEMPLATE_WORDS],
      };
    } catch {
      this.cache = {
        enabled: false,
        minHeaders: DEFAULT_HEADER_REVIEW_MIN_HEADERS,
        templateWords: [...DEFAULT_HEADER_REVIEW_TEMPLATE_WORDS],
      };
    }
    return { ...this.cache };
  }

  async update(patch: Partial<HeaderReviewSettings>): Promise<HeaderReviewSettings> {
    const current = await this.get();
    const next = sanitizeSettingsPatch(patch);
    const merged: HeaderReviewSettings = {
      ...current,
      ...next,
      templateWords: next.templateWords ?? current.templateWords,
    };
    await this.mkdirImpl(dirname(this.path));
    await this.writeFileImpl(this.path, JSON.stringify(merged, null, 2));
    this.cache = merged;
    return { ...merged };
  }

  async setTemplateWords(words: string[]): Promise<HeaderReviewSettings> {
    return this.update({ templateWords: words });
  }
}