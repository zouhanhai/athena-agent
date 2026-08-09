#!/usr/bin/env python3
"""
parse_doc.py - docling unified parsing layer (G2.S5.T1).

Convert any docling-supported input (PDF / DOCX / XLSX / PPTX / images /
HTML / EPUB / CSV / Markdown / LaTeX ... or a URL) to Markdown and write it
to the shared input-dir consumed by the dual-pipeline (LightRAG + llm_wiki).

Usage:
    parse_doc.py <input> <output-dir>

    <input>      File path or URL.
    <output-dir> Directory to write the resulting Markdown into
                 (e.g. ~/athena-data/input, the shared input-dir).

Exit codes: 0 = ok, 1 = parse/IO failure.
"""

from __future__ import annotations

import argparse
import base64
import logging
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

def _ensure_writable_hf_cache() -> None:
    """Point HF_HOME at a writable cache dir when the default one is not.

    docling downloads layout/OCR models from HuggingFace on first PDF/image
    parse; if ~/.cache/huggingface is unwritable (e.g. root-owned) the run
    fails. Fall back to a per-user writable cache.
    """
    if os.environ.get("HF_HOME") or os.environ.get("HUGGINGFACE_HUB_CACHE"):
        return
    default = Path.home() / ".cache" / "huggingface"
    try:
        probe = default / ".write-probe"
        probe.touch()
        probe.unlink()
        return
    except OSError:
        fallback = Path.home() / ".cache" / "hf-writable"
        fallback.mkdir(parents=True, exist_ok=True)
        os.environ["HF_HOME"] = str(fallback)


_ensure_writable_hf_cache()

from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import (
    PdfPipelineOptions,
    PictureDescriptionApiOptions,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("parse_doc")

# G2.S5.T6: picture-description VLM on OpenRouter (image content -> Markdown).
PICTURE_DESCRIPTION_MODEL = os.environ.get(
    "PICTURE_DESCRIPTION_MODEL", "qwen/qwen3.7-flash"
)
OPENROUTER_BASE_URL = os.environ.get(
    "PICTURE_DESCRIPTION_API_URL",
    "https://openrouter.ai/api/v1/chat/completions",
)

# Matches the unexecuted shell form the athena server may carry in its env:
#   OPENROUTER_API_KEY=$(echo c2stb3It... | base64 -d)
_BASE64_CMD_RE = re.compile(
    r"\$\(\s*echo\s+([A-Za-z0-9+/=]+)\s*\|\s*base64\s*-d\s*\)"
)


def resolve_openrouter_key() -> str:
    """Resolve OPENROUTER_API_KEY to a usable plaintext value (G2.S5.T9).

    The athena server process may hold OPENROUTER_API_KEY as an *unexecuted*
    base64 command string (e.g. ``$(echo c2st... | base64 -d)``) instead of the
    decrypted key, which makes OpenRouter reject the auth header and silently
    disables picture descriptions. Detect that form and decrypt it here so
    parsing works regardless of how the server was launched. Plaintext keys
    pass through unchanged.
    """
    raw = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not raw:
        return ""
    match = _BASE64_CMD_RE.fullmatch(raw)
    if match:
        try:
            decoded = base64.b64decode(match.group(1)).decode("utf-8").strip()
        except (ValueError, UnicodeDecodeError):
            log.warning(
                "OPENROUTER_API_KEY looks like an unexecuted base64 command "
                "but failed to decode; picture descriptions disabled"
            )
            return ""
        if not decoded:
            return ""
        log.info("OPENROUTER_API_KEY was an unexecuted base64 command; decrypted it")
        return decoded
    return raw


def build_pipeline_options() -> PdfPipelineOptions:
    """docling PDF pipeline options (G2.S5.T6).

    Enables picture descriptions via the OpenRouter VLM when a valid
    OPENROUTER_API_KEY is available, so image content is captured in the parsed
    Markdown instead of a bare `image` placeholder. Without a usable key the
    pipeline degrades gracefully (picture descriptions off) and parsing still
    works.
    """
    options = PdfPipelineOptions()
    api_key = resolve_openrouter_key()
    if api_key:
        options.enable_remote_services = True
        options.do_picture_description = True
        options.picture_description_options = PictureDescriptionApiOptions(
            url=OPENROUTER_BASE_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            params={"model": PICTURE_DESCRIPTION_MODEL},
            timeout=60,
            concurrency=4,
            # Describe small images too: default threshold is 5% of page area (0.05);
            # lower to 1% so small figures/logos still get a VLM description (RAG-searchable).
            picture_area_threshold=0.01,
        )
        log.info(
            "picture descriptions enabled via OpenRouter VLM (%s)",
            PICTURE_DESCRIPTION_MODEL,
        )
    else:
        log.warning(
            "OPENROUTER_API_KEY not usable; picture descriptions disabled "
            "(images will be parsed as bare placeholders)"
        )
    return options


def build_converter() -> DocumentConverter:
    """DocumentConverter with picture-description pipeline options (PDF + image)."""
    pipeline_options = build_pipeline_options()
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options),
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=pipeline_options),
        }
    )

SUPPORTED_EXTENSIONS = {
    ".pdf",
    ".docx", ".doc",
    ".xlsx", ".xls",
    ".pptx", ".ppt",
    ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp",
    ".html", ".htm",
    ".epub",
    ".csv",
    ".md", ".markdown",
    ".tex", ".latex",
    ".odt", ".ods", ".odp",
    ".asciidoc", ".adoc",
    ".eml",
    ".xml",
}


def is_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def sanitize_stem(stem: str) -> str:
    """Map an input name to a safe markdown output stem."""
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", stem)
    value = re.sub(r"-{2,}", "-", value).strip("._-")
    return value or "document"


def derive_stem(source: str) -> str:
    if is_url(source):
        parsed = urlparse(source)
        host = parsed.netloc or "url"
        path = parsed.path
        if not path or path == "/":
            path = "/index"
        raw = f"{host}{path}"
        if parsed.query:
            raw += f"-{parsed.query[:32]}"
        return sanitize_stem(raw)
    name = Path(source).name or "document"
    # Keep the original extension in the output stem so same-name files of
    # DIFFERENT formats (e.g. sommerseminar-l-sen.pdf vs .docx) get different
    # file_sources downstream → no LightRAG 409. Dedup is purely content-based;
    # the name is just an identifier, never a rejection reason (G2.S5.T14).
    return sanitize_stem(Path(name).name)


def parse_document(source: str, output_dir: Path, image_export_dir: Path | None) -> str:
    """Run docling conversion and return the markdown content."""
    converter = build_converter()
    log.info("converting %s", source)
    result = converter.convert(source)
    markdown = result.document.export_to_markdown(
        image_export_dir=image_export_dir
    ) if image_export_dir else result.document.export_to_markdown()
    if not markdown.strip():
        raise ValueError("docling produced empty markdown output")
    return markdown


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="docling unified parsing: file/URL -> Markdown"
    )
    parser.add_argument("input", help="file path or http(s) URL to parse")
    parser.add_argument(
        "output_dir",
        help="shared input-dir to write the Markdown into",
    )
    parser.add_argument(
        "--images-dir",
        help="optional dir to store extracted images (referenced from markdown)",
    )
    parser.add_argument(
        "--loglevel",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="logging level",
    )
    args = parser.parse_args(argv)

    log.setLevel(getattr(logging, args.loglevel))

    source = args.input
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not is_url(source) and not Path(source).expanduser().is_file():
        log.error("input is neither an existing file nor a URL: %s", source)
        return 1

    image_export_dir = (
        Path(args.images_dir).expanduser().resolve() if args.images_dir else None
    )
    if image_export_dir:
        image_export_dir.mkdir(parents=True, exist_ok=True)

    try:
        markdown = parse_document(source, output_dir, image_export_dir)
    except Exception as err:  # docling raises a variety of backend errors
        log.error("parse failed: %s", err)
        return 1

    stem = derive_stem(source)
    out_path = output_dir / f"{stem}.md"
    out_path.write_text(markdown, encoding="utf-8")
    log.info("wrote %s (%d chars)", out_path, len(markdown))
    print(out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
