#!/usr/bin/env python3
"""
parse_doc.py - docling unified parsing layer (G2.S5.T1).

Convert any docling-supported input (PDF / DOCX / XLSX / PPTX / images /
HTML / EPUB / CSV / Markdown / LaTeX ... or a URL) to Markdown and write it
to the shared input-dir consumed by the ingest pipeline (llm_wiki + Neo4j).

Usage:
    parse_doc.py <input> <output-dir> [--images-dir <dir>]

    <input>      File path or URL.
    <output-dir> Directory to write the resulting Markdown into
                 (e.g. ~/athena-data/input, the shared input-dir).
    --images-dir Optional absolute dir to export extracted picture images into.
                 When set, the markdown references them with RELATIVE URIs
                 (relative to the Markdown file), e.g. `![Image](images/x.png)`.

Exit codes: 0 = ok, 1 = parse/IO failure.
"""

from __future__ import annotations

import argparse
import base64
import json
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
from docling_core.types.doc import ImageRefMode

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
    """Resolve the key for docling's OpenRouter VLM picture descriptions (G4.S1).

    Prefers the dedicated `DOCLING_OPENROUTER_KEY` (separate from Athena refinement /
    embedding / Pi flows so docling VLM cache-hit-rate + cost are independently
    controllable); falls back to `OPENROUTER_API_KEY`.

    The athena server process may hold OPENROUTER_API_KEY as an *unexecuted*
    base64 command string (e.g. ``$(echo c2st... | base64 -d)``) instead of the
    decrypted key, which makes OpenRouter reject the auth header and silently
    disables picture descriptions. Detect that form and decrypt it here so
    parsing works regardless of how the server was launched. Plaintext keys
    pass through unchanged.
    """
    raw = (
        os.environ.get("DOCLING_OPENROUTER_KEY", "").strip()
        or os.environ.get("OPENROUTER_API_KEY", "").strip()
    )
    if not raw:
        return ""
    match = _BASE64_CMD_RE.fullmatch(raw)
    if match:
        try:
            decoded = base64.b64decode(match.group(1)).decode("utf-8").strip()
        except (ValueError, UnicodeDecodeError):
            log.warning(
                "OpenRouter key looks like an unexecuted base64 command "
                "but failed to decode; picture descriptions disabled"
            )
            return ""
        if not decoded:
            return ""
        log.info("OpenRouter key was an unexecuted base64 command; decrypted it")
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
    # G3.S5.T5: keep extracted picture images in the document so they can be
    # exported to disk (save_as_markdown REFERENCED) and shown in llm_wiki.
    options.generate_picture_images = True
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
            # Ask the VLM to wrap its description in FIXED start/end markers so we can
            # reliably italicise it downstream regardless of which model/words it uses
            # (the old "Based on the image..." first line was model-specific and breaks
            # if the picture-description model changes). mark_vlm_descriptions() finds
            # these markers, not a phrase.
            prompt=(
                "Describe this image in a few sentences. Begin your response with exactly "
                "'[IMG_DESC_START]' and end it with exactly '[IMG_DESC_END]'. Put only the "
                "description text between the two markers."
            ),
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
    # file_sources downstream → no name collisions. Dedup is purely content-based;
    # the name is just an identifier, never a rejection reason (G2.S5.T14).
    return sanitize_stem(Path(name).name)


def extract_outline(result) -> dict | None:
    """Export the document's heading outline (PDF bookmark layer) as a JSON tree.

    Docling derives the section hierarchy from the PDF outline/bookmarks when the
    source has them. The exported shape is exactly the TOC-first grading input:
    ``{"text": "", "level": 0, "children": [...]}`` with structural levels (root = 0,
    first section level = 1). Purely structural (nesting depth), so a malformed
    level field in a docling release can never skew the pre-order walk.

    Never blocks parsing: any failure returns None (no outline sidecar is written).
    """
    try:
        document = result.document
        sections = getattr(document, "sections", None)
        if sections is None:
            texts = getattr(document, "texts", None) or []
            sections = [t for t in texts if getattr(t, "label", "") == "section-heading"]
        root: dict = {"text": "", "level": 0, "children": []}
        if not sections:
            return None

        def walk(children: list, level: int, out: list) -> None:
            for child in children:
                if not getattr(child, "heading", False):
                    continue
                text = (getattr(child, "text", None) or "").strip()
                if not text:
                    continue
                entry: dict = {"text": text[:512], "level": level, "children": []}
                walk(getattr(child, "children", None) or [], level + 1, entry["children"])
                out.append(entry)

        walk(sections, 1, root["children"])
        return root if root["children"] else None
    except Exception as err:  # pragma: no cover - defensive: never break parsing
        log.warning("outline extraction failed (no outline sidecar): %s", err)
        return None


def mark_vlm_descriptions(markdown: str) -> str:
    """Italicise docling's VLM picture-description blocks so a human viewing the
    wiki can tell a machine-generated image description apart from the source text.

    We ask the picture-description model (build_pipeline_options) to wrap its output
    in fixed `[IMG_DESC_START]` … `[IMG_DESC_END]` markers, so recognition here does
    NOT depend on the model's phrasing (the old "Based on the image…" first line was
    model-specific and would break if the model changed). Each non-empty line between
    the markers is wrapped in `<em>…</em>` (inline HTML, preserved by markdown-it).
    """
    START = "[IMG_DESC_START]"
    END = "[IMG_DESC_END]"
    lines = markdown.split("\n")
    out: list[str] = []
    in_desc = False
    for line in lines:
        if START in line and END in line:
            # Both markers on the same line: emit the inner description italicised.
            inner = line.split(START, 1)[1].split(END, 1)[0].strip()
            out.append(f"*{inner}*" if inner else "")
            in_desc = False
            continue
        if START in line:
            in_desc = True
            stripped = line.split(START, 1)[1].strip()
            # markdown *italic* (the wiki renderer has html:false, so <em> would
            # not be parsed into italics — use native markdown emphasis instead)
            out.append(f"*{stripped}*" if stripped else "")
            continue
        if END in line:
            stripped = line.split(END, 1)[0].strip()
            out.append(f"*{stripped}*" if stripped else "")
            in_desc = False
            continue
        if in_desc:
            out.append(f"*{line}*" if line.strip() else line)
            continue
        out.append(line)
    return "\n".join(out)


def parse_document(
    source: str, output_dir: Path, images_dir: Path | None, stem: str
) -> tuple[str, object]:
    """Run docling conversion and return (markdown content, conversion result).

    When ``images_dir`` is given (G3.S5.T5), the extracted picture images are
    exported to disk and the markdown references them via relative URIs so the
    refs resolve unchanged when the images are copied beside a wiki page.
    """
    converter = build_converter()
    log.info("converting %s", source)
    result = converter.convert(source)
    if images_dir is not None:
        out_path = output_dir / f"{stem}.md"
        # A RELATIVE artifacts dir makes docling write refs relative to the
        # markdown file's own directory (images/<stem>/image_xxx.png), so the
        # produced markdown is portable: copy the images beside the page and the
        # refs resolve. An absolute dir would embed absolute paths instead.
        rel_artifacts = Path(os.path.relpath(images_dir, output_dir))
        result.document.save_as_markdown(
            out_path,
            artifacts_dir=rel_artifacts,
            image_mode=ImageRefMode.REFERENCED,
        )
        return mark_vlm_descriptions(out_path.read_text(encoding="utf-8")), result
    return mark_vlm_descriptions(result.document.export_to_markdown()), result


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

    stem = derive_stem(source)
    try:
        markdown, result = parse_document(source, output_dir, image_export_dir, stem)
    except Exception as err:  # docling raises a variety of backend errors
        log.error("parse failed: %s", err)
        return 1

    if not markdown.strip():
        log.error("docling produced empty markdown output")
        return 1

    out_path = output_dir / f"{stem}.md"
    out_path.write_text(markdown, encoding="utf-8")
    # G4.S10.T6: export the docling heading outline (PDF bookmark layer) beside the
    # markdown so the ingest pipeline can use the document's OWN hierarchy for
    # TOC-first header grading. Best-effort: no outline → no sidecar, never fails.
    outline = extract_outline(result)
    if outline:
        (output_dir / f"{stem}.outline.json").write_text(
            json.dumps(outline, ensure_ascii=False), encoding="utf-8"
        )
    log.info("wrote %s (%d chars)", out_path, len(markdown))
    print(out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
