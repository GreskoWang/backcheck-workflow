"""Bounded, read-only extraction and independent formula checks; never saves input."""
import csv
import datetime
import json
import math
import re
import sys
import zipfile
from pathlib import Path

MAX_CELLS = 50000
MAX_ROWS = 10000
MAX_COLUMNS = 1000


def plain(value):
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        return value.total_seconds()
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError('nonfinite_cell')
    return value


def colnum(value):
    result = 0
    for char in value.upper():
        result = result * 26 + ord(char) - 64
    return result


def colname(value):
    result = ''
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def flatten(items):
    for item in items:
        if isinstance(item, list):
            yield from flatten(item)
        else:
            yield item


def number(value):
    if value is None or value == '':
        return 0
    if isinstance(value, (int, float, bool)):
        return float(value)
    raise ValueError('non_numeric_formula_operand')


class Evaluator:
    def __init__(self, workbook):
        self.workbook = workbook
        self.cache = {}
        self.active = set()

    def cell(self, sheet, address):
        key = (sheet, address)
        if key in self.cache:
            return self.cache[key]
        if key in self.active:
            raise ValueError('circular_formula')
        self.active.add(key)
        value = self.workbook[sheet][address].value
        try:
            if isinstance(value, str) and value.startswith('='):
                value = self.formula(sheet, value)
            value = plain(value)
            self.cache[key] = value
            return value
        finally:
            self.active.remove(key)

    def reference(self, sheet, token):
        if '!' in token:
            sheet, token = token.rsplit('!', 1)
            sheet = sheet.strip("'").replace("''", "'")
            names = [name for name in self.workbook.sheetnames if name.casefold() == sheet.casefold()]
            if len(names) != 1:
                raise ValueError('unknown_formula_sheet')
            sheet = names[0]
        token = token.replace('$', '')
        match = re.fullmatch(r'([A-Za-z]{1,3})([1-9][0-9]*)(?::([A-Za-z]{1,3})([1-9][0-9]*))?', token)
        if not match:
            raise ValueError('unsupported_formula_reference')
        c1, r1 = colnum(match[1]), int(match[2])
        c2, r2 = (colnum(match[3]), int(match[4])) if match[3] else (c1, r1)
        if c1 > c2 or r1 > r2 or (c2 - c1 + 1) * (r2 - r1 + 1) > MAX_CELLS:
            raise ValueError('formula_range_limit')
        values = [self.cell(sheet, f'{colname(c)}{r}') for r in range(r1, r2 + 1) for c in range(c1, c2 + 1)]
        return values if match[3] else values[0]

    def formula(self, sheet, value):
        from openpyxl.formula.tokenizer import Tokenizer
        tokens = [t for t in Tokenizer(value).items if t.type != 'WHITE-SPACE']
        at = 0
        precedence = {'=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5}

        def expression(minimum=0):
            nonlocal at
            if at >= len(tokens):
                raise ValueError('incomplete_formula')
            token = tokens[at]
            at += 1
            if token.type == 'OPERATOR-PREFIX' and token.value in ('+', '-'):
                left = number(expression(6)) * (-1 if token.value == '-' else 1)
            elif token.type == 'OPERAND':
                if token.subtype == 'NUMBER':
                    left = float(token.value)
                elif token.subtype == 'TEXT':
                    left = token.value[1:-1].replace('""', '"')
                elif token.subtype == 'LOGICAL':
                    left = token.value.upper() == 'TRUE'
                elif token.subtype == 'RANGE':
                    left = self.reference(sheet, token.value)
                else:
                    raise ValueError('formula_error_operand')
            elif token.type == 'PAREN' and token.subtype == 'OPEN':
                left = expression()
                if at >= len(tokens) or tokens[at].type != 'PAREN' or tokens[at].subtype != 'CLOSE':
                    raise ValueError('invalid_formula_parenthesis')
                at += 1
            elif token.type == 'FUNC' and token.subtype == 'OPEN':
                name = token.value[:-1].upper()
                args = []
                if at < len(tokens) and tokens[at].subtype != 'CLOSE':
                    while True:
                        args.append(expression())
                        if at < len(tokens) and tokens[at].type == 'SEP' and tokens[at].subtype == 'ARG':
                            at += 1
                            continue
                        break
                if at >= len(tokens) or tokens[at].type != 'FUNC' or tokens[at].subtype != 'CLOSE':
                    raise ValueError('invalid_formula_function')
                at += 1
                values = list(flatten(args))
                nums = [float(v) for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
                if name == 'SUM': left = sum(nums)
                elif name == 'COUNT': left = len(nums)
                elif name == 'COUNTA': left = sum(v is not None and v != '' for v in values)
                elif name == 'AVERAGE':
                    if not nums: raise ValueError('formula_zero_division')
                    left = sum(nums) / len(nums)
                elif name == 'MIN': left = min(nums, default=0)
                elif name == 'MAX': left = max(nums, default=0)
                elif name == 'ROUND' and len(args) == 2:
                    digits = int(number(args[1]))
                    if abs(digits) > 12: raise ValueError('formula_precision_limit')
                    from decimal import Decimal, ROUND_HALF_UP
                    left = float(Decimal(str(number(args[0]))).quantize(Decimal('1').scaleb(-digits), rounding=ROUND_HALF_UP))
                elif name == 'COUNTIF' and len(args) == 2 and isinstance(args[0], list):
                    criterion = str(args[1])
                    test = re.fullmatch(r'(>=|<=|<>|>|<|=)?(-?[0-9]+(?:\.[0-9]+)?)', criterion)
                    if test:
                        op, target = test[1] or '=', float(test[2])
                        def matches(item):
                            if not isinstance(item, (int, float)): return False
                            return {'=': item == target, '<>': item != target, '>': item > target, '<': item < target,
                                    '>=': item >= target, '<=': item <= target}[op]
                        left = sum(matches(item) for item in args[0])
                    elif '*' not in criterion and '?' not in criterion:
                        left = sum(str(item or '').casefold() == criterion.casefold() for item in args[0])
                    else: raise ValueError('unsupported_countif_criterion')
                else:
                    raise ValueError('unsupported_formula_function:' + name)
            else:
                raise ValueError('unsupported_formula_token')
            while at < len(tokens):
                token = tokens[at]
                if token.type == 'OPERATOR-POSTFIX' and token.value == '%':
                    left = number(left) / 100
                    at += 1
                    continue
                if token.type != 'OPERATOR-INFIX' or token.value not in precedence or precedence[token.value] < minimum:
                    break
                op = token.value
                at += 1
                right = expression(precedence[op] + (0 if op == '^' else 1))
                if op == '&': left = str(left or '') + str(right or '')
                elif op in ('=', '<>', '<', '>', '<=', '>='):
                    left = {'=': lambda: left == right, '<>': lambda: left != right,
                            '<': lambda: left < right, '>': lambda: left > right,
                            '<=': lambda: left <= right, '>=': lambda: left >= right}[op]()
                else:
                    l, r = number(left), number(right)
                    if op == '+': left = l + r
                    elif op == '-': left = l - r
                    elif op == '*': left = l * r
                    elif op == '/': left = l / r
                    elif op == '^':
                        if abs(r) > 100: raise ValueError('formula_exponent_limit')
                        left = l ** r
            return left

        result = expression()
        if at != len(tokens) or isinstance(result, list):
            raise ValueError('unsupported_formula_result')
        return plain(result)


def read_xlsx(filename):
    import openpyxl
    with zipfile.ZipFile(filename) as archive:
        files = archive.infolist()
        if len(files) > 5000 or sum(info.file_size for info in files) > 128 * 1024 * 1024:
            raise ValueError('xlsx_archive_limit')
        if any('vbaProject' in info.filename or info.filename.startswith('xl/externalLinks/') for info in files):
            raise ValueError('active_or_external_workbook_content')
    workbook = openpyxl.load_workbook(filename, data_only=False, keep_links=False)
    cached = openpyxl.load_workbook(filename, data_only=True, keep_links=False)
    evaluator = Evaluator(workbook)
    sheets, issues, total = [], [], 0
    if len(workbook.worksheets) > 15:
        raise ValueError('worksheet_count_limit')
    for sheet in workbook.worksheets:
        if sheet.max_row > MAX_ROWS or sheet.max_column > MAX_COLUMNS or sheet.max_row * sheet.max_column > MAX_CELLS:
            raise ValueError('worksheet_size_limit')
        cells = []
        for row in sheet.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                total += 1
                if total > MAX_CELLS:
                    raise ValueError('workbook_cell_limit')
                entry = {'address': cell.coordinate, 'value': plain(cell.value), 'numberFormat': cell.number_format}
                if cell.data_type == 'e':
                    issues.append({'code': 'cell_error', 'sheet': sheet.title, 'cell': cell.coordinate})
                if cell.data_type == 'f':
                    entry['formula'] = cell.value
                    entry['cachedValue'] = plain(cached[sheet.title][cell.coordinate].value)
                    try:
                        computed = evaluator.cell(sheet.title, cell.coordinate)
                        entry['value'] = computed
                        entry['calculated'] = True
                        prior = entry['cachedValue']
                        if prior is not None and prior != computed and not (isinstance(prior, (int, float)) and
                           isinstance(computed, (int, float)) and abs(prior - computed) <= 1e-9 * max(1, abs(computed))):
                            issues.append({'code': 'formula_cache_mismatch', 'sheet': sheet.title, 'cell': cell.coordinate})
                    except Exception as exc:
                        entry['value'] = None
                        entry['calculated'] = False
                        issues.append({'code': 'formula_unverified', 'sheet': sheet.title, 'cell': cell.coordinate, 'detail': str(exc)[:150]})
                if cell.hyperlink:
                    entry['hyperlink'] = cell.hyperlink.target or cell.hyperlink.location
                if cell.comment:
                    entry['note'] = cell.comment.text
                cells.append(entry)
        sheets.append({'name': sheet.title, 'id': sheet.title, 'maxRow': sheet.max_row, 'maxColumn': sheet.max_column,
                       'hidden': sheet.sheet_state != 'visible', 'cells': cells,
                       'mergedRanges': [str(r) for r in sheet.merged_cells.ranges],
                       'hasDrawings': bool(sheet._charts or sheet._images)})
    workbook.close()
    cached.close()
    return {'kind': 'spreadsheet', 'format': 'xlsx', 'worksheets': sheets, 'issues': issues}


def read_csv(filename):
    cells, rows, columns = [], 0, 0
    with open(filename, encoding='utf-8-sig', newline='') as source:
        for r, row in enumerate(csv.reader(source), 1):
            rows, columns = r, max(columns, len(row))
            if rows > MAX_ROWS or columns > MAX_COLUMNS:
                raise ValueError('csv_size_limit')
            for c, value in enumerate(row, 1):
                if value == '': continue
                if value.startswith(('=', '@')) or (value.startswith(('+', '-')) and not re.fullmatch(r'[+-]?[0-9]+(?:\.[0-9]+)?', value)):
                    raise ValueError('csv_formula_text_unverified')
                number_value = float(value) if re.fullmatch(r'-?[0-9]+(?:\.[0-9]+)?', value) else value
                cells.append({'address': f'{colname(c)}{r}', 'value': plain(number_value)})
                if len(cells) > MAX_CELLS: raise ValueError('csv_cell_limit')
    return {'kind': 'spreadsheet', 'format': 'csv', 'worksheets': [{'name': 'Sheet1', 'id': 'Sheet1',
            'maxRow': rows, 'maxColumn': columns, 'hidden': False, 'cells': cells, 'mergedRanges': [], 'hasDrawings': False}], 'issues': []}


def read_grid_json(filename):
    from types import SimpleNamespace
    snapshot = json.loads(filename.read_text(encoding='utf-8-sig'))
    if snapshot.get('kind') != 'spreadsheet' or len(snapshot.get('worksheets', [])) > 15:
        raise ValueError('grid_snapshot_invalid')
    class Sheet:
        def __init__(self, cells): self.cells = {c['address']: c.get('formula', c.get('value')) for c in cells}
        def __getitem__(self, address): return SimpleNamespace(value=self.cells.get(address))
    class Book:
        def __init__(self, sheets):
            self.sheets = {}
            for sheet in sheets:
                wrapper = Sheet(sheet['cells'])
                for name in {sheet['id'], sheet['name']}:
                    if name in self.sheets: raise ValueError('grid_sheet_identity_ambiguous')
                    self.sheets[name] = wrapper
            self.sheetnames = list(self.sheets)
        def __getitem__(self, name): return self.sheets[name]
    evaluator = Evaluator(Book(snapshot['worksheets']))
    issues = list(snapshot.get('issues', []))
    for sheet in snapshot['worksheets']:
        for cell in sheet['cells']:
            if not cell.get('formula'): continue
            try:
                computed = evaluator.cell(sheet['id'], cell['address'])
                prior = cell.get('value')
                cell['value'], cell['calculated'] = computed, True
                if prior is not None and prior != computed and not (isinstance(prior, (int, float)) and
                   isinstance(computed, (int, float)) and abs(prior-computed) <= 1e-9 * max(1,abs(computed))):
                    issues.append({'code':'formula_cache_mismatch','sheet':sheet['id'],'cell':cell['address']})
            except Exception as exc:
                cell['calculated'] = False
                issues.append({'code':'formula_unverified','sheet':sheet['id'],'cell':cell['address'],'detail':str(exc)[:150]})
    snapshot['issues'] = issues
    return snapshot


if __name__ == '__main__':
    try:
        filename = Path(sys.argv[1])
        if filename.stat().st_size > 32 * 1024 * 1024: raise ValueError('artifact_size_limit')
        if len(sys.argv) > 2 and sys.argv[2] == '--grid-json': result = read_grid_json(filename)
        elif filename.suffix.lower() == '.xlsx': result = read_xlsx(filename)
        elif filename.suffix.lower() == '.csv': result = read_csv(filename)
        else: raise ValueError('unsupported_artifact_type')
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except Exception as exc:
        print(json.dumps({'error': str(exc)[:200]}, ensure_ascii=False))
        sys.exit(1)
