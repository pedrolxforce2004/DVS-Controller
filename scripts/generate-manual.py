"""Build the public PDF from the single Markdown source (ReportLab)."""
from pathlib import Path
import re
from html import escape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Preformatted, ListFlowable, ListItem

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'docs' / 'DVS-Controller-0.6.8-Manual.pdf'
font_dir = Path('C:/Windows/Fonts')
if (font_dir / 'arial.ttf').exists():
    pdfmetrics.registerFont(TTFont('Body', str(font_dir / 'arial.ttf')))
    pdfmetrics.registerFont(TTFont('Body-Bold', str(font_dir / 'arialbd.ttf')))
    pdfmetrics.registerFontFamily('Body', normal='Body', bold='Body-Bold', italic='Body', boldItalic='Body-Bold')
else:
    pdfmetrics.registerFontFamily('Body', normal='Helvetica', bold='Helvetica-Bold', italic='Helvetica-Oblique', boldItalic='Helvetica-BoldOblique')

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='Text', fontName='Body', fontSize=10, leading=15, spaceAfter=8, textColor=colors.HexColor('#26364a')))
styles.add(ParagraphStyle(name='Section', parent=styles['Text'], fontName='Body-Bold', fontSize=17, leading=21, spaceBefore=18, spaceAfter=11, keepWithNext=True, textColor=colors.HexColor('#123b55')))
styles.add(ParagraphStyle(name='Sub', parent=styles['Text'], fontName='Body-Bold', fontSize=12, leading=17, spaceBefore=10, keepWithNext=True))
styles.add(ParagraphStyle(name='Cell', parent=styles['Text'], fontSize=9, leading=13, spaceAfter=0))
styles.add(ParagraphStyle(name='Cover', parent=styles['Section'], fontSize=38, leading=43))
styles.add(ParagraphStyle(name='Deck', parent=styles['Text'], fontSize=16, leading=24))
styles.add(ParagraphStyle(name='CodeBlock', parent=styles['Text'], fontName='Courier', fontSize=9, leading=14, leftIndent=8, rightIndent=8, backColor=colors.HexColor('#f1f5f9'), borderPadding=8, spaceBefore=4, spaceAfter=10))

def inline(text):
    return re.sub(r'`([^`]+)`', lambda m: '<b>' + m.group(1) + '</b>', escape(text))

story = [Spacer(1, 30*mm), Paragraph('DECODE / DVS', styles['Sub']), Spacer(1, 12*mm), Paragraph('DVS Controller', styles['Cover']), Paragraph('Manual de producao<br/>Versao 0.6.8', styles['Deck']), Spacer(1, 12*mm), Paragraph('Instalacao - atualizacao - operacao<br/>LG webOS / Samsung Tizen / Android TV', styles['Deck']), Spacer(1, 16*mm), Paragraph('30 de setembro de 2026', styles['Text']), Paragraph('Guia tecnico para infraestrutura, implantacao e operacao da versao 0.6.8.', styles['Text']), PageBreak()]
lines = (ROOT / 'docs' / 'MANUAL-0.6.8.md').read_text(encoding='utf-8').splitlines()
i = 0
while i < len(lines):
    line = lines[i].strip()
    if line.startswith('```'):
        i += 1
        code_lines = []
        while i < len(lines) and not lines[i].strip().startswith('```'):
            code_lines.append(lines[i].rstrip())
            i += 1
        story.append(Preformatted('\n'.join(code_lines), styles['CodeBlock']))
        i += 1
        continue
    if not line or line == '# DVS Controller' or line.startswith('## Manual de produção'):
        i += 1; continue
    if line.startswith('- ') or re.match(r'^\d+\.\s', line):
        list_lines = []
        ordered = bool(re.match(r'^\d+\.\s', line))
        while i < len(lines):
            candidate = lines[i].strip()
            if ordered and not re.match(r'^\d+\.\s', candidate): break
            if not ordered and not candidate.startswith('- '): break
            content = re.sub(r'^\d+\.\s+', '', candidate) if ordered else candidate[2:]
            list_lines.append(inline(content))
            i += 1
        list_items = [ListItem(Paragraph(item, styles['Text']), leftIndent=16) for item in list_lines]
        story.append(ListFlowable(list_items, bulletType='1' if ordered else 'bullet', start='1' if ordered else '-', leftIndent=16, bulletFontName='Body', bulletFontSize=10, spaceAfter=9))
        continue
    if line.startswith('|'):
        rows = []
        while i < len(lines) and lines[i].strip().startswith('|'):
            values = [v.strip() for v in lines[i].strip().strip('|').split('|')]
            if not all(re.fullmatch(r'[-: ]+', v) for v in values):
                rows.append([Paragraph(inline(v), styles['Cell']) for v in values])
            i += 1
        count = len(rows[0])
        widths = [50*mm, 120*mm] if count == 2 else [58*mm, 52*mm, 60*mm]
        table = Table(rows, colWidths=widths, repeatRows=1, hAlign='LEFT')
        table.setStyle(TableStyle([('BACKGROUND', (0,0), (-1,0), colors.HexColor('#dcecf2')), ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#f4f7fa')]), ('VALIGN', (0,0), (-1,-1), 'TOP'), ('LEFTPADDING', (0,0), (-1,-1), 8), ('RIGHTPADDING', (0,0), (-1,-1), 8), ('TOPPADDING', (0,0), (-1,-1), 7), ('BOTTOMPADDING', (0,0), (-1,-1), 7), ('LINEBELOW', (0,0), (-1,0), .7, colors.HexColor('#4d8092'))]))
        story.extend([table, Spacer(1, 8)])
        continue
    if line in {'## 2. Novidades da 0.6.8', '## 8. Codigo principal'}:
        story.append(PageBreak())
    if line.startswith('### '): story.append(Paragraph(inline(line[4:]), styles['Sub']))
    elif line.startswith('## '): story.append(Paragraph(inline(line[3:]), styles['Section']))
    else: story.append(Paragraph(inline(line), styles['Text']))
    i += 1

def chrome(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#c4d7df'))
    canvas.line(20*mm, 282*mm, 190*mm, 282*mm)
    canvas.setFont('Body', 8)
    canvas.setFillColor(colors.HexColor('#526c7c'))
    canvas.drawString(20*mm, 286*mm, 'DVS CONTROLLER / MANUAL DE PRODUCAO')
    canvas.drawString(20*mm, 12*mm, '0.6.8  -  Setembro 2026')
    canvas.drawRightString(190*mm, 12*mm, str(doc.page))
    canvas.restoreState()

doc = SimpleDocTemplate(str(OUTPUT), pagesize=A4, leftMargin=20*mm, rightMargin=20*mm, topMargin=24*mm, bottomMargin=27*mm, title='DVS Controller 0.6.8 - Manual de producao', author='Decode')
doc.build(story, onFirstPage=chrome, onLaterPages=chrome)
print(OUTPUT)
