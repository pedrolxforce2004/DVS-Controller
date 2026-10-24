"""Generate the operation manual from its Markdown source with ReportLab."""
from pathlib import Path
from html import escape
import re
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, KeepTogether

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'docs' / 'DVS-Controller-0.6.9-Manual.pdf'
FONT = Path('C:/Windows/Fonts')
pdfmetrics.registerFont(TTFont('Body', str(FONT / 'arial.ttf')))
pdfmetrics.registerFont(TTFont('BodyBold', str(FONT / 'arialbd.ttf')))
pdfmetrics.registerFontFamily('Body', normal='Body', bold='BodyBold', italic='Body', boldItalic='BodyBold')
navy = colors.HexColor('#102137')
teal = colors.HexColor('#087f79')
gray = colors.HexColor('#45566d')
styles = {
    'body': ParagraphStyle('body', fontName='Body', fontSize=10.4, leading=16, spaceAfter=10, textColor=navy),
    'heading': ParagraphStyle('heading', fontName='BodyBold', fontSize=18, leading=23, spaceBefore=14, spaceAfter=14, textColor=navy, keepWithNext=True),
    'label': ParagraphStyle('label', fontName='BodyBold', fontSize=10, leading=15, textColor=teal, spaceAfter=12),
    'cover': ParagraphStyle('cover', fontName='BodyBold', fontSize=36, leading=42, textColor=navy, spaceAfter=16),
    'deck': ParagraphStyle('deck', fontName='Body', fontSize=17, leading=24, textColor=gray, spaceAfter=14),
    'toc': ParagraphStyle('toc', fontName='Body', fontSize=11, leading=20, textColor=navy),
}
def inline(text):
    text = escape(text.replace('\u2013', '-').replace('\u2014', '-'))
    return re.sub(r'`([^`]+)`', r'<font name="Courier" size="9">\1</font>', text)

story = [Spacer(1, 18*mm), Paragraph('DECODE / DOCUMENTAÇÃO DE PRODUTO', styles['label']), Spacer(1, 12*mm),
         Paragraph('DVS Controller', styles['cover']), Paragraph('Manual de operação<br/>Versão 0.6.9', styles['deck']),
         Paragraph('23 de outubro de 2026', styles['body']), Spacer(1, 8*mm)]
callout = Table([[Paragraph('GESTÃO DE CONTEÚDO PARA TVs', styles['label'])], [Paragraph('LG webOS · Samsung Tizen · Android TV<br/>Instalação, conteúdo, operação e recuperação.', styles['body'])]], colWidths=[166*mm])
callout.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#eaf5f3')),('BOX',(0,0),(-1,-1),0.5,colors.HexColor('#b7d8d3')),('LEFTPADDING',(0,0),(-1,-1),15),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),8)]))
story += [callout, Spacer(1, 12*mm), Paragraph('Neste manual', styles['heading'])]
lines = (ROOT/'docs/MANUAL-0.6.9.md').read_text(encoding='utf-8').splitlines()
chapters = [line[3:] for line in lines if line.startswith('## ')]
for chapter in chapters: story.append(Paragraph(inline(chapter), styles['toc']))
story.append(PageBreak())
paragraph = []
def flush():
    if paragraph:
        story.append(Paragraph(inline(' '.join(paragraph)),styles['body'])); paragraph.clear()
for line in lines:
    if line.startswith('## '):
        flush(); number = int(line[3:].split('.')[0])
        if number in [3,5,7,9,10]: story.append(PageBreak())
        story.append(Paragraph(inline(line[3:]),styles['heading']))
    elif line.startswith('# ') or not any(x.startswith('## ') for x in lines[:lines.index(line)] if x) and line in lines[:7]:
        continue
    elif not line.strip(): flush()
    elif not line.startswith('Manual de operação') and not line.startswith('23 de outubro'): paragraph.append(line)
flush()
def page(canvas, doc):
    width,height=A4
    canvas.saveState(); canvas.setStrokeColor(colors.HexColor('#b9c7d5')); canvas.setLineWidth(.5)
    canvas.line(22*mm,18*mm,width-22*mm,18*mm)
    canvas.setFont('Body',8); canvas.setFillColor(gray)
    canvas.drawString(22*mm,12*mm,'DVS Controller 0.6.9 | Manual de operação')
    canvas.drawRightString(width-22*mm,12*mm,str(doc.page))
    if doc.page>1:
        canvas.setFont('BodyBold',8);canvas.setFillColor(teal);canvas.drawString(22*mm,height-15*mm,'DECODE / DVS CONTROLLER')
    canvas.restoreState()
doc=SimpleDocTemplate(str(OUTPUT),pagesize=A4,leftMargin=22*mm,rightMargin=22*mm,topMargin=24*mm,bottomMargin=26*mm,title='DVS Controller 0.6.9 - Manual de operação',author='Decode')
doc.build(story,onFirstPage=page,onLaterPages=page)
print(OUTPUT)
