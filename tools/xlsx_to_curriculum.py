# Convert English_Learning_Content_AR.xlsx -> content/curriculum.json (stdlib only).
import zipfile, xml.etree.ElementTree as ET, re, json, os
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
T = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t'
SRC = r"C:\Users\moham\Downloads\English_Learning_Content_AR.xlsx"
OUT = os.path.join(os.path.dirname(__file__), '..', 'content', 'curriculum.json')

z = zipfile.ZipFile(SRC)
shared = []
if 'xl/sharedStrings.xml' in z.namelist():
    r = ET.fromstring(z.read('xl/sharedStrings.xml'))
    for si in r.findall('m:si', NS):
        shared.append(''.join(t.text or '' for t in si.iter(T)))
wb = ET.fromstring(z.read('xl/workbook.xml'))
rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
relmap = {rr.get('Id'): rr.get('Target') for rr in rels}
RID = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'

def col_to_idx(ref):
    s = re.match(r'([A-Z]+)', ref).group(1); n = 0
    for c in s: n = n*26 + (ord(c)-64)
    return n-1

def sheet_rows(name):
    rid = None
    for s in wb.find('m:sheets', NS):
        if s.get('name') == name: rid = s.get(RID)
    target = relmap[rid].lstrip('/')
    if not target.startswith('xl/'): target = 'xl/' + target
    sx = ET.fromstring(z.read(target))
    out = []
    for row in sx.find('m:sheetData', NS).findall('m:row', NS):
        cells = {}; maxc = -1
        for c in row.findall('m:c', NS):
            ci = col_to_idx(c.get('r')); maxc = max(maxc, ci)
            t = c.get('t'); v = c.find('m:v', NS); val = ''
            if v is not None: val = shared[int(v.text)] if t == 's' else (v.text or '')
            else:
                isx = c.find('m:is', NS)
                if isx is not None: val = ''.join(tt.text or '' for tt in isx.iter(T))
            cells[ci] = (val or '').strip()
        out.append([cells.get(i, '') for i in range(maxc+1)])
    return out

def col(row, i): return row[i] if i < len(row) else ''

# ---- Words ----
words = []
for r in sheet_rows('الكلمات')[1:]:
    if not col(r, 4): continue  # need an English word
    words.append({
        'level': col(r, 0), 'chapter_no': col(r, 1), 'chapter_title': col(r, 2),
        'n': col(r, 3), 'en': col(r, 4), 'phonetic': col(r, 5), 'ar': col(r, 6),
        'pos': col(r, 7), 'ex_en': col(r, 8), 'ex_ar': col(r, 9),
    })
# ---- Chapters ----
chapters = []
for r in sheet_rows('فهرس الفصول')[1:]:
    if not col(r, 0): continue
    chapters.append({'level': col(r, 0), 'number': col(r, 1), 'title_ar': col(r, 2), 'topic_en': col(r, 3)})
# ---- Placement ----
placement = []
for r in sheet_rows('اختبار تحديد المستوى')[1:]:
    if not col(r, 3): continue
    placement.append({'n': col(r, 0), 'level': col(r, 1), 'skill': col(r, 2), 'q': col(r, 3),
                      'options': [col(r, 4), col(r, 5), col(r, 6), col(r, 7)], 'answer': col(r, 8)})
# ---- Foundations (phonics: rows beginning with an index then a letter like "A a") ----
foundations = []
for r in sheet_rows('التأسيس'):
    if len(r) >= 5 and re.match(r'^\d+$', col(r, 0)) and col(r, 1):
        foundations.append({'n': col(r, 0), 'letter': col(r, 1), 'sound': col(r, 2),
                            'example': col(r, 3), 'meaning': col(r, 4)})

data = {'words': words, 'chapters': chapters, 'placement': placement, 'foundations_phonics': foundations}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=1)
print('words=%d chapters=%d placement=%d phonics=%d' % (len(words), len(chapters), len(placement), len(foundations)))
print('levels:', sorted(set(w['level'] for w in words)))
print('wrote', os.path.relpath(OUT))
