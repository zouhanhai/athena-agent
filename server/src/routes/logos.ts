import type { FastifyInstance } from "fastify";
import { AgentNotFoundError, type AgentRegistry } from "../agents/registry.js";
import type { LogoStore } from "../agents/logos.js";

export interface LogoRouteOptions {
  logoStore: LogoStore;
  registry?: AgentRegistry;
  /** Max logo upload size (bytes). Default: 10 MiB. */
  maxFileSize?: number;
}

const IMAGE_MIMETYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_MAGIC = Buffer.from("WEBP", "ascii");

/** Verify the uploaded bytes match their declared image type (no spoofed mimetypes). */
function isValidImage(mimetype: string, data: Buffer): boolean {
  switch (mimetype) {
    case "image/png":
      return data.length >= 8 && data.subarray(0, 4).equals(PNG_MAGIC);
    case "image/jpeg":
      return data.length >= 3 && data.subarray(0, 3).equals(JPEG_MAGIC);
    case "image/webp":
      return data.length >= 12 && data.subarray(8, 12).equals(WEBP_MAGIC);
    case "image/gif":
      return data.length >= 4 && data.subarray(0, 4).toString("ascii") === "GIF8";
    case "image/svg+xml":
      return data.length > 0 && data.toString("utf8").includes("<svg");
    default:
      return false;
  }
}

/**
 * Logo endpoints:
 * - GET /api/logos → list generated + uploaded logos
 * - POST /api/logos (multipart `file`, optional `alias`) → self-upload a logo;
 *   when `alias` is provided the agent's logo_url is set to the upload.
 */
export function registerLogoRoutes(app: FastifyInstance, options: LogoRouteOptions): void {
  app.get("/api/logos", async (_request, reply) => {
    try {
      const logos = await options.logoStore.list();
      return { logos };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/logos", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "multipart form-data with a file field is required" });
    }

    let file: { filename: string; mimetype: string; data: Buffer } | undefined;
    let alias: string | undefined;
    try {
      for await (const part of request.parts({ limits: { fileSize: options.maxFileSize ?? 10 * 1024 * 1024 } })) {
        if (part.type === "file") {
          file = {
            filename: part.filename,
            mimetype: part.mimetype,
            data: await part.toBuffer(),
          };
        } else if (part.type === "field" && part.fieldname === "alias") {
          alias = typeof part.value === "string" ? part.value : undefined;
        }
      }
    } catch (err) {
      return reply.code(413).send({ error: err instanceof Error ? err.message : String(err) });
    }

    if (!file) {
      return reply.code(400).send({ error: "file is required" });
    }
    if (!IMAGE_MIMETYPES.has(file.mimetype)) {
      return reply.code(400).send({ error: `unsupported image type: ${file.mimetype}` });
    }
    if (file.data.length === 0) {
      return reply.code(400).send({ error: "file is empty" });
    }
    if (!isValidImage(file.mimetype, file.data)) {
      return reply.code(400).send({ error: "file content does not match its declared image type" });
    }

    const targetAlias = alias && alias.trim() ? alias.trim() : undefined;
    if (targetAlias && options.registry) {
      const existing = await options.registry.getByAlias(targetAlias);
      if (!existing) {
        return reply.code(404).send({ error: `agent "${targetAlias}" not found` });
      }
    }

    try {
      const logo = await options.logoStore.upload({
        filename: file.filename,
        data: file.data,
        mimetype: file.mimetype,
      });
      if (targetAlias && options.registry) {
        await options.registry.updateByAlias(targetAlias, { logo_url: logo.url });
      }
      return reply.code(201).send({ logo });
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
