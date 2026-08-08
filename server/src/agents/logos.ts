import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

/**
 * Logo system (G3.S1.T3): a consistent-style set of generated animal logos
 * (owl as style reference) + agent self-upload.
 *
 * Generated + uploaded logos are stored as asset files on disk and their
 * metadata is persisted in an `index.json` manifest inside the store dir.
 * Web-servable URLs are `/logos/...` (Vite serves `web/public/` at the root).
 */

export interface LogoRecord {
  id: string;
  name: string;
  animal?: string;
  color?: string;
  url: string;
  filename: string;
  source: "generated" | "upload";
  created_at: string;
}

export interface LogoGenerationRequest {
  prompt: string;
  referenceImage?: Buffer;
  size?: string;
}

/** Calls an image-generation model and resolves with the rendered image bytes. */
export interface LogoImageClient {
  generate(request: LogoGenerationRequest): Promise<Buffer>;
}

export interface GeneratedAnimal {
  animal: string;
  color: string;
}

/** Ready-made animal logo options (different animals + distinct colors, one consistent style). */
export const ANIMAL_LOGO_SET: GeneratedAnimal[] = [
  { animal: "fox", color: "teal" },
  { animal: "eagle", color: "amber" },
  { animal: "lion", color: "crimson" },
  { animal: "wolf", color: "indigo" },
  { animal: "dolphin", color: "blue" },
  { animal: "raven", color: "violet" },
];

export interface UploadLogoInput {
  filename: string;
  data: Buffer;
  mimetype?: string;
}

export interface LogoStore {
  list(): Promise<LogoRecord[]>;
  upload(input: UploadLogoInput): Promise<LogoRecord>;
  /** Generate any missing animal logos (idempotent). */
  ensureGeneratedSet(): Promise<LogoRecord[]>;
  close(): Promise<void>;
}

export class LogoGenerationError extends Error {}

export interface OpenRouterLogoClientOptions {
  /** Path to the Pi auth.json. Default: ~/.pi/agent/auth.json. */
  authPath?: string;
  /** OpenRouter image model. Default: qwen/qwen-image-3. */
  model?: string;
  /** OpenRouter base URL. Default: https://openrouter.ai/api/v1 */
  baseUrl?: string;
  /** Default requested size. Default: "512x512". */
  size?: string;
}

const DEFAULT_IMAGE_MODEL = "qwen/qwen-image-3";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_SIZE = "512x512";

async function loadOpenRouterKey(authPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const auth = JSON.parse(raw) as { openrouter?: { key?: unknown } };
    if (typeof auth.openrouter?.key === "string" && auth.openrouter.key.trim()) {
      return auth.openrouter.key;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** OpenRouter image generation via POST /api/v1/images (OpenAI-compatible). */
export class OpenRouterLogoClient implements LogoImageClient {
  private readonly authPath: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly size: string;

  constructor(options: OpenRouterLogoClientOptions = {}) {
    this.authPath = options.authPath ?? join(homedir(), ".pi", "agent", "auth.json");
    this.model = options.model ?? DEFAULT_IMAGE_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.size = options.size ?? DEFAULT_SIZE;
  }

  async generate(request: LogoGenerationRequest): Promise<Buffer> {
    const key = await loadOpenRouterKey(this.authPath);
    if (!key) {
      throw new LogoGenerationError(
        `OpenRouter API key not found in ${this.authPath}; run 'pi setup' or set up auth.json`,
      );
    }
    const payload: Record<string, unknown> = {
      model: this.model,
      prompt: request.prompt,
      n: 1,
      size: request.size ?? this.size,
      response_format: "b64_json",
    };
    if (request.referenceImage) {
      payload.image = [
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${request.referenceImage.toString("base64")}`,
          },
        },
      ];
    }
    const res = await fetch(`${this.baseUrl}/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new LogoGenerationError(
        `image generation failed (${res.status}): ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = body.data?.[0]?.b64_json;
    if (!b64) {
      throw new LogoGenerationError("image generation returned no data");
    }
    return Buffer.from(b64, "base64");
  }
}

function now(): string {
  return new Date().toISOString();
}

function safeFilename(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  const sanitized = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || `upload-${Date.now()}`;
}

/** Detect the real image format from magic bytes (generation may return JPEG). */
function detectImageExt(buffer: Buffer): "png" | "jpg" | "webp" {
  if (buffer.length >= 8 && buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return "png";
}

function logoPrompt(animal: string, color: string): string {
  return `Minimalist flat vector logo of a ${animal} head, bold geometric rounded silhouette, flat ${color} background with a subtle lighter accent shape, clean modern mascot style consistent with the reference owl logo, no text, centered, square 1:1`;
}

export interface FileLogoStoreOptions {
  /** Directory where logo asset files + index.json live. */
  dir: string;
  /** Image generation client. When absent, ensureGeneratedSet() is a no-op. */
  client?: LogoImageClient;
  /** Style-reference image (owl) passed to the generation model. */
  referenceImage?: Buffer;
  /** Web-servable base prefix. Default: "/logos". */
  urlPrefix?: string;
}

/**
 * File-backed logo store. Generated assets live directly in `dir`,
 * uploads under `dir/uploads`, and metadata in `dir/index.json`.
 */
export class FileLogoStore implements LogoStore {
  private readonly dir: string;
  private readonly client?: LogoImageClient;
  private readonly referenceImage?: Buffer;
  private readonly urlPrefix: string;
  private index: LogoRecord[] | null = null;

  constructor(options: FileLogoStoreOptions) {
    this.dir = options.dir;
    this.client = options.client;
    this.referenceImage = options.referenceImage;
    this.urlPrefix = (options.urlPrefix ?? "/logos").replace(/\/+$/, "");
  }

  private indexFile(): string {
    return join(this.dir, "index.json");
  }

  private urlFor(relativePath: string): string {
    return `${this.urlPrefix}/${relativePath.replaceAll("\\", "/")}`;
  }

  private async loadIndex(): Promise<LogoRecord[]> {
    if (this.index) {
      return this.index;
    }
    try {
      const raw = await readFile(this.indexFile(), "utf8");
      const parsed = JSON.parse(raw) as { logos?: LogoRecord[] };
      this.index = parsed.logos ?? [];
    } catch {
      this.index = [];
    }
    return this.index;
  }

  private async saveIndex(index: LogoRecord[]): Promise<void> {
    await writeFileSafe(this.indexFile(), JSON.stringify({ logos: index }, null, 2));
  }

  async list(): Promise<LogoRecord[]> {
    return [...(await this.loadIndex())];
  }

  async upload(input: UploadLogoInput): Promise<LogoRecord> {
    const safe = safeFilename(input.filename);
    const filename = `${Date.now()}-${safe}`;
    const relativePath = join("uploads", filename);
    await writeFileSafe(join(this.dir, relativePath), input.data);

    const record: LogoRecord = {
      id: filename,
      name: safe.replace(extname(safe), ""),
      url: this.urlFor(relativePath),
      filename,
      source: "upload",
      created_at: now(),
    };
    const index = await this.loadIndex();
    index.push(record);
    await this.saveIndex(index);
    return record;
  }

  async ensureGeneratedSet(): Promise<LogoRecord[]> {
    const index = await this.loadIndex();
    if (!this.client) {
      return [...index];
    }
    const have = new Set(index.map((record) => record.animal).filter(Boolean));
    const missing = ANIMAL_LOGO_SET.filter((spec) => !have.has(spec.animal));
    for (const spec of missing) {
      const image = await this.client.generate({
        prompt: logoPrompt(spec.animal, spec.color),
        referenceImage: this.referenceImage,
      });
      const filename = `${spec.animal}.${detectImageExt(image)}`;
      await writeFileSafe(join(this.dir, filename), image);
      index.push({
        id: spec.animal,
        name: spec.animal,
        animal: spec.animal,
        color: spec.color,
        url: this.urlFor(filename),
        filename,
        source: "generated",
        created_at: now(),
      });
    }
    if (missing.length > 0) {
      await this.saveIndex(index);
    }
    return [...index];
  }

  async close(): Promise<void> {
    // no pooled resources to release
  }
}

async function writeFileSafe(file: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
}
