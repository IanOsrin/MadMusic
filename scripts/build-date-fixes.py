#!/usr/bin/env python3
"""Build the date-repair review workbook.

Joins three sources:
  data/date-audit.csv        — bad-date rows found in PRODUCTION fmcloud
  data/m1-date-keys.json     — recid → ISRC / Cat# from the local FM snapshot
  Gallo_Metadata_Extract.xlsx — authoritative Release Date per ISRC (+ Cat#)

Output: data/date-fixes.xlsx for Ian to review and import into FileMaker.
Nothing is written to any FileMaker server by this script.
"""
import json
import re
import pandas as pd

EXTRACT = '/Users/ianosrin/Desktop/GalloIngestV1.1/Gallo_Metadata_Extract.xlsx'

audit = pd.read_csv('data/date-audit.csv', dtype=str).fillna('')
m1 = {r['recid']: r for r in json.load(open('data/m1-date-keys.json'))}
ext = pd.read_excel(EXTRACT, sheet_name='Metadata', dtype=str)

# Parse extract dates (mm/dd/yyyy) once
ext['date'] = pd.to_datetime(ext['Release Date'], format='%m/%d/%Y', errors='coerce')
ext['ISRC'] = ext['ISRC'].astype(str).str.strip()
ext['Cat. #'] = ext['Cat. #'].astype(str).str.strip()

# Lookups: exact album instance first, then earliest date per ISRC (= original release)
by_isrc_cat = {}
for _, r in ext.dropna(subset=['date']).iterrows():
    by_isrc_cat.setdefault((r['ISRC'], r['Cat. #']), r['date'])
by_isrc = ext.dropna(subset=['date']).groupby('ISRC')['date'].min().to_dict()

# Mechanical fallback rules (only used when the extract has no answer)
def mechanical(field, v):
    v = v.strip()
    if v in ('-0-0', '-16-', '-16-0'):
        return '', 'clear junk placeholder'
    w = v.replace('!', '1').replace('=', '-')
    m = re.fullmatch(r'(\d{4})/(\d{1,2})/(\d{1,2})', w)
    if m:
        w = f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    m = re.fullmatch(r'(\d{1,2})-(\d{1,2})-(\d{4})', w)
    if m and int(m.group(2)) <= 12:  # dd-mm-yyyy
        w = f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    m = re.fullmatch(r'(\d{4})-(\d{1,2})-(\d{1,2})', w)
    if m:
        w = f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    if field == 'Year of Release':
        m = re.match(r'^(19|20)\d{2}', w)
        if m:
            return m.group(0), 'mechanical'
        return None, None
    if re.fullmatch(r'(19|20)\d{2}-\d{2}-\d{2}', w):
        return w, 'mechanical'
    if re.fullmatch(r'(19|20)\d{2}', w):
        return f'{w}-01-01', 'mechanical (year → Jan 1)'
    if re.fullmatch(r'(19|20)\d{2}-\d{2}', w):
        return f'{w}-01', 'mechanical (month → day 1)'
    return None, None

rows, manual = [], []
for _, a in audit.iterrows():
    rec = m1.get(a['recid'], {})
    isrc, cat = rec.get('isrc', ''), rec.get('cat', '')
    date, source = None, None
    if isrc:
        date = by_isrc_cat.get((isrc, cat))
        if date is not None:
            source = 'extract (ISRC+Cat#)'
        elif isrc in by_isrc:
            date, source = by_isrc[isrc], 'extract (ISRC, earliest)'
    if date is not None:
        proposed = str(date.year) if a['field'] == 'Year of Release' else date.strftime('%Y-%m-%d')
    else:
        proposed, source = mechanical(a['field'], a['value'])
    row = {
        'recid': a['recid'], 'recordId': a['recordId'], 'ISRC': isrc,
        'track': a['track'], 'artist': a['artist'], 'album': a['album'],
        'field': a['field'], 'current value': a['value'],
        'proposed value': proposed if proposed is not None else '',
        'source': source or 'MANUAL REVIEW', 'issue': a['issue'],
    }
    (manual if proposed is None else rows).append(row)

fixes = pd.DataFrame(rows)
manual_df = pd.DataFrame(manual)

# Some FM titles carry control characters that openpyxl refuses — strip them.
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
def clean(df):
    return df.map(lambda v: ILLEGAL_CHARACTERS_RE.sub('', v) if isinstance(v, str) else v)
fixes, manual_df = clean(fixes), clean(manual_df)
summary = pd.DataFrame([
    {'metric': 'total audit rows', 'count': len(audit)},
    {'metric': 'fixable — from extract (ISRC+Cat#)', 'count': int((fixes['source'] == 'extract (ISRC+Cat#)').sum())},
    {'metric': 'fixable — from extract (ISRC earliest)', 'count': int((fixes['source'] == 'extract (ISRC, earliest)').sum())},
    {'metric': 'fixable — mechanical rules', 'count': int(fixes['source'].str.startswith('mechanical').sum() + (fixes['source'] == 'clear junk placeholder').sum())},
    {'metric': 'manual review needed', 'count': len(manual_df)},
])

# Plain output — no fonts/styling: FileMaker's xlsx import reads the first row
# as field names and styled headers have tripped it up. Import-sheet headers
# match the FM field names exactly so the import dialog auto-maps.
out = 'data/date-fixes.xlsx'
with pd.ExcelWriter(out, engine='openpyxl') as w:
    summary.to_excel(w, sheet_name='Summary', index=False)
    fixes.to_excel(w, sheet_name='Fixes', index=False)
    if len(manual_df):
        manual_df.to_excel(w, sheet_name='Manual review', index=False)
    for field, sheet in [('Year of Release', 'Import Year'), ('Original Release date', 'Import Original Date')]:
        sub = fixes[fixes['field'] == field][['recid', 'proposed value']].rename(columns={'proposed value': field})
        sub.to_excel(w, sheet_name=sheet, index=False)
        print(f'{sheet}: {len(sub)} rows')

print(summary.to_string(index=False))
print(f'\nwrote {out}: {len(fixes)} proposed fixes, {len(manual_df)} for manual review')
