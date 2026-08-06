"""Unit tests for parse_doc.py picture-description wiring (G2.S5.T6).

Run: ~/docling-venv/bin/python test/parse_doc_test.py
"""
import os
import sys
import unittest
from unittest import mock
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import parse_doc  # noqa: E402


class BuildPipelineOptionsTest(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("OPENROUTER_API_KEY", None)

    def test_disabled_without_api_key(self):
        os.environ.pop("OPENROUTER_API_KEY", None)
        options = parse_doc.build_pipeline_options()
        self.assertFalse(options.do_picture_description)
        self.assertFalse(options.enable_remote_services)

    def test_enabled_with_api_key_uses_openrouter_qwen(self):
        os.environ["OPENROUTER_API_KEY"] = "sk-test-123"
        options = parse_doc.build_pipeline_options()
        self.assertTrue(options.do_picture_description)
        self.assertTrue(options.enable_remote_services)
        desc = options.picture_description_options
        self.assertEqual(desc.params["model"], "qwen/qwen3.7-flash")
        self.assertIn("Authorization", desc.headers)
        self.assertIn("Bearer sk-test-123", desc.headers["Authorization"])
        self.assertTrue(str(desc.url).startswith("https://openrouter.ai/"))


class BuildConverterTest(unittest.TestCase):
    def test_converter_has_pdf_and_image_format_options(self):
        converter = parse_doc.build_converter()
        self.assertIn(parse_doc.InputFormat.PDF, converter.format_to_options)
        self.assertIn(parse_doc.InputFormat.IMAGE, converter.format_to_options)
        # other formats still fall back to defaults (unified parsing preserved)
        self.assertIn(parse_doc.InputFormat.DOCX, converter.format_to_options)


class SanitizeStemTest(unittest.TestCase):
    def test_derive_stem_for_pdf(self):
        self.assertEqual(parse_doc.derive_stem("/tmp/My Report.pdf"), "My-Report")


if __name__ == "__main__":
    unittest.main(verbosity=2)
