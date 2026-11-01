#!/usr/bin/env python3
"""Analyze original timbre probes; run computations only through lm-remote.
NumPy and system FFmpeg are the only non-stdlib requirements. No audio shaping:
loudnorm measures input statistics; matched WAVs receive one constant gain.
"""
from __future__ import annotations
import argparse, hashlib, json, math, re, shutil, subprocess
from pathlib import Path
import numpy as np
from analyze import decode, welch, envelope_metrics

ROOT = Path(__file__).resolve().parent
DEFAULT = "output/timbre-prototypes"
BANDS = [("20-80", 20, 80), ("80-200", 80, 200), ("200-500", 200, 500), ("500-2000", 500, 2000), ("rest", None, None)]

def path_in_repo(value):
    path = (ROOT / value).resolve()
    if path != ROOT and ROOT not in path.parents:
        raise ValueError("Path must remain inside the repository")
    return path

def run(args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

def loudness(path):
    # Output is discarded. Only input_* fields describe the unchanged source.
    measured = run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-map", "0:a:0", "-af", "loudnorm=I=-22:TP=-2:LRA=11:print_format=json", "-f", "null", "-"])
    blocks = re.findall(r'\{\s*"input_i".*?\}', measured.stderr, re.S)
    if not blocks:
        raise ValueError("FFmpeg did not return loudnorm input measurements")
    raw = json.loads(blocks[-1])
    result = {name: float(raw[key]) for name, key in [("integratedLufs", "input_i"), ("truePeakDbtp", "input_tp"), ("lraLu", "input_lra"), ("thresholdLufs", "input_thresh")]}
    if not all(math.isfinite(value) for value in result.values()):
        raise ValueError("Silent or non-finite integrated loudness/true-peak measurement")
    return result

def amplitude_db(value):
    return 20 * math.log10(value) if value > 0 else None

def metrics(audio, rate):
    if len(audio) < rate * .4 or audio.ndim != 2 or audio.shape[1] != 2 or not np.isfinite(audio).all():
        raise ValueError("Expected finite stereo PCM with at least 400 ms")
    rms = float(np.sqrt(np.mean(audio * audio)))
    if rms <= 1e-10:
        raise ValueError("Silent or effectively silent PCM")
    peak = float(np.max(np.abs(audio)))
    frequency, power, windows = welch(audio, rate)
    mono_frequency, mono_power, _ = welch(np.mean(audio, axis=1), rate)
    if not np.array_equal(frequency, mono_frequency):
        raise ValueError("Incompatible Welch grids")
    delta = float(frequency[1] - frequency[0]); total = float(np.sum(power) * delta)
    if not math.isfinite(total) or total <= 0:
        raise ValueError("No finite spectral energy")
    bands = {}
    for name, low, high in BANDS:
        mask = ((frequency < 20) | (frequency >= 2000)) if low is None else ((frequency >= low) & (frequency < high))
        stereo_energy = float(np.sum(power[mask]) * delta); mono_energy = float(np.sum(mono_power[mask]) * delta)
        loss = 10 * math.log10(stereo_energy / mono_energy) if stereo_energy > 0 and mono_energy > 0 else None
        bands[name] = {"energyFsSquared": stereo_energy, "fraction": stereo_energy / total, "monoEnergyFsSquared": mono_energy, "monoLossDb": loss, "monoStatus": "finite" if loss is not None else ("complete-cancellation" if stereo_energy > 0 else "no-energy")}
    envelope, _, _ = envelope_metrics(audio, rate)
    return {"frames": len(audio), "sampleRate": rate, "rms": rms, "rmsDbfs": amplitude_db(rms), "peak": peak, "peakDbfs": amplitude_db(peak), "dc": float(np.mean(audio)), "dcPerChannel": np.mean(audio, axis=0).tolist(), "crestDb": amplitude_db(peak / rms), "spectralCentroidHz": float(np.sum(frequency * power) / np.sum(power)), "welchWindows": windows, "bands": bands, "envelope": envelope}

def page(report):
    # Embed data safely; metadata enters DOM through textContent, never markup.
    compact = {"matching": report["matching"], "variants": report["variants"], "rows": [{key: row.get(key) for key in ("id", "preset", "case", "variant", "controlMode", "rpm", "load", "throttle", "raw", "matched", "gainDb", "listeningPath", "excludedReason", "verification")} for row in report["rows"]]}
    data = json.dumps(compact, ensure_ascii=False, allow_nan=False).replace("<", "\\u003c")
    return '''<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CARLAB · Estudos de timbre</title>
<style>:root{color-scheme:light;font:15px/1.55 system-ui,sans-serif;color:#223027;background:#f2f1eb}*{box-sizing:border-box}body{margin:0}main{max-width:1260px;margin:auto;padding:32px 20px 60px}h1{font-size:34px;letter-spacing:-1.2px;line-height:1.15}h2{font-size:20px;line-height:1.25}p{max-width:95ch}.eyebrow{font:11px monospace;letter-spacing:2px;color:#607255}.controls{display:flex;gap:18px;flex-wrap:wrap;margin:24px 0}.controls label{display:grid;gap:6px;font-size:12px}select{padding:10px;border:1px solid #cbd4bd;border-radius:5px;background:#fff;color:inherit;font:inherit}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.card{min-width:0;background:#fcfdf8;border:1px solid #d2dbc6;border-radius:9px;padding:20px}audio{width:100%;margin:14px 0}.muted,.meta{font-size:12px;color:#627059}.numbers{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px}.numbers span{font-size:10px;color:#627059;display:block}.numbers strong{font:17px monospace}.band{font-size:11px;margin:9px 0}.band .label{display:flex;justify-content:space-between;gap:6px}.rail{height:7px;background:#e1e7d7;border-radius:4px;overflow:hidden}.fill{height:100%;background:#789b43}.excluded{color:#8d4538}.notes{padding-top:24px;border-top:1px solid #d2dbc6;margin-top:30px}a{color:#415f2d}details{margin-top:20px}summary{cursor:pointer}.notice{padding:15px 18px;background:#e8eddc;border-radius:7px}@media(max-width:900px){.grid{grid-template-columns:1fr}h1{font-size:29px}.card{padding:18px}.controls label{width:100%}}</style>
<main><p class="eyebrow">CARLAB AUDIO LAB / ENSAIOS ORIGINAIS</p><h1>Corpo grave, cauda e caráter</h1><p>Três alternativas do mesmo instrumento, com loudness integrado igualado por ganho constante. Escolha uma voz e uma condição; iniciar um player pausa os outros. O volume inicial de cada player é igual.</p>
<p class="notice">Protótipo experimental de DSP. O estado físico de controle é uma hipótese declarada; estas variantes de timbre preservam o agendamento de ignição e a física média. Igualar LUFS ajuda a comparar, mas não certifica fidelidade a um motor real, qualidade sonora ou superioridade de uma alternativa.</p>
<div class="controls"><label>Voz original<select id="preset"></select></label><label>Condição declarada<select id="case"></select></label></div><p id="condition" class="meta"></p><div id="cards" class="grid"></div><section id="diagnostics" hidden><h2>Diagnóstico separado · fonte AC</h2><p class="muted">Esta renderização serve para investigar a fonte de fluxo. É um diagnóstico, não uma quarta alternativa principal de timbre ou uma voz calibrada.</p><div id="diagnostic-cards" class="grid"></div></section>
<div class="notes"><h2>Como esta escuta foi preparada</h2><p id="matching"></p><p>FFmpeg <code>loudnorm</code> foi usado apenas para medir os campos de entrada LUFS/true peak. Os WAVs recebem um único ganho constante antes da quantização PCM de 16 bits: sem EQ, compressão, limitador ou processamento de normalização dinâmica. RMS, pico, DC, crest factor e espectro foram medidos novamente nos WAVs publicados.</p><p>As barras mostram a fração da energia Welch média dos canais. Resto = abaixo de 20 Hz e de 2 kHz até Nyquist. A perda em mono é 10·log₁₀(energia estéreo média / energia de (L+R)/2); valores positivos indicam atenuação/cancelamento ao somar os canais. Cancelamento total aparece sem um dB inventado. Variação do envelope usa RMS de 10 ms e não identifica falhas de ignição.</p><p>O giro exibido vem do ensaio declarado, não de inferência acústica. Os presets são vozes procedurais originais, sem identidade comercial. Gravações de referência, seus microfones/ambientes/codecs e suas licenças exigem uma comparação separada.</p><p><a href="analysis.json" download>Baixar medições, controles, hipóteses e proveniência JSON</a> · <a href="/">Voltar ao laboratório</a></p></div></main>
<script>const D=__DATA__,q=id=>document.getElementById(id),fmt=(x,n=1)=>Number.isFinite(x)?x.toLocaleString('pt-BR',{maximumFractionDigits:n}):'—';
const voice=id=>id.includes('cross')?'V8 crossplane':id.includes('classic')?'V12 clássico':id.includes('v12')?'V12 moderno':id;
const variant=id=>({'source-ac':'Fonte AC · diagnóstico','baseline':'Base atual','deep-body':'Corpo grave','deep-body-single-tail':'Corpo grave · escuta lateral'})[id]||D.variants.find(v=>v.id===id)?.label||id;
const option=(select,value,label)=>{const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o)};
const caseKey=r=>JSON.stringify([r.case,r.controlMode]),pauseAll=()=>document.querySelectorAll('audio').forEach(a=>a.pause());
for(const id of [...new Set(D.rows.map(r=>r.preset))])option(q('preset'),id,voice(id));
function cases(){q('case').replaceChildren();const seen=new Set();for(const r of D.rows.filter(r=>r.preset===q('preset').value)){const key=caseKey(r);if(!seen.has(key)){option(q('case'),key,(String(r.case).includes('idle')?'Marcha lenta':'Regime sob carga')+' · '+fmt(r.rpm,0)+' RPM · '+(r.controlMode==='physical'?'físico':r.controlMode));seen.add(key)}}draw()}
function number(box,label,value,unit){const el=document.createElement('div'),s=document.createElement('span'),v=document.createElement('strong');s.textContent=label;v.textContent=value+(unit?' '+unit:'');el.append(s,v);box.append(el)}
function draw(){pauseAll();q('cards').replaceChildren();q('diagnostic-cards').replaceChildren();q('diagnostics').hidden=true;const rows=D.rows.filter(r=>r.preset===q('preset').value&&caseKey(r)===q('case').value),r=rows[0];q('condition').textContent=r?fmt(r.rpm,0)+' RPM · carga '+fmt(r.load*100,0)+'% · borboleta '+fmt(r.throttle*100,0)+'% · controle '+(r.controlMode==='physical'?'físico':r.controlMode):'';
for(const r of rows){const diagnostic=D.variants.find(v=>v.id===r.variant)?.diagnostic===true||r.variant==='source-ac',holder=diagnostic?q('diagnostic-cards'):q('cards');if(diagnostic)q('diagnostics').hidden=false;const card=document.createElement('article');card.className='card';const h=document.createElement('h2');h.textContent=variant(r.variant);card.append(h);if(r.excludedReason){const p=document.createElement('p');p.className='excluded';p.textContent='Excluído: '+r.excludedReason;card.append(p);holder.append(card);continue}const a=document.createElement('audio');a.controls=true;a.preload='none';a.src=r.listeningPath;a.volume=.35;card.append(a);const box=document.createElement('div');box.className='numbers';const m=r.matched.metrics,l=r.matched.loudness;
number(box,'LUFS integrado',fmt(l.integratedLufs,2),'LUFS');number(box,'True peak',fmt(l.truePeakDbtp,2),'dBTP');number(box,'Ganho aplicado',fmt(r.gainDb,2),'dB');number(box,'RMS',fmt(m.rmsDbfs,2),'dBFS');number(box,'Crest factor',fmt(m.crestDb,2),'dB');number(box,'Centroide',fmt(m.spectralCentroidHz,0),'Hz');number(box,'Variação envelope',fmt(m.envelope.active_rms_envelope_cv*100,1),'%');number(box,'DC máximo/canal',Math.max(...m.dcPerChannel.map(Math.abs)).toExponential(2),'');card.append(box);
for(const [name,b] of Object.entries(m.bands)){const band=document.createElement('div');band.className='band';const label=document.createElement('div');label.className='label';const n=document.createElement('span'),value=document.createElement('span');n.textContent=name==='rest'?'Resto':name+' Hz';value.textContent=fmt(b.fraction*100,1)+'% · mono '+(b.monoLossDb===null?(b.monoStatus==='complete-cancellation'?'cancelamento total':'sem energia'):fmt(b.monoLossDb,1)+' dB');label.append(n,value);const rail=document.createElement('div'),fill=document.createElement('div');rail.className='rail';fill.className='fill';fill.style.width=(b.fraction*100)+'%';rail.append(fill);band.append(label,rail);card.append(band)}
const details=document.createElement('details'),summary=document.createElement('summary'),p=document.createElement('p');summary.textContent='Entrada e verificação';p.className='muted';p.textContent='Antes: '+fmt(r.raw.loudness.integratedLufs,2)+' LUFS / '+fmt(r.raw.loudness.truePeakDbtp,2)+' dBTP; RMS '+fmt(r.raw.metrics.rmsDbfs,2)+' dBFS. Verificação: '+(r.verification.pass?'dentro das tolerâncias declaradas':'consultar desvios no JSON')+'.';details.append(summary,p);card.append(details);holder.append(card)}}
document.addEventListener('play',e=>document.querySelectorAll('audio').forEach(a=>{if(a!==e.target)a.pause()}),true);q('preset').addEventListener('change',cases);q('case').addEventListener('change',draw);q('matching').textContent='Alvo comum: '+fmt(D.matching.targetLufs,2)+' LUFS. Fórmula: mínimo de −22 LUFS e de (LUFS de entrada + margem até −2 dBTP), entre todas as entradas válidas. Tolerâncias de verificação: ±0,10 LU e true peak ≤ −1,95 dBTP; não há correção automática posterior.';cases();</script></html>'''.replace("__DATA__", data)

def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--manifest", default=f"{DEFAULT}/manifest.json"); parser.add_argument("--output", default=DEFAULT); parser.add_argument("--publish", default="dist/client/timbre"); args = parser.parse_args()
    manifest_path = path_in_repo(args.manifest); output = path_in_repo(args.output); publish = path_in_repo(args.publish)
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("pathBase") != "repository" or not isinstance(manifest.get("rows"), list):
        raise ValueError("Expected a repository-relative timbre manifest with rows")
    output.mkdir(parents=True, exist_ok=True); (output / "matched").mkdir(exist_ok=True)
    rows = []
    for source in manifest["rows"]:
        row = {**source, "excludedReason": None}
        try:
            raw_path = path_in_repo(source["rawPath"]); audio, rate, _ = decode(raw_path)
            if rate != source["sampleRate"] or len(audio) != source["frames"]:
                raise ValueError("Decoded frame count/sample rate differs from manifest; no trimming/resampling was applied")
            row["raw"] = {"metrics": metrics(audio, rate), "loudness": loudness(raw_path), "sha256": hashlib.sha256(raw_path.read_bytes()).hexdigest()}
        except Exception as error:
            row["excludedReason"] = str(error)
        rows.append(row)
    eligible = [row for row in rows if not row["excludedReason"]]
    target = min([-22.0] + [row["raw"]["loudness"]["integratedLufs"] + (-2.0 - row["raw"]["loudness"]["truePeakDbtp"]) for row in eligible]) if eligible else None
    for index, row in enumerate(rows):
        if row["excludedReason"]:
            continue
        name = f"clip-{index:02d}-" + re.sub(r"[^A-Za-z0-9._-]", "-", str(row["id"]))[:100] + ".wav"; destination = output / "matched" / name
        try:
            row["gainDb"] = target - row["raw"]["loudness"]["integratedLufs"]
            run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(path_in_repo(row["rawPath"])), "-map", "0:a:0", "-af", f'volume={row["gainDb"]:.12f}dB:precision=double', "-c:a", "pcm_s16le", "-f", "wav", str(destination)])
            audio, rate, _ = decode(destination)
            if len(audio) != row["frames"] or rate != row["sampleRate"]:
                raise ValueError("Matched output changed frame count or sample rate")
            row["matched"] = {"metrics": metrics(audio, rate), "loudness": loudness(destination), "path": str(destination.relative_to(ROOT)), "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}
            row["listeningPath"] = "matched/" + name; actual = row["matched"]["loudness"]
            row["verification"] = {"lufsError": actual["integratedLufs"] - target, "truePeakMarginDb": -2.0 - actual["truePeakDbtp"], "pass": abs(actual["integratedLufs"] - target) <= .10 and actual["truePeakDbtp"] <= -1.95}
        except Exception as error:
            row["excludedReason"] = str(error); destination.unlink(missing_ok=True)
    report = {"schema": "carlab-timbre-analysis-1", "sourceManifest": str(manifest_path.relative_to(ROOT)), "source": manifest.get("source"), "variants": manifest.get("variants", []), "render": manifest.get("render"), "matching": {"targetLufs": target, "truePeakGoalDbtp": -2.0, "outputFormat": {"codec": "pcm_s16le", "bitsPerSample": 16, "channels": 2, "quantization": "Signed PCM16 conversion after constant double-precision gain; no dynamic gain, EQ or limiting"}, "method": "Single constant double-precision gain before signed PCM16 quantization; loudnorm input statistics only; no EQ, compressor, limiter, resampling or dynamic normalization", "formula": "min(-22, min(inputI + (-2 - inputTP)))", "lufsTolerance": .10, "truePeakToleranceDb": .05}, "spectralMethod": "16384-point Hann Welch with 50% overlap, per-channel means removed, average channel power; fractions cover 0..Nyquist; mono-loss positive = stereo-energy attenuation on (L+R)/2", "limits": "Original experimental DSP timbre alternatives, assumed physical controls, same ignition scheduling/mean physics; equal LUFS is not engine-fidelity evidence. No reference-derived RPM or ignition-failure inference.", "rows": rows, "validClips": sum(not row["excludedReason"] for row in rows), "excludedClips": sum(bool(row["excludedReason"]) for row in rows)}
    (output / "analysis.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"); (output / "index.html").write_text(page(report))
    publish.mkdir(parents=True, exist_ok=True); (publish / "matched").mkdir(exist_ok=True)
    for name in ["index.html", "analysis.json"]:
        shutil.copy2(output / name, publish / name)
    for row in rows:
        if not row["excludedReason"]:
            shutil.copy2(output / row["listeningPath"], publish / row["listeningPath"])
    print(json.dumps({"targetLufs": target, "validClips": report["validClips"], "excludedClips": report["excludedClips"], "verificationFailures": sum(not row.get("verification", {}).get("pass", False) for row in rows if not row["excludedReason"]), "analysis": str((output / "analysis.json").relative_to(ROOT)), "listeningPage": str((publish / "index.html").relative_to(ROOT))}))
    if not report["validClips"]:
        raise SystemExit("No eligible matched audio; exclusion evidence was saved and published.")

if __name__ == "__main__":
    main()
