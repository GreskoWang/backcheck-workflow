#!/usr/bin/env python3
"""Lightweight source artifact probe.

Prints JSON describing directories and common source files without modifying them.
Designed for Windows/Codex workflows where paths and encodings may be fragile.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
from pathlib import Path
import sys
import zipfile
import xml.etree.ElementTree as ET


TEXT_EXTS = {
    ".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".html", ".htm",
    ".yaml", ".yml", ".py", ".js", ".mjs", ".ts", ".tsx", ".css", ".scss",
}


def iso_mtime(path: Path) -> str:
    return dt.datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")


def try_decode(data: bytes):
    for enc in ("utf-8-sig", "utf-8", "utf-16", "gb18030"):
        try:
            return enc, data.decode(enc)
        except UnicodeDecodeError:
            pass
    return None, data.decode("utf-8", errors="replace")


def file_base(path: Path) -> dict:
    stat = path.stat()
    return {
        "path": str(path),
        "name": path.name,
        "extension": path.suffix.lower(),
        "size_bytes": stat.st_size,
        "modified": iso_mtime(path),
    }


def probe_text(path: Path, max_bytes: int) -> dict:
    data = path.read_bytes()[:max_bytes]
    enc, text = try_decode(data)
    lines = text.splitlines()
    result = {
        "kind": "text",
        "encoding_guess": enc,
        "sample_bytes": len(data),
        "line_count_sample": len(lines),
        "replacement_chars_sample": text.count("\ufffd"),
    }
    if path.suffix.lower() in {".md", ".markdown"}:
        result["headings_sample"] = [
            {"line": idx + 1, "text": line.strip()}
            for idx, line in enumerate(lines)
            if line.lstrip().startswith("#")
        ][:50]
    if path.suffix.lower() in {".csv", ".tsv"} and lines:
        delim = "\t" if path.suffix.lower() == ".tsv" else ","
        rows = list(csv.reader(lines[:20], delimiter=delim))
        result["csv_sample_rows"] = len(rows)
        result["csv_sample_columns"] = max((len(row) for row in rows), default=0)
        result["csv_header_sample"] = rows[0] if rows else []
    return result


def probe_xlsx(path: Path) -> dict:
    result = {"kind": "excel"}
    try:
        import openpyxl  # type: ignore
    except Exception as exc:
        result["error"] = f"openpyxl unavailable: {exc}"
        return result
    wb = openpyxl.load_workbook(path, read_only=True, data_only=False)
    sheets = []
    for ws in wb.worksheets:
        header = []
        for row in ws.iter_rows(min_row=1, max_row=1, values_only=True):
            header = [str(cell) if cell is not None else "" for cell in row]
            break
        sheets.append({
            "name": ws.title,
            "max_row": ws.max_row,
            "max_column": ws.max_column,
            "header_sample": header[:50],
        })
    wb.close()
    result["sheets"] = sheets
    return result


def text_from_word_xml(xml_bytes: bytes) -> list[str]:
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    root = ET.fromstring(xml_bytes)
    paragraphs = []
    for para in root.findall(".//w:p", ns):
        texts = [node.text or "" for node in para.findall(".//w:t", ns)]
        joined = "".join(texts).strip()
        if joined:
            paragraphs.append(joined)
    return paragraphs


def probe_docx(path: Path) -> dict:
    result = {"kind": "docx"}
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        result["zip_members"] = len(names)
        result["has_document_xml"] = "word/document.xml" in names
        result["image_count"] = sum(1 for n in names if n.startswith("word/media/"))
        if "word/document.xml" in names:
            xml_bytes = zf.read("word/document.xml")
            paras = text_from_word_xml(xml_bytes)
            result["paragraph_count_nonempty"] = len(paras)
            result["paragraph_sample"] = paras[:20]
            result["table_count_approx"] = xml_bytes.count(b"<w:tbl")
        if "word/styles.xml" in names:
            styles = zf.read("word/styles.xml").decode("utf-8", errors="ignore")
            result["style_count_approx"] = styles.count("<w:style")
    return result


def probe_zip(path: Path) -> dict:
    result = {"kind": "zip"}
    with zipfile.ZipFile(path) as zf:
        infos = zf.infolist()
        result["member_count"] = len(infos)
        result["members_sample"] = [
            {"filename": info.filename, "size": info.file_size}
            for info in infos[:50]
        ]
    return result


def probe_pdf(path: Path) -> dict:
    result = {"kind": "pdf"}
    data = path.read_bytes()[:2048]
    result["header"] = data[:16].decode("latin1", errors="replace")
    try:
        import pypdf  # type: ignore
        reader = pypdf.PdfReader(str(path))
        result["page_count"] = len(reader.pages)
        result["metadata"] = {str(k): str(v) for k, v in (reader.metadata or {}).items()}
    except Exception as exc:
        result["pypdf_note"] = f"page count unavailable: {exc}"
    return result


def probe_binary(path: Path) -> dict:
    data = path.read_bytes()[:64]
    return {
        "kind": "binary",
        "signature_hex": data[:16].hex(" "),
        "signature_latin1": data[:16].decode("latin1", errors="replace"),
    }


def probe_file(path: Path, max_bytes: int) -> dict:
    result = file_base(path)
    ext = path.suffix.lower()
    try:
        if ext in {".xlsx", ".xlsm", ".xltx", ".xltm"}:
            result.update(probe_xlsx(path))
        elif ext == ".docx":
            result.update(probe_docx(path))
        elif ext == ".pdf":
            result.update(probe_pdf(path))
        elif ext == ".zip":
            result.update(probe_zip(path))
        elif ext in TEXT_EXTS:
            result.update(probe_text(path, max_bytes))
        else:
            result.update(probe_binary(path))
    except Exception as exc:
        result["kind"] = result.get("kind", "unknown")
        result["error"] = repr(exc)
    return result


def probe_dir(path: Path, max_files: int, max_bytes: int) -> dict:
    files = [p for p in path.rglob("*") if p.is_file()]
    ext_counts = {}
    for p in files:
        key = p.suffix.lower() or "<none>"
        ext_counts[key] = ext_counts.get(key, 0) + 1
    samples = sorted(files, key=lambda p: (p.suffix.lower(), str(p).lower()))[:max_files]
    return {
        "path": str(path),
        "kind": "directory",
        "file_count": len(files),
        "extension_counts": dict(sorted(ext_counts.items())),
        "samples": [probe_file(p, max_bytes) for p in samples],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe source artifact structure.")
    parser.add_argument("paths", nargs="+", help="Files or directories to inspect.")
    parser.add_argument("--out", help="Optional JSON output path.")
    parser.add_argument("--max-files", type=int, default=40, help="Directory sample file limit.")
    parser.add_argument("--max-bytes", type=int, default=1_000_000, help="Bytes to sample for text files.")
    args = parser.parse_args()

    probes = []
    for raw in args.paths:
        path = Path(raw).expanduser()
        if not path.exists():
            probes.append({"path": str(path), "error": "not found"})
        elif path.is_dir():
            probes.append(probe_dir(path, args.max_files, args.max_bytes))
        else:
            probes.append(probe_file(path, args.max_bytes))

    payload = {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "cwd": os.getcwd(),
        "probes": probes,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
