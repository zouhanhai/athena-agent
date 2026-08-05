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

from docling.document_converter import DocumentConverter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("parse_doc")

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
    return sanitize_stem(Path(name).stem)


def parse_document(source: str, output_dir: Path, image_export_dir: Path | None) -> str:
    """Run docling conversion and return the markdown content."""
    converter = DocumentConverter()
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
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
