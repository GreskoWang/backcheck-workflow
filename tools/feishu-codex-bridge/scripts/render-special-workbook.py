"""Read-only cell-layout renderer when the bundled native renderer is unavailable.

Only supported, fully inspected workbook features are rendered. Unsupported visual
features fail closed instead of being silently flattened. No workbook is saved.
"""
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys
from xml.etree import ElementTree

from PIL import Image, ImageDraw, ImageFont
import openpyxl
from openpyxl.styles.colors import COLOR_INDEX
from openpyxl.utils.cell import range_boundaries, get_column_letter


def load_reader():
    spec = importlib.util.spec_from_file_location('special_workbook_reader', Path(__file__).with_name('read-special-workbook.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def color_value(color, theme, default):
    if color is None or color.type == 'auto': return default
    if color.type == 'rgb': rgb = color.rgb[-6:]
    elif color.type == 'indexed':
        if not isinstance(color.indexed, int) or color.indexed >= 64: return default
        rgb = COLOR_INDEX[color.indexed][-6:]
    elif color.type == 'theme':
        if not isinstance(color.theme, int) or color.theme >= len(theme): raise ValueError('render_unknown_theme_color')
        rgb = theme[color.theme]
    else: raise ValueError('render_unknown_color')
    if not re.fullmatch('[0-9A-Fa-f]{6}', rgb): raise ValueError('render_invalid_color')
    channels = [int(rgb[i:i+2], 16) for i in (0, 2, 4)]
    tint = color.tint or 0
    channels = [round(c * (1 + tint) if tint < 0 else c * (1-tint) + 255*tint) for c in channels]
    return tuple(max(0, min(c, 255)) for c in channels)


def theme_colors(workbook):
    colors = []
    if workbook.loaded_theme:
        root = ElementTree.fromstring(workbook.loaded_theme)
        scheme = root.find('.//{http://schemas.openxmlformats.org/drawingml/2006/main}clrScheme')
        if scheme is not None:
            for slot in scheme:
                value = next(iter(slot))
                colors.append(value.get('lastClr') or value.get('val'))
    # OOXML color indexes use light1,dark1,light2,dark2, although the XML lists dark first.
    if len(colors) >= 4: colors[:4] = [colors[1], colors[0], colors[3], colors[2]]
    return colors


def font_for(cell, text):
    font = cell.font
    if font.vertAlign or font.outline or font.shadow: raise ValueError('render_unsupported_font_effect')
    font_directory = os.environ.get('BACKCHECK_FONTS_DIR')
    system_root = os.environ.get('WINDIR') or os.environ.get('SystemRoot')
    if not font_directory and not system_root: raise ValueError('render_font_directory_unconfigured')
    fonts = Path(font_directory) if font_directory else Path(system_root) / 'Fonts'
    if not fonts.is_absolute(): raise ValueError('render_font_directory_not_absolute')
    cjk = any(ord(c) > 255 for c in text)
    name = (font.name or 'Calibri').lower()
    if cjk:
        candidates = ['msyhbd.ttc' if font.b else 'msyh.ttc', 'simsun.ttc']
    else:
        families = {'calibri':'calibri','arial':'arial','aptos':'aptos','times new roman':'times','consolas':'consola',
                    'microsoft yahei':'msyh','微软雅黑':'msyh','宋体':'simsun'}
        stem = families.get(name)
        if not stem: raise ValueError('render_unsupported_font_family')
        suffix = 'bi' if font.b and font.i else 'b' if font.b else 'i' if font.i else ''
        # Windows Times New Roman uses timesbd/timesbi; CJK faces use TTC.
        if stem == 'times' and font.b and not font.i: suffix = 'bd'
        if stem in ('msyh', 'simsun'):
            candidates = [stem + ('bd' if font.b and stem == 'msyh' else '') + '.ttc']
        else: candidates = [stem + suffix + '.ttf']
    target = next((fonts / candidate for candidate in candidates if (fonts / candidate).is_file()), None)
    if target is None: raise ValueError('render_font_unavailable')
    return ImageFont.truetype(str(target), max(8, round((font.sz or 11) * 96 / 72)))


def display_value(value, number_format):
    if value is None: return ''
    if isinstance(value, bool): return 'TRUE' if value else 'FALSE'
    if isinstance(value, str): return value
    if not isinstance(value, (int, float)) or not math.isfinite(value): raise ValueError('render_value_unsupported')
    fmt = number_format or 'General'
    if fmt.lower() == 'general': return str(int(value)) if value == int(value) else format(value, '.12g')
    if fmt == '@': return str(value)
    if re.fullmatch(r'(?:#,##)?0(?:\.0+)?%?', fmt):
        decimals = len(fmt.partition('.')[2].rstrip('%')) if '.' in fmt else 0
        scaled = value * (100 if fmt.endswith('%') else 1)
        return format(scaled, (',' if ',' in fmt else '') + '.' + str(decimals) + 'f') + ('%' if fmt.endswith('%') else '')
    if fmt in ('[h]:mm:ss', '[hh]:mm:ss', '[mm]:ss', 'mm:ss', 'h:mm:ss', 'hh:mm:ss'):
        seconds = round(value * 86400)
        if seconds < 0: raise ValueError('render_negative_elapsed_time')
        if fmt in ('[mm]:ss', 'mm:ss'): return f'{seconds//60:02d}:{seconds%60:02d}'
        return f'{seconds//3600:02d}:{seconds//60%60:02d}:{seconds%60:02d}'
    raise ValueError('render_unsupported_number_format')


def render(input_path, request_path, output_directory):
    snapshot = load_reader().read_xlsx(input_path)
    if snapshot['issues']: raise ValueError('render_workbook_checks_failed')
    request = json.loads(Path(request_path).read_text(encoding='utf-8-sig'))
    ranges = request.get('ranges')
    if not isinstance(ranges, list) or not 1 <= len(ranges) <= 40: raise ValueError('render_range_limit')
    workbook = openpyxl.load_workbook(input_path, data_only=False, keep_links=False)
    theme = theme_colors(workbook)
    values = {s['name']: {c['address']: c['value'] for c in s['cells']} for s in snapshot['worksheets']}
    output = Path(output_directory)
    output.mkdir(parents=True, exist_ok=True)
    rendered = []
    for index, view in enumerate(ranges):
        sheet = workbook[view['sheetName']]
        if (sheet._charts or sheet._images or sheet.conditional_formatting or sheet.sheet_state != 'visible' or
            sheet.sheet_view.rightToLeft or sheet.auto_filter.ref or sheet.tables):
            raise ValueError('render_unsupported_visual_feature')
        if view.get('autoCrop') or not re.fullmatch(r'[A-Z]+[1-9][0-9]*:[A-Z]+[1-9][0-9]*', view.get('range', '')):
            raise ValueError('render_unsupported_range')
        min_col, min_row, max_col, max_row = range_boundaries(view['range'])
        if max_col - min_col > 100 or max_row - min_row > 100: raise ValueError('render_range_limit')
        merges = [merged for merged in sheet.merged_cells.ranges
                  if merged.max_col >= min_col and merged.min_col <= max_col and merged.max_row >= min_row and merged.min_row <= max_row]
        if any(merged.min_col < min_col or merged.max_col > max_col or merged.min_row < min_row or merged.max_row > max_row for merged in merges):
            raise ValueError('render_merge_crosses_tile')
        xs, ys = [40], [32]
        for column in range(min_col, max_col+1):
            dimension = sheet.column_dimensions.get(get_column_letter(column))
            if dimension and dimension.hidden: raise ValueError('render_hidden_columns')
            width = dimension.width if dimension and dimension.width else sheet.sheet_format.defaultColWidth or 8.43
            xs.append(xs[-1] + max(1, round(width * 7 + 5)))
        for row in range(min_row, max_row+1):
            dimension = sheet.row_dimensions.get(row)
            if dimension and dimension.hidden: raise ValueError('render_hidden_rows')
            height = dimension.height if dimension and dimension.height else sheet.sheet_format.defaultRowHeight or 15
            ys.append(ys[-1] + max(1, round(height * 96 / 72)))
        if xs[-1] > 10000 or ys[-1] > 10000 or xs[-1] * ys[-1] > 16_000_000: raise ValueError('render_pixel_limit')
        image = Image.new('RGB', (xs[-1]+1, ys[-1]+1), 'white')
        draw = ImageDraw.Draw(image)
        label_font = ImageFont.load_default()
        draw.text((4, 5), 'Cell layout preview', fill='black', font=label_font)
        for c in range(min_col, max_col+1): draw.text((xs[c-min_col]+3, 18), get_column_letter(c), fill='black', font=label_font)
        for r in range(min_row, max_row+1): draw.text((3, ys[r-min_row]+2), str(r), fill='black', font=label_font)
        for row in sheet.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col):
            for cell in row:
                merge = next((m for m in merges if m.min_row <= cell.row <= m.max_row and m.min_col <= cell.column <= m.max_col), None)
                if merge and (cell.row != merge.min_row or cell.column != merge.min_col): continue
                left, top = xs[cell.column-min_col], ys[cell.row-min_row]
                right, bottom = xs[(merge.max_col if merge else cell.column)-min_col+1], ys[(merge.max_row if merge else cell.row)-min_row+1]
                if cell.fill.patternType not in (None, 'solid'): raise ValueError('render_unsupported_fill')
                background = color_value(cell.fill.fgColor, theme, (255,255,255)) if cell.fill.patternType == 'solid' else (255,255,255)
                draw.rectangle((left,top,right,bottom), fill=background, outline=(210,210,210))
                if cell.alignment.textRotation or cell.alignment.shrinkToFit or cell.alignment.readingOrder: raise ValueError('render_unsupported_alignment')
                if cell.border.diagonalUp or cell.border.diagonalDown: raise ValueError('render_unsupported_border')
                for side_name, points in [('left',(left,top,left,bottom)),('right',(right,top,right,bottom)),('top',(left,top,right,top)),('bottom',(left,bottom,right,bottom))]:
                    side = getattr(cell.border,side_name)
                    if side and side.style:
                        if side.style not in ('thin','medium','thick','hair'): raise ValueError('render_unsupported_border')
                        draw.line(points,fill=color_value(side.color,theme,(0,0,0)),width={'medium':2,'thick':3}.get(side.style,1))
                value = values[sheet.title].get(cell.coordinate)
                text = display_value(value,cell.number_format)
                if not text: continue
                font = font_for(cell,text)
                foreground = color_value(cell.font.color,theme,(0,0,0))
                usable_width = right-left-6-round((cell.alignment.indent or 0)*8)
                if usable_width < 1: raise ValueError('render_cell_too_small')
                lines = []
                for paragraph in text.split('\n'):
                    if cell.alignment.wrapText:
                        current = ''
                        for char in paragraph:
                            if current and draw.textlength(current+char,font=font) > usable_width:
                                lines.append(current); current = char
                            else: current += char
                        lines.append(current)
                    else: lines.append(paragraph)
                line_height = sum(font.getmetrics())
                content_height = line_height*len(lines)
                vertical = cell.alignment.vertical or 'bottom'
                if vertical not in ('bottom','center','top'): raise ValueError('render_unsupported_alignment')
                offset_y = 2 if vertical=='top' else max(1,(bottom-top-content_height)//2) if vertical=='center' else max(1,bottom-top-content_height-2)
                canvas = Image.new('RGBA',(right-left-2,bottom-top-2),(0,0,0,0))
                text_draw = ImageDraw.Draw(canvas)
                horizontal = cell.alignment.horizontal or ('right' if isinstance(value,(int,float)) and not isinstance(value,bool) else 'left')
                if horizontal not in ('left','right','center','general'): raise ValueError('render_unsupported_alignment')
                for line_index, line in enumerate(lines):
                    length = text_draw.textlength(line,font=font)
                    offset_x = 2+round((cell.alignment.indent or 0)*8) if horizontal in ('left','general') else max(1,right-left-length-5) if horizontal=='right' else max(1,(right-left-length)//2)
                    y = offset_y + line_index*line_height
                    text_draw.text((offset_x,y),line,font=font,fill=foreground,anchor='lt')
                    if cell.font.u: text_draw.line((offset_x,y+line_height-3,offset_x+length,y+line_height-3),fill=foreground,width=1)
                    if cell.font.strike: text_draw.line((offset_x,y+line_height//2,offset_x+length,y+line_height//2),fill=foreground,width=1)
                image.paste(canvas,(left+1,top+1),canvas)
        target = output / f'view-{index+1}.png'
        image.save(target,format='PNG')
        rendered.append({'id':f'view-{index+1}','path':str(target),'sheet':sheet.title,'range':view['range'],
                         'engine':'openpyxl-pillow-supported-cell-layout','sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
    workbook.close()
    return {'renders':rendered}


if __name__ == '__main__':
    try:
        print(json.dumps(render(*sys.argv[1:4]),ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error':str(exc)[:160]},ensure_ascii=False))
        sys.exit(1)
