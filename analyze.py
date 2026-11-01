#!/usr/bin/env python3
"""Deterministic acoustic measurements; NumPy + system FFmpeg, no extra packages.

Run computations through lm-remote --host local. This analyzes the recording,
not the engine in isolation: microphone, room, distance, codec and driving all
affect the result. Acoustic peaks/dips are never labelled ignition or misfire.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import math
from pathlib import Path
import struct
import subprocess
import zlib

import numpy as np


def db(value):
    return 20 * math.log10(max(float(value), 1e-12))


def decode(path):
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=codec_name,sample_rate,channels,bit_rate:format=duration", "-of", "json", str(path)
    ]))
    stream = probe["streams"][0]
    rate, channels = int(stream["sample_rate"]), int(stream["channels"])
    raw = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"
    ])
    audio = np.frombuffer(raw, dtype="<f4").reshape(-1, channels).astype(np.float64)
    if not np.all(np.isfinite(audio)):
        raise ValueError("Non-finite decoded PCM")
    return audio, rate, probe


def welch(audio, rate, fft_size=16384):
    if audio.ndim == 1:
        audio = audio[:, None]
    n = min(fft_size, 2 ** int(math.floor(math.log2(max(2, len(audio))))))
    window = np.hanning(n)
    denominator = rate * np.sum(window * window)
    power = np.zeros(n // 2 + 1)
    count = 0
    for offset in range(0, max(1, len(audio) - n + 1), max(1, n // 2)):
        block = audio[offset:offset + n]
        if len(block) < n:
            block = np.pad(block, ((0, n - len(block)), (0, 0)))
        block = block - np.mean(block, axis=0)
        transformed = np.fft.rfft(block * window[:, None], axis=0)
        power += np.mean(np.abs(transformed) ** 2, axis=1) / denominator
        count += 1
    power /= max(1, count)
    power[1:-1] *= 2
    return np.fft.rfftfreq(n, 1 / rate), power, count


def rms_envelope(audio, rate, window_seconds=0.01, hop_seconds=0.0025):
    energy = np.mean(audio * audio, axis=1)
    window = max(1, round(rate * window_seconds))
    hop = max(1, round(rate * hop_seconds))
    starts = np.arange(0, max(1, len(audio) - window + 1), hop)
    ends = np.minimum(starts + window, len(audio))
    cumulative = np.concatenate(([0.0], np.cumsum(energy)))
    rms = np.sqrt(np.maximum(0, (cumulative[ends] - cumulative[starts]) / np.maximum(1, ends - starts)))
    return (starts + (ends - starts) / 2) / rate, rms, rate / hop


def envelope_metrics(audio, rate):
    times, envelope, env_rate = rms_envelope(audio, rate)
    kernel_size = min(len(envelope), max(3, round(env_rate)))
    if kernel_size % 2 == 0:
        kernel_size -= 1
    padded = np.pad(envelope, kernel_size // 2, mode="edge")
    baseline = np.convolve(padded, np.ones(kernel_size) / kernel_size, mode="valid")
    active_floor = max(1e-8, float(np.percentile(envelope, 95)) * 10 ** (-25 / 20))
    active = envelope > active_floor
    relative = np.zeros(len(envelope))
    relative[active] = envelope[active] / np.maximum(baseline[active], active_floor) - 1
    frequency, power, _ = welch(relative, env_rate, 2048)
    delta = frequency[1] - frequency[0]
    total = float(np.sum(power[(frequency >= 0.5) & (frequency < 100)]) * delta)
    modulation = {}
    for low, high in [(0.5, 10), (10, 40), (40, 100)]:
        value = float(np.sum(power[(frequency >= low) & (frequency < high)]) * delta)
        modulation[f"{low:g}-{high:g}_Hz"] = {"power": value, "fraction_of_0.5_100_Hz": value / max(total, 1e-20)}
    below = (envelope < baseline * 0.316227766) & (baseline > active_floor * 2)
    boundaries = np.diff(np.concatenate(([False], below, [False])).astype(np.int8))
    dips = []
    for first, last in zip(np.flatnonzero(boundaries == 1), np.flatnonzero(boundaries == -1)):
        duration = (last - first) / env_rate
        if 0.008 <= duration <= 0.25 and times[first] > 0.25 and times[min(last, len(times) - 1)] < len(audio) / rate - 0.25:
            depth = db(float(np.min(envelope[first:last] / np.maximum(baseline[first:last], 1e-12))))
            dips.append({"start_seconds": float(times[first]), "duration_ms": duration * 1000, "depth_relative_local_rms_db": depth})
    active_env = envelope[active]
    result = {
        "method": "10ms stereo-energy RMS, ~2.5ms hop; one-second local mean removed for relative modulation",
        "active_threshold_db_below_95th_percentile": 25,
        "active_fraction": float(np.mean(active)),
        "active_rms_envelope_cv": float(np.std(active_env) / max(float(np.mean(active_env)), 1e-12)) if len(active_env) else 0,
        "relative_envelope_rms": float(np.sqrt(np.mean(relative[active] ** 2))) if np.any(active) else 0,
        "modulation_bands": modulation,
        "dip_method": "RMS below local mean by >10dB for8-250ms; excludes first/last250ms. Candidates only, not misfires.",
        "dip_candidates_count": len(dips),
        "dip_candidates": sorted(dips, key=lambda item: item["depth_relative_local_rms_db"])[:30],
    }
    return result, times, envelope


def acoustic_peak_metrics(audio, rate):
    times, envelope, env_rate = rms_envelope(audio, rate, 0.001, 0.0005)
    duration = len(audio) / rate
    best = None
    # Only report intervals in locally steady 2s windows with a reasonably
    # repeatable detected acoustic amplitude pattern. This is not an RPM meter.
    for start in np.arange(0.5, max(0.51, duration - 2.5), 1.0):
        segment = envelope[(times >= start) & (times < start + 2)]
        if len(segment) < env_rate or np.mean(segment) < 1e-5:
            continue
        level_cv = float(np.std(segment) / max(np.mean(segment), 1e-12))
        if level_cv > 0.4:
            continue
        indices = np.flatnonzero((segment[1:-1] > segment[:-2]) & (segment[1:-1] >= segment[2:])) + 1
        threshold = np.median(segment) + np.std(segment) * 0.2
        selected = []
        for index in indices:
            if segment[index] > threshold and (not selected or index - selected[-1] >= env_rate * 0.003):
                selected.append(int(index))
        intervals = np.diff(selected) / env_rate
        if len(intervals) < 12:
            continue
        cv = float(np.std(intervals) / np.mean(intervals))
        if cv > 0.3:
            continue
        candidate = {"window_start_seconds": float(start), "window_duration_seconds": 2,
            "count": len(selected), "median_interval_ms": float(np.median(intervals) * 1000),
            "mean_interval_ms": float(np.mean(intervals) * 1000), "interval_cv": cv, "envelope_cv": level_cv}
        if best is None or cv < best["interval_cv"]:
            best = candidate
    return {"status": "repeatable_acoustic_peaks_detected" if best else "no_reliably_repeatable_acoustic_peak_sequence",
        "method": "1ms RMS,0.5ms hop; local maxima above median+0.2SD;3ms refractory;2s steady-window gate;intervalCV<=0.3",
        "interpretation": "Acoustic envelope peaks only. Harmonics, codec, bank interference and microphone response can create or hide peaks. No ignition count, RPM or misfire inference.",
        "best_window": best}


def png_bytes(image):
    height, width, _ = image.shape
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    scan = b"".join(b"\0" + row.tobytes() for row in image)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(scan, 9)) + chunk(b"IEND", b"")


FONT = {
    "A":[14,17,17,31,17,17,17],"B":[30,17,17,30,17,17,30],"C":[14,17,16,16,16,17,14],
    "D":[30,17,17,17,17,17,30],"E":[31,16,16,30,16,16,31],"F":[31,16,16,30,16,16,16],
    "G":[14,17,16,23,17,17,15],"H":[17,17,17,31,17,17,17],"I":[14,4,4,4,4,4,14],
    "J":[7,2,2,2,2,18,12],"K":[17,18,20,24,20,18,17],"L":[16,16,16,16,16,16,31],
    "M":[17,27,21,21,17,17,17],"N":[17,25,21,19,17,17,17],"O":[14,17,17,17,17,17,14],
    "P":[30,17,17,30,16,16,16],"Q":[14,17,17,17,21,18,13],"R":[30,17,17,30,20,18,17],
    "S":[15,16,16,14,1,1,30],"T":[31,4,4,4,4,4,4],"U":[17,17,17,17,17,17,14],
    "V":[17,17,17,17,17,10,4],"W":[17,17,17,21,21,21,10],"X":[17,17,10,4,10,17,17],
    "Y":[17,17,10,4,4,4,4],"Z":[31,1,2,4,8,16,31],
    "0":[14,17,19,21,25,17,14],"1":[4,12,4,4,4,4,14],"2":[14,17,1,2,4,8,31],
    "3":[30,1,1,14,1,1,30],"4":[2,6,10,18,31,2,2],"5":[31,16,16,30,1,1,30],
    "6":[14,16,16,30,17,17,14],"7":[31,1,2,4,8,8,8],"8":[14,17,17,14,17,17,14],
    "9":[14,17,17,15,1,1,14],".":[0,0,0,0,0,12,12],"-":[0,0,0,31,0,0,0],
    "/":[1,2,2,4,8,8,16],"+":[0,4,4,31,4,4,0],":":[0,12,12,0,12,12,0],
    "%":[24,25,2,4,8,19,3]," ":[0,0,0,0,0,0,0],"(":[2,4,8,8,8,4,2],")":[8,4,2,2,2,4,8],
}


def text_pixels(image, x, y, text, scale=1, color=(24,34,42)):
    for character in str(text).upper():
        glyph = FONT.get(character, FONT[" "])
        for row, bits in enumerate(glyph):
            for column in range(5):
                if bits & (1 << (4 - column)):
                    image[max(0,y+row*scale):max(0,y+(row+1)*scale), max(0,x+column*scale):max(0,x+(column+1)*scale)] = color
        x += 6 * scale


def plots(audio, rate, frequency, power, times, envelope, prefix, label):
    width, height = 1200, 810
    image = np.full((height, width, 3), 248, dtype=np.uint8)
    x0, x1 = 75, 1160
    panels = [(50, 215), (285, 445), (515, 750)]
    text_pixels(image, 75, 12, label, 2)
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="#f8f8f8"/><g font-family="Arial,sans-serif" fill="#18222a"><text x="75" y="26" font-size="19">{html.escape(label)}</text>']
    def line(a, b, color=(75, 92, 105)):
        ax, ay = a; bx, by = b
        count = max(1, int(max(abs(bx - ax), abs(by - ay))))
        xs = np.clip(np.rint(np.linspace(ax, bx, count + 1)).astype(int), 0, width - 1)
        ys = np.clip(np.rint(np.linspace(ay, by, count + 1)).astype(int), 0, height - 1)
        image[ys, xs] = color
    def path(points, color):
        for a, b in zip(points[:-1], points[1:]): line(a, b, color)
        svg.append(f'<polyline fill="none" stroke="rgb{color}" stroke-width="1" points="' + " ".join(f"{x:.1f},{y:.1f}" for x, y in points) + '"/>')
    for (top, bottom), title in zip(panels, ["Waveform + 10 ms RMS envelope", "Power spectrum / dB relative to largest bin", "Spectrogram / 20-8000 Hz / 70 dB display range"]):
        line((x0, top), (x0, bottom)); line((x0, bottom), (x1, bottom))
        svg.append(f'<text x="75" y="{top - 12}" font-size="14">{html.escape(title)}</text>')
        text_pixels(image, 75, top - 13, title, 1)
    # Peak-preserving waveform raster, not an amplitude-normalized audio edit.
    mono = np.mean(audio, axis=1)
    scale = max(float(np.max(np.abs(audio))), 1e-8)
    middle = sum(panels[0]) / 2
    wave_points = []
    for column in range(x1 - x0):
        first = int(column * len(mono) / (x1 - x0)); last = max(first + 1, int((column + 1) * len(mono) / (x1 - x0)))
        segment = mono[first:last]
        if len(segment):
            wave_points.extend([(x0 + column, middle - np.min(segment) / scale * 76), (x0 + column, middle - np.max(segment) / scale * 76)])
    path(wave_points, (58, 98, 137))
    indices = np.linspace(0, len(envelope) - 1, min(len(envelope), 1085)).astype(int)
    path([(x0 + times[index] / (len(audio) / rate) * (x1 - x0), middle - envelope[index] / scale * 76) for index in indices], (220, 117, 38))
    selected = (frequency >= 20) & (frequency <= min(20000, rate / 2))
    f, p = frequency[selected], power[selected]
    p_db = 10 * np.log10(np.maximum(p, 1e-24) / max(float(np.max(p)), 1e-24))
    points = [(x0 + (math.log10(freq) - math.log10(20)) / (math.log10(min(20000, rate / 2)) - math.log10(20)) * (x1 - x0), panels[1][1] - np.clip((level + 80) / 80, 0, 1) * (panels[1][1] - panels[1][0])) for freq, level in zip(f, p_db)]
    path(points, (32, 123, 106))
    for value in [20, 80, 200, 1000, 8000, 20000]:
        if value > rate / 2: continue
        x = x0 + (math.log10(value) - math.log10(20)) / (math.log10(min(20000, rate / 2)) - math.log10(20)) * (x1 - x0)
        svg.append(f'<text x="{x:.1f}" y="466" text-anchor="middle" font-size="12">{value:g} Hz</text>')
        text_pixels(image, round(x) - len(str(value)) * 3, 458, f"{value}", 1)
    # Fixed-size FFT spectrogram, linear time and log frequency; same scale for all files.
    n = min(4096, 2 ** int(math.floor(math.log2(max(2, len(mono))))))
    offsets = np.linspace(0, max(0, len(mono) - n), x1 - x0).astype(int)
    window = np.hanning(n); bins = np.fft.rfftfreq(n, 1 / rate)
    spectrum = np.array([np.abs(np.fft.rfft(mono[offset:offset + n] * window)) ** 2 for offset in offsets]).T
    log_f = np.geomspace(min(8000, rate / 2), 20, panels[2][1] - panels[2][0])
    rows = np.minimum(len(bins) - 1, np.searchsorted(bins, log_f))
    spec = spectrum[rows]
    levels = np.clip((10 * np.log10(np.maximum(spec, 1e-24) / max(float(np.max(spec)), 1e-24)) + 70) / 70, 0, 1)
    rgb = np.stack((np.clip(levels * 2.2 - 0.5, 0, 1), np.clip(levels * 1.7, 0, 1), np.clip(1.0 - np.abs(levels - 0.35) * 2, 0, 1)), axis=2)
    raster = np.asarray(rgb * 255, dtype=np.uint8)
    image[panels[2][0]:panels[2][1], x0:x1] = raster
    encoded = base64.b64encode(png_bytes(raster)).decode("ascii")
    svg.append(f'<image x="{x0}" y="{panels[2][0]}" width="{x1-x0}" height="{panels[2][1]-panels[2][0]}" href="data:image/png;base64,{encoded}"/>')
    for value in [20, 80, 200, 1000, 8000]:
        if value > min(8000, rate / 2): continue
        y = panels[2][0] + (math.log(min(8000, rate / 2)) - math.log(value)) / (math.log(min(8000, rate / 2)) - math.log(20)) * (panels[2][1] - panels[2][0])
        svg.append(f'<text x="65" y="{y+4:.1f}" text-anchor="end" font-size="12">{value}</text>')
        text_pixels(image, max(0, 65 - len(str(value)) * 6), round(y), str(value), 1)
    for y in [235, 775]:
        svg.append(f'<text x="75" y="{y}" font-size="12">0 s</text><text x="1160" y="{y}" text-anchor="end" font-size="12">{len(audio)/rate:.3f} s</text>')
        text_pixels(image, 75, y - 7, "0 S", 1)
        text_pixels(image, 1040, y - 7, f"{len(audio)/rate:.3f} S", 1)
    text_pixels(image, 75, 796, "RECORDING ANALYSIS: MIC / CODEC / ROOM / DISTANCE / DRIVING AFFECT ALL MEASUREMENTS", 1)
    svg.append('<text x="75" y="800" font-size="12">Recording analysis: microphone, codec, distance, room and driving affect all measurements. PNG panels follow this SVG layout.</text></g></svg>')
    Path(str(prefix) + ".png").write_bytes(png_bytes(image))
    Path(str(prefix) + ".svg").write_text("".join(svg))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output-prefix", required=True, type=Path)
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--duration", type=float)
    parser.add_argument("--label", default="Engine recording")
    args = parser.parse_args()
    audio, rate, probe = decode(args.input)
    total_frames = len(audio)
    first = max(0, round(args.start * rate))
    last = min(total_frames, first + round(args.duration * rate)) if args.duration is not None else total_frames
    audio = audio[first:last]
    if len(audio) < max(512, rate * 0.05):
        raise ValueError("Select at least50ms of audio")
    frequency, power, segments = welch(audio, rate)
    delta = frequency[1] - frequency[0]
    ceiling = min(20000, rate / 2)
    total_power = float(np.sum(power[(frequency >= 20) & (frequency < ceiling)]) * delta)
    bands = {}
    for low, high in [(20, 80), (80, 200), (200, 500), (500, 2000), (2000, 8000), (8000, 20000)]:
        value = float(np.sum(power[(frequency >= low) & (frequency < min(high, ceiling))]) * delta)
        bands[f"{low}-{high}_Hz"] = {"power": value, "fraction_of_20_20000_Hz": value / max(total_power, 1e-24), "rms_dbfs": db(math.sqrt(value))}
    rms = math.sqrt(float(np.mean(audio * audio))); peak = float(np.max(np.abs(audio)))
    envelope, times, env = envelope_metrics(audio, rate)
    selected = (frequency >= 20) & (frequency < ceiling)
    report = {"schema_version": 1, "analyzer": "carlab-engine-acoustic-analysis-1", "label": args.label,
        "source_file": args.input.name, "source_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
        "source_codec": probe["streams"][0].get("codec_name"), "sample_rate": rate, "channels": audio.shape[1],
        "source_stream_bitrate": probe["streams"][0].get("bit_rate"),
        "source_duration_seconds": total_frames / rate, "segment_start_seconds": first / rate, "duration_seconds": len(audio) / rate,
        "rms_dbfs": db(rms), "peak_dbfs": db(peak), "crest_factor_db": db(peak / max(rms, 1e-12)),
        "dc_per_channel": np.mean(audio, axis=0).tolist(), "fraction_samples_abs_ge_0_999": float(np.mean(np.abs(audio) >= 0.999)),
        "spectral_method": "Hann Welch16384-point FFT,50%overlap; average channel powers to avoid mono cancellation; discrete-bin band integrals",
        "spectral_resolution_hz": delta, "welch_segments": segments, "band_energy": bands,
        "spectral_centroid_hz": float(np.sum(frequency[selected] * power[selected]) / max(float(np.sum(power[selected])), 1e-24)),
        "envelope": envelope, "acoustic_peaks": acoustic_peak_metrics(audio, rate),
        "limitations": ["No certified RPM, ignition, firing-order or misfire inference.",
            "Bass energy can include exhaust, microphone proximity, wind, handling and room modes.",
            "Envelope dips can be gear changes, throttle lift, pass-by movement or recording artefacts.",
            "Compressed preview and source microphone processing can alter both spectrum and micro-transients.",
            "Absolute dBFS is recording level, not calibrated acoustic SPL; compare band ratios and matched operating segments."]}
    args.output_prefix.parent.mkdir(parents=True, exist_ok=True)
    Path(str(args.output_prefix) + ".json").write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n")
    plots(audio, rate, frequency, power, times, env, args.output_prefix, args.label)
    print(json.dumps({"output": str(args.output_prefix), "duration": report["duration_seconds"], "rms_dbfs": report["rms_dbfs"],
        "bass_20_80_fraction": bands["20-80_Hz"]["fraction_of_20_20000_Hz"], "body_80_200_fraction": bands["80-200_Hz"]["fraction_of_20_20000_Hz"],
        "relative_envelope_rms": envelope["relative_envelope_rms"], "dip_candidates": envelope["dip_candidates_count"],
        "acoustic_peaks_status": report["acoustic_peaks"]["status"]}))


if __name__ == "__main__":
    main()
