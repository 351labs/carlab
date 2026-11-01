#!/usr/bin/env python3
"""Make a reproducible comparison from the measured JSONs; no audio inference."""
import json
from pathlib import Path

root = Path('docs/analysis')
rows = []
for name in ['v10-steady', 'v12-steady', 'v10-idle', 'v12-idle']:
    item = {'id': name}
    for version in ['before', 'after']:
        report = json.loads((root / 'synthetic' / f'{name}-{version}.json').read_text())
        item[version] = {
            'bass_20_80_percent': report['band_energy']['20-80_Hz']['fraction_of_20_20000_Hz'] * 100,
            'body_80_200_percent': report['band_energy']['80-200_Hz']['fraction_of_20_20000_Hz'] * 100,
            'low_mid_200_500_percent': report['band_energy']['200-500_Hz']['fraction_of_20_20000_Hz'] * 100,
            'relative_envelope_rms': report['envelope']['relative_envelope_rms'],
            'rms_dbfs': report['rms_dbfs'],
            'dip_candidates': report['envelope']['dip_candidates_count'],
        }
    rows.append(item)
manifest = json.loads((root / 'comparison' / 'manifest.json').read_text())
summary = {
    'model': manifest['model'], 'selection': '0.5–5.5 seconds of each six-second raw capture',
    'steady_targets': {'rpm': 3000, 'load': 0.6, 'throttle': 0.6},
    'energy_denominator': 'Measured20Hz–20kHz spectral power, not sound-pressure calibration',
    'listening_files': 'comparison/*-before.wav and *-after.wav have equal stereo RMS; measurements above use raw outputs.',
    'reference_comparability': 'Classic reference has unknown RPM/load, microphone and room response. No matched real-engine fidelity score is inferred.',
    'legacy_zero_byte_identical': all(pair['legacyZeroByteIdentical'] for pair in manifest['pairs']),
    'rows': rows,
}
(root / 'comparison' / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')

w, h = 1080, 580
parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" aria-label="Measured body energy before and after at the same operating point">',
         '<rect width="1080" height="580" fill="#f3f2ec"/>',
         '<style>text{font-family:Arial,sans-serif;fill:#24322b}.title{font-size:25px;font-weight:700}.sub{font-size:13px}.label{font-size:14px}.value{font-size:21px;font-weight:700}</style>',
         '<text x="48" y="54" class="title">Mais corpo, com a mesma rotação</text>',
         '<text x="48" y="82" class="sub">Energia entre 80–200 Hz · 3.000 RPM · 60% de carga · mesma geometria e ordem de ignição</text>',
         '<rect x="48" y="109" width="15" height="15" fill="#8b958d"/><text x="72" y="121" class="sub">Versão anterior</text>',
         '<rect x="234" y="109" width="15" height="15" fill="#92b63d"/><text x="258" y="121" class="sub">Novos controles de caráter</text>']
for index, row in enumerate(rows[:2]):
    x = 66 + index * 510
    y = 422
    chart_height = 235
    for tick in [0, 20, 40, 60, 80, 100]:
        ty = y - tick / 100 * chart_height
        parts.append(f'<path d="M{x} {ty}h390" stroke="#d9dfd1"/><text x="{x-9}" y="{ty+4}" text-anchor="end" class="sub">{tick}%</text>')
    for j, version in enumerate(['before', 'after']):
        value = row[version]['body_80_200_percent']
        bx = x + 65 + j * 145
        bh = value / 100 * chart_height
        color = '#8b958d' if version == 'before' else '#92b63d'
        parts.append(f'<rect x="{bx}" y="{y-bh}" width="88" height="{bh}" rx="4" fill="{color}"/>')
        parts.append(f'<text x="{bx+44}" y="{y-bh-12}" text-anchor="middle" class="value">{value:.1f}%</text>')
    parts.append(f'<text x="{x+210}" y="460" text-anchor="middle" class="value">{row["id"].split("-")[0].upper()}</text>')
parts += ['<text x="48" y="506" class="sub">Percentuais de potência espectral dos renders brutos. Áudios de escuta separados têm RMS igualado.</text>',
          '<text x="48" y="530" class="sub">A comparação mede a mudança do sintetizador; não atribui uma nota de fidelidade a motores reais.</text>',
          '</svg>']
(root / 'comparison' / 'body-comparison.svg').write_text(''.join(parts) + '\n')
print(json.dumps(summary, indent=2))
