"""Unit tests for parse_doc.py picture-description wiring (G2.S5.T6/T9).

Run: ~/docling-venv/bin/python test/parse_doc_test.py
"""
import base64
import os
import sys
import unittest
from unittest import mock
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import parse_doc  # noqa: E402


class ResolveOpenRouterKeyTest(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("OPENROUTER_API_KEY", None)

    def test_plaintext_key_passes_through(self):
        os.environ["OPENROUTER_API_KEY"] = "sk-test-123"
        self.assertEqual(parse_doc.resolve_openrouter_key(), "sk-test-123")

    def test_unexecuted_base64_command_is_decrypted(self):
        secret = "sk-or-v1-abcdef"
        encoded = base64.b64encode(secret.encode()).decode()
        os.environ["OPENROUTER_API_KEY"] = f"$(echo {encoded} | base64 -d)"
        self.assertEqual(parse_doc.resolve_openrouter_key(), secret)

    def test_empty_env_returns_empty(self):
        os.environ.pop("OPENROUTER_API_KEY", None)
        self.assertEqual(parse_doc.resolve_openrouter_key(), "")

    def test_invalid_base64_command_returns_empty(self):
        # matches the command pattern but decodes to non-UTF-8 bytes
        os.environ["OPENROUTER_API_KEY"] = "$(echo /w== | base64 -d)"
        self.assertEqual(parse_doc.resolve_openrouter_key(), "")

    def test_non_command_string_passes_through(self):
        os.environ["OPENROUTER_API_KEY"] = "sk-something-weird"
        self.assertEqual(parse_doc.resolve_openrouter_key(), "sk-something-weird")


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

    def test_enabled_when_key_is_unexecuted_base64_command(self):
        secret = "sk-or-v1-decoded"
        encoded = base64.b64encode(secret.encode()).decode()
        os.environ["OPENROUTER_API_KEY"] = f"$(echo {encoded} | base64 -d)"
        options = parse_doc.build_pipeline_options()
        self.assertTrue(options.do_picture_description)
        desc = options.picture_description_options
        self.assertIn(f"Bearer {secret}", desc.headers["Authorization"])


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
