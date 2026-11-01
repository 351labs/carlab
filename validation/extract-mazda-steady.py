"""Extract every EPA Mazda 'Steady State' row from the hashed source archive.

Usage: python3 -I extract-mazda-steady.py <epa-package.zip> <out.json>
Stdlib only. Verifies the archive/workbook SHA-256 recorded in mazda-measured.json,
keeps the exact numeric strings stored in the XLSX XML and adds parsed aliases.
No unit conversion, model output, fitting or row filtering happens here.
"""
import hashlib, io, json, re, sys, zipfile
import xml.etree.ElementTree as ET

ARCHIVE_SHA = '01895c570c01303dccbaa85fced4dcea60177bef0119564f1874e821c202c8a2'
WORKBOOK = '4- 2014 Mazda 2.0L SKYACTIV-G Engine Tier 2 Fuel - Test Data.xlsx'
WORKBOOK_SHA = '19075910a5cbe7130b9d890cdcc85d6ad9763a9a5d79c537957b204ceede402a'
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
# Same canonical aliases as the frozen 12-point fixture (numeric parsing only).
ALIASES = {
    'Speed': 'rpm', 'Torque': 'brakeTorqueNm', 'BSFC': 'bsfcGkwh', 'Fuel Meter Flow': 'fuelMassFlowGs',
    'Inlet Air Flow': 'airMassFlowGs', 'Intake Manifold Press': 'mapKpaAbsolute', 'Intake Manifold Temp': 'intakeC',
    'Cell Press': 'cellKpaAbsolute', 'Exhaust Lambda': 'exhaustLambda', 'Coolant Temp': 'coolantC',
    'Oil Sump Temp': 'oilC', 'Cell Temp': 'cellC', 'Spark Timing': 'sparkAdvanceDegBtdc',
    'Intake Cam Phase': 'intakeCamPhaseDeg', 'Exhaust Cam Phase': 'exhaustCamPhaseDeg',
    'Valve Overlap': 'valveOverlapDeg', 'Catalyst Inlet Press': 'catalystInletKpaAbsolute',
    'Catalyst Inlet Temp': 'catalystInletC', 'Fuel Rail Press': 'fuelRailMpaGauge',
    'Exhaust Port Temp (Cyl 1)': 'exhaustPort1C', 'Exhaust Port Temp (Cyl 2)': 'exhaustPort2C',
    'Exhaust Port Temp (Cyl 3)': 'exhaustPort3C', 'Exhaust Port Temp (Cyl 4)': 'exhaustPort4C',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def cells(xlsx, sheet_name):
    wb = ET.fromstring(xlsx.read('xl/workbook.xml'))
    rels = ET.fromstring(xlsx.read('xl/_rels/workbook.xml.rels'))
    target = {r.attrib['Id']: r.attrib['Target'] for r in rels}
    rid = next(s.attrib[REL] for s in wb.find('m:sheets', NS) if s.attrib['name'] == sheet_name)
    shared = [''.join(t.text or '' for t in si.iter('{%s}t' % NS['m']))
              for si in ET.fromstring(xlsx.read('xl/sharedStrings.xml'))]
    sheet = ET.fromstring(xlsx.read('xl/' + target[rid].lstrip('/').removeprefix('xl/')))
    rows = {}
    for row in sheet.iter('{%s}row' % NS['m']):
        for c in row:
            v = c.find('m:v', NS)
            if v is None:
                continue
            col, num = re.match(r'([A-Z]+)(\d+)', c.attrib['r']).groups()
            rows.setdefault(int(num), {})[col] = shared[int(v.text)] if c.attrib.get('t') == 's' else v.text
    return rows


def main(zip_path, out_path):
    archive = open(zip_path, 'rb').read()
    if sha(archive) != ARCHIVE_SHA:
        raise SystemExit('Archive SHA-256 mismatch; refusing to extract.')
    workbook = zipfile.ZipFile(io.BytesIO(archive)).read(WORKBOOK)
    if sha(workbook) != WORKBOOK_SHA:
        raise SystemExit('Workbook SHA-256 mismatch; refusing to extract.')
    rows = cells(zipfile.ZipFile(io.BytesIO(workbook)), 'Steady State')
    header, units = rows[4], rows[5]
    columns = sorted(header, key=lambda c: (len(c), c))
    points = []
    for n in sorted(k for k in rows if k > 5):
        raw = {header[c]: rows[n][c] for c in columns if c in rows[n]}
        if not raw:
            continue
        point = {'excelRow': n, 'rawValues': raw}
        for name, alias in ALIASES.items():
            point[alias] = float(raw[name]) if name in raw else None
        points.append(point)
    out = {
        'schema': 'carlab-mazda-measured-steady-all-1',
        'purpose': 'Every source Steady State row, exact XLSX numeric strings plus parsed aliases. No model output, filtering or unit conversion.',
        'source': {'url': 'https://www.epa.gov/sites/default/files/2018-04/2014-mazda-2.0l-skyactiv-engine-tier-2-fuel-test-data-package-03-29-18.zip',
                   'packageRevision': '2018-03-29', 'reportVersion': '2018-02',
                   'archiveSha256': ARCHIVE_SHA, 'workbookMember': WORKBOOK, 'workbookMemberSha256': WORKBOOK_SHA,
                   'worksheet': 'Steady State', 'headerRow': 4, 'unitsRow': 5,
                   'suggestedCitation': '2014 Mazda 2.0L SKYACTIV-G Engine Tier 2 Fuel – Test Data Package. Version 2018-02. Ann Arbor, MI: US EPA, National Vehicle and Fuel Emissions Laboratory, National Center for Advanced Technology, 2018.'},
        'reuseBasis': 'The EPA report Discussion and Data Usage describes engine operation and fuel consumption data as usable for any purpose in a measurement-quality discussion, and cautions that uncertainty rises at very low load, particularly below 50 Nm. See credits.md section 3 for the source citation and rights boundary. This file retains all 137 Steady State worksheet rows and 26 source columns; the companion fixture is a 12-row subset. No archive, report figures, other worksheet sweeps, ECU tuning tables or firmware are bundled.',
        'fuelAnalysis': {'carbonWeightFraction': 0.86678, 'method': 'ASTM D3343', 'status': 'Reference Only',
                         'ethanolVolumePercent': 0.0, 'lowerHeatingValueMjKg': 42.887,
                         'source': 'Test report Table 4 (reportMember of the same archive)'},
        'columns': [{'excelColumn': c, 'name': header[c], 'unit': units.get(c)} for c in columns],
        'points': points,
    }
    with open(out_path, 'w') as f:
        json.dump(out, f, indent=1)
        f.write('\n')
    print(f'{len(points)} steady rows -> {out_path}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
