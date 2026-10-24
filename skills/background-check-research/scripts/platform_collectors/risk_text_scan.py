#!/usr/bin/env python3
"""Find context-review candidates in CSV/JSONL text using task-specific terms."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ReadResult:
    rows: list[tuple[int, dict[str, object]]]
    decode_error_count: int
    parse_error_count: int
    errors: list[str]


def _sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def load_terms(path: Path) -> tuple[list[str], str]:
    """Load exactly the supplied UTF-8 term file and return its raw-file hash."""
    raw = path.read_bytes()
    text = raw.decode("utf-8-sig", errors="strict")
    terms: list[str] = []
    seen: set[str] = set()
    for line in text.splitlines():
        term = line.strip()
        if not term or term.startswith("#"):
            continue
        key = term.casefold()
        if key not in seen:
            seen.add(key)
            terms.append(term)
    if not terms:
        raise ValueError("terms file contains no non-comment terms")
    return terms, _sha256_bytes(raw)


def _decode_input(path: Path) -> tuple[str | None, int, list[str]]:
    try:
        return path.read_bytes().decode("utf-8-sig", errors="strict"), 0, []
    except UnicodeDecodeError as exc:
        return None, 1, [f"input UTF-8 decode error at byte {exc.start}: {exc.reason}"]


def rows_from_csv(path: Path) -> ReadResult:
    text, decode_errors, errors = _decode_input(path)
    if text is None:
        return ReadResult([], decode_errors, 0, errors)
    rows: list[tuple[int, dict[str, object]]] = []
    parse_errors = 0
    try:
        reader = csv.DictReader(io.StringIO(text, newline=""), strict=True)
        if not reader.fieldnames or any(not str(field or "").strip() for field in reader.fieldnames):
            return ReadResult([], 0, 1, ["CSV requires a non-empty header row"])
        for row_number, row in enumerate(reader, start=2):
            if None in row:
                parse_errors += 1
                errors.append(f"CSV row {row_number} has more values than header fields")
                continue
            rows.append((row_number, dict(row)))
    except csv.Error as exc:
        parse_errors += 1
        errors.append(f"CSV parse error: {exc}")
    return ReadResult(rows, 0, parse_errors, errors)


def rows_from_jsonl(path: Path) -> ReadResult:
    text, decode_errors, errors = _decode_input(path)
    if text is None:
        return ReadResult([], decode_errors, 0, errors)
    rows: list[tuple[int, dict[str, object]]] = []
    parse_errors = 0
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            parse_errors += 1
            errors.append(f"JSONL line {line_number} column {exc.colno}: {exc.msg}")
            continue
        if not isinstance(value, dict):
            parse_errors += 1
            errors.append(f"JSONL line {line_number}: row must be an object")
            continue
        rows.append((line_number, value))
    return ReadResult(rows, 0, parse_errors, errors)


def load_rows(path: Path) -> ReadResult:
    suffix = path.suffix.lower()
    if suffix == ".jsonl":
        return rows_from_jsonl(path)
    if suffix == ".csv":
        return rows_from_csv(path)
    return ReadResult([], 0, 1, ["input must use .csv or .jsonl extension"])


def scan_rows(
    rows: list[tuple[int, dict[str, object]]],
    terms: list[str],
    text_fields: list[str],
    id_fields: list[str],
    source_file: Path,
) -> list[dict[str, object]]:
    hits: list[dict[str, object]] = []
    for row_number, row in rows:
        text = " ".join(str(row.get(field, "")) for field in text_fields)
        folded = text.casefold()
        for term in terms:
            if term.casefold() in folded:
                hit: dict[str, object] = {
                    "row_index": row_number,
                    "term": term,
                    "text": text[:2000],
                    "source_file": str(source_file),
                }
                for field in id_fields:
                    hit[field] = row.get(field, "")
                hits.append(hit)
    return hits


def write_hits(path: Path, hits: list[dict[str, object]], id_fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = list(dict.fromkeys(["row_index", "term", *id_fields, "text", "source_file"]))
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(hits)


def execute_scan(
    input_path: Path,
    terms_path: Path,
    out_csv: Path,
    text_fields: list[str],
    id_fields: list[str],
) -> dict[str, object]:
    errors: list[str] = []
    decode_error_count = 0
    parse_error_count = 0
    terms: list[str] = []
    terms_sha256 = ""
    try:
        raw_terms = terms_path.read_bytes()
        terms_sha256 = _sha256_bytes(raw_terms)
        terms, _verified_sha = load_terms(terms_path)
    except UnicodeDecodeError as exc:
        decode_error_count += 1
        errors.append(f"terms UTF-8 decode error at byte {exc.start}: {exc.reason}")
    except (OSError, ValueError) as exc:
        parse_error_count += 1
        errors.append(f"terms error: {exc}")

    try:
        read_result = load_rows(input_path)
    except OSError as exc:
        read_result = ReadResult([], 0, 1, [f"input error: {exc}"])
    decode_error_count += read_result.decode_error_count
    parse_error_count += read_result.parse_error_count
    errors.extend(read_result.errors)

    hits = scan_rows(read_result.rows, terms, text_fields, id_fields, input_path) if terms else []
    write_hits(out_csv, hits, id_fields)
    exit_code = 2 if decode_error_count or parse_error_count else 0
    return {
        "status": "invalid_input" if exit_code else "ok",
        "input": str(input_path),
        "rows_scanned": len(read_result.rows),
        "terms_file": str(terms_path),
        "terms_file_sha256": terms_sha256,
        "terms_count": len(terms),
        "decode_error_count": decode_error_count,
        "parse_error_count": parse_error_count,
        "errors": errors,
        "hits": len(hits),
        "out_csv": str(out_csv),
        "exit_code": exit_code,
    }


def run_self_test() -> int:
    failures: list[str] = []
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        terms_path = root / "terms.txt"
        terms_path.write_text("自定义风险词\n# comment\n自定义风险词\n", encoding="utf-8")
        valid_input = root / "valid.jsonl"
        valid_input.write_text(
            json.dumps({"url": "https://example.test/1", "text": "含自定义风险词"}, ensure_ascii=False)
            + "\n"
            + json.dumps({"url": "https://example.test/2", "text": "台独"}, ensure_ascii=False)
            + "\n",
            encoding="utf-8",
        )
        fields = ["text"]
        ids = ["url"]
        valid = execute_scan(valid_input, terms_path, root / "valid.csv", fields, ids)
        if valid["exit_code"] != 0 or valid["terms_count"] != 1 or valid["hits"] != 1:
            failures.append("exact-term-file-success")
        expected_hash = _sha256_bytes(terms_path.read_bytes())
        if valid["terms_file_sha256"] != expected_hash:
            failures.append("term-file-sha256")

        malformed_input = root / "malformed.jsonl"
        malformed_input.write_text(
            "{bad json}\n" + json.dumps({"text": "自定义风险词"}, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        malformed = execute_scan(malformed_input, terms_path, root / "malformed.csv", fields, ids)
        if malformed["exit_code"] == 0 or malformed["parse_error_count"] != 1:
            failures.append("malformed-json-must-fail")

        invalid_utf8 = root / "invalid.jsonl"
        invalid_utf8.write_bytes(b"\xff\xfe\n")
        undecodable = execute_scan(invalid_utf8, terms_path, root / "invalid.csv", fields, ids)
        if undecodable["exit_code"] == 0 or undecodable["decode_error_count"] != 1:
            failures.append("invalid-utf8-must-fail")

        invalid_terms = root / "invalid-terms.txt"
        invalid_terms.write_bytes(b"\xff")
        bad_terms = execute_scan(valid_input, invalid_terms, root / "bad-terms.csv", fields, ids)
        if bad_terms["exit_code"] == 0 or bad_terms["decode_error_count"] != 1:
            failures.append("invalid-term-utf8-must-fail")

    print(json.dumps({"self_test": "failed" if failures else "passed", "failures": failures}, ensure_ascii=False))
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Find text candidates for manual context review; hits are not risk findings and zero hits are not a conclusion."
    )
    parser.add_argument("--input", type=Path)
    parser.add_argument("--out-csv", type=Path)
    parser.add_argument(
        "--terms",
        type=Path,
        help="UTF-8 newline-delimited task-specific candidate terms selected from the subject profile and observed signals; do not pass the complete risk glossary",
    )
    parser.add_argument("--text-fields", default="full_text,text,title,description,message,comment,content")
    parser.add_argument("--id-fields", default="tweet_id,video_id,bvid,url")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return run_self_test()
    if args.input is None or args.terms is None or args.out_csv is None:
        parser.error("--input, --terms, and --out-csv are required")
    if not args.input.is_file():
        parser.error(f"--input file does not exist: {args.input}")
    if not args.terms.is_file():
        parser.error(f"--terms file does not exist: {args.terms}")
    text_fields = [x.strip() for x in args.text_fields.split(",") if x.strip()]
    id_fields = [x.strip() for x in args.id_fields.split(",") if x.strip()]
    if not text_fields:
        parser.error("--text-fields must contain at least one field")
    summary = execute_scan(args.input, args.terms, args.out_csv, text_fields, id_fields)
    print(json.dumps(summary, ensure_ascii=False))
    return int(summary["exit_code"])


if __name__ == "__main__":
    raise SystemExit(main())
