"""Deterministic PDF text extraction with page numbers (pdfplumber, MIT). No OCR, no model."""

from __future__ import annotations

from pathlib import Path


def extract_pages(path: Path | str, *, max_pages: int | None = None) -> tuple[list[dict], str]:
    """Return ([{page, text}], status). status in extracted | extraction_failed | no_text."""
    try:
        import pdfplumber  # imported lazily so tests that never touch PDFs stay fast
    except ImportError:  # pragma: no cover
        return [], "extraction_failed: pdfplumber not installed"
    pages: list[dict] = []
    try:
        with pdfplumber.open(str(path)) as pdf:
            for i, page in enumerate(pdf.pages, start=1):
                if max_pages and i > max_pages:
                    break
                text = page.extract_text() or ""
                pages.append({"page": i, "text": text})
    except Exception as e:  # corrupt or encrypted file: record, do not crash the run
        return pages, f"extraction_failed: {type(e).__name__}: {e}"[:300]
    if not any(p["text"].strip() for p in pages):
        return pages, "no_text"
    return pages, "extracted"
