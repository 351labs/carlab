/** Small, deterministic PCM/ZIP exporters. No recordings, codecs or runtime dependencies. */
export interface ExportFile { name: string; data: Uint8Array }

function ascii(view: DataView, offset: number, value: string): void {
	for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
}

/** Interleaved stereo, little-endian signed 16-bit PCM. Non-finite samples become silence. */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Uint8Array {
	if (left.length !== right.length) throw new RangeError('Stereo channel lengths must match.');
	if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
		throw new RangeError('Sample rate must be an integer from 8000 to 192000 Hz.');
	}
	const bytes = left.length * 4;
	if (bytes > 0xffffffff - 36) throw new RangeError('Audio is too large for a RIFF WAV.');
	const result = new Uint8Array(44 + bytes);
	const view = new DataView(result.buffer);
	ascii(view, 0, 'RIFF'); view.setUint32(4, 36 + bytes, true); ascii(view, 8, 'WAVE');
	ascii(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
	view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true);
	view.setUint16(32, 4, true); view.setUint16(34, 16, true); ascii(view, 36, 'data'); view.setUint32(40, bytes, true);
	for (let frame = 0; frame < left.length; frame++) {
		for (let channel = 0; channel < 2; channel++) {
			const source = (channel ? right : left)[frame]!;
			const sample = Number.isFinite(source) ? Math.max(-1, Math.min(1, source)) : 0;
			view.setInt16(44 + frame * 4 + channel * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
		}
	}
	return result;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
	let value = byte;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
	return value >>> 0;
});

export function crc32(data: Uint8Array): number {
	let value = 0xffffffff;
	for (let index = 0; index < data.length; index++) value = crcTable[(value ^ data[index]!) & 255]! ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

/** ZIP32, stored entries, UTF-8 filenames, fixed 1980 date for reproducible bytes. */
export function zipFiles(files: ExportFile[]): Uint8Array {
	if (files.length > 65535) throw new RangeError('Too many ZIP entries.');
	const encoder = new TextEncoder();
	const seen = new Set<string>();
	const entries = files.map((file) => {
		if (!file.name || file.name.startsWith('/') || file.name.includes('\\') || file.name.split('/').includes('..') || seen.has(file.name)) {
			throw new RangeError('ZIP names must be unique, relative, and free of parent paths.');
		}
		seen.add(file.name);
		const name = encoder.encode(file.name);
		if (name.length > 65535 || file.data.length > 0xffffffff) throw new RangeError('ZIP entry is too large.');
		return { ...file, encodedName: name, crc: crc32(file.data), offset: 0 };
	});
	const localSize = entries.reduce((sum, entry) => sum + 30 + entry.encodedName.length + entry.data.length, 0);
	const directorySize = entries.reduce((sum, entry) => sum + 46 + entry.encodedName.length, 0);
	if (localSize + directorySize + 22 > 0xffffffff) throw new RangeError('ZIP32 archive is too large.');
	const result = new Uint8Array(localSize + directorySize + 22);
	const view = new DataView(result.buffer);
	let offset = 0;
	for (const entry of entries) {
		entry.offset = offset;
		view.setUint32(offset, 0x04034b50, true); view.setUint16(offset + 4, 20, true);
		view.setUint16(offset + 6, 0x0800, true); view.setUint16(offset + 12, 0x21, true);
		view.setUint32(offset + 14, entry.crc, true); view.setUint32(offset + 18, entry.data.length, true);
		view.setUint32(offset + 22, entry.data.length, true); view.setUint16(offset + 26, entry.encodedName.length, true);
		result.set(entry.encodedName, offset + 30);
		result.set(entry.data, offset + 30 + entry.encodedName.length);
		offset += 30 + entry.encodedName.length + entry.data.length;
	}
	for (const entry of entries) {
		view.setUint32(offset, 0x02014b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 20, true);
		view.setUint16(offset + 8, 0x0800, true); view.setUint16(offset + 14, 0x21, true);
		view.setUint32(offset + 16, entry.crc, true); view.setUint32(offset + 20, entry.data.length, true);
		view.setUint32(offset + 24, entry.data.length, true); view.setUint16(offset + 28, entry.encodedName.length, true);
		view.setUint32(offset + 42, entry.offset, true); result.set(entry.encodedName, offset + 46);
		offset += 46 + entry.encodedName.length;
	}
	view.setUint32(offset, 0x06054b50, true); view.setUint16(offset + 8, entries.length, true);
	view.setUint16(offset + 10, entries.length, true); view.setUint32(offset + 12, directorySize, true);
	view.setUint32(offset + 16, localSize, true);
	return result;
}
