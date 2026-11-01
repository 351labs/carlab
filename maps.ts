/** Operating maps are declarations with provenance, not engine truth inferred
 * from a preset name or sound. All pressure axes are ABSOLUTE bar. */
export type CalibrationKind = 've' | 'indicatedEfficiency' | 'fmep';
export type ParameterSource = 'assumed' | 'fitted' | 'measured';
export interface CalibrationProvenance {
	readonly source: ParameterSource;
	readonly label: string;
	readonly version: string;
	readonly engineId?: string;
	readonly notes?: string;
	readonly calibratedAt?: string;
	readonly validation?: { readonly label: string; readonly date?: string; readonly independent: boolean };
}
export interface CalibrationMap {
	readonly schema: 'carlab-calibration-map-1';
	readonly kind: CalibrationKind;
	readonly rpm: readonly number[];
	readonly pressureBar: readonly number[];
	/** values[rpmIndex][pressureIndex]. */
	readonly values: readonly (readonly number[])[];
	readonly axisUnits: { readonly rpm: 'rpm'; readonly pressure: 'bar-absolute' };
	readonly valueUnit: 'fraction' | 'bar';
	readonly provenance: CalibrationProvenance;
	readonly extrapolation: 'clamp';
}
export interface CalibrationSample {
	readonly value: number;
	readonly extrapolated: boolean;
	readonly extrapolatedAxes: readonly ('rpm' | 'pressure')[];
	readonly clampedRpm: number;
	readonly clampedPressureBar: number;
	readonly source: ParameterSource;
	readonly mapLabel: string;
	readonly provenance: CalibrationProvenance;
}
export interface CalibrationBundle {
	readonly schema: 'carlab-calibration-bundle-1';
	readonly maps: Readonly<Partial<Record<CalibrationKind, CalibrationMap>>>;
}

const SPECS: Record<CalibrationKind, { unit: CalibrationMap['valueUnit']; min: number; max: number }> = {
	ve: { unit: 'fraction', min: 0.2, max: 1.3 },
	indicatedEfficiency: { unit: 'fraction', min: 0.05, max: 1 },
	fmep: { unit: 'bar', min: 0, max: 5 },
};
const KINDS = ['ve', 'indicatedEfficiency', 'fmep'] as const;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function record(input: unknown): input is Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
	const prototype = Object.getPrototypeOf(input);
	return prototype === Object.prototype || prototype === null;
}
function fail(message: string): never { throw new TypeError(`Mapa de calibração: ${message}`); }
function text(value: unknown, name: string, max: number, optional = false): string | undefined {
	if (optional && value === undefined) return undefined;
	if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) fail(`${name} inválido.`);
	return value.trim();
}
function date(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d(?:T.*)?$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${name} inválida.`);
	return value;
}
function axis(input: unknown, name: string, lo: number, hi: number): readonly number[] {
	if (!Array.isArray(input) || input.length < 2 || input.length > 32) fail(`${name} precisa de 2 a 32 pontos.`);
	const result = Array.from(input);
	for (let i = 0; i < result.length; i++) {
		if (typeof result[i] !== 'number' || !Number.isFinite(result[i]) || result[i] < lo || result[i] > hi) fail(`${name} contém valor inválido.`);
		if (i && result[i] <= result[i - 1]) fail(`${name} precisa ser estritamente crescente, sem duplicatas.`);
	}
	return Object.freeze(result as number[]);
}
function provenance(input: unknown): CalibrationProvenance {
	if (!record(input) || typeof input.source !== 'string' || !['assumed', 'fitted', 'measured'].includes(input.source)) fail('origem precisa ser assumed, fitted ou measured.');
	if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 2000)) fail('anotações inválidas.');
	let validation: CalibrationProvenance['validation'];
	if (input.validation !== undefined) {
		if (!record(input.validation) || typeof input.validation.independent !== 'boolean') fail('validação precisa declarar independent como booleano.');
		validation = Object.freeze({ label: text(input.validation.label, 'descrição da validação', 200)!,
			...(input.validation.date === undefined ? {} : { date: date(input.validation.date, 'data de validação')! }), independent: input.validation.independent });
	}
	return Object.freeze({ source: input.source as ParameterSource, label: text(input.label, 'nome da origem', 160)!,
		version: text(input.version, 'versão', 60)!,
		...(input.engineId === undefined ? {} : { engineId: text(input.engineId, 'identificador do motor', 120)! }),
		...(input.notes === undefined ? {} : { notes: (input.notes as string).trim() }),
		...(input.calibratedAt === undefined ? {} : { calibratedAt: date(input.calibratedAt, 'data de calibração')! }),
		...(validation ? { validation } : {}) });
}

/** A missing map may use an explicit fallback. A malformed provided map throws:
 * silently replacing measured/fitted content would corrupt its provenance. */
export function normalizeCalibrationMap(input: unknown, kind: CalibrationKind, fallback?: CalibrationMap): CalibrationMap {
	if (input === undefined && fallback !== undefined) input = fallback;
	if (!record(input)) fail('objeto ausente ou inválido.');
	if (input.schema !== 'carlab-calibration-map-1' || input.kind !== kind || !SPECS[kind]) fail('formato ou grandeza incompatível.');
	if (!record(input.axisUnits) || input.axisUnits.rpm !== 'rpm' || input.axisUnits.pressure !== 'bar-absolute') fail('use eixos rpm e bar-absolute.');
	const spec = SPECS[kind];
	if (input.valueUnit !== spec.unit || input.extrapolation !== 'clamp') fail('unidade ou política de extrapolação incompatível.');
	const rpm = axis(input.rpm, 'RPM', 0, 22000), pressureBar = axis(input.pressureBar, 'pressão absoluta em bar', 0.05, 8);
	if (!Array.isArray(input.values) || input.values.length !== rpm.length) fail('número de linhas diferente do eixo RPM.');
	const values = Array.from(input.values, row => {
		if (!Array.isArray(row) || row.length !== pressureBar.length) fail('cada linha deve cobrir todo o eixo de pressão.');
		const result = Array.from(row);
		if (result.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < spec.min || v > spec.max)) fail(`valores de ${kind} devem estar entre ${spec.min} e ${spec.max} ${spec.unit}.`);
		return Object.freeze(result as number[]);
	});
	return Object.freeze({ schema: 'carlab-calibration-map-1', kind, rpm, pressureBar, values: Object.freeze(values),
		axisUnits: Object.freeze({ rpm: 'rpm', pressure: 'bar-absolute' }), valueUnit: spec.unit,
		provenance: provenance(input.provenance), extrapolation: 'clamp' });
}

function bracket(axis: readonly number[], value: number): [number, number, number] {
	let low = 0, high = axis.length - 1;
	while (high - low > 1) { const middle = (low + high) >>> 1; if (axis[middle] <= value) low = middle; else high = middle; }
	return [low, high, (value - axis[low]) / (axis[high] - axis[low])];
}

/** Bilinear lookup of a normalized map. Out-of-domain requests are clamped and
 * flagged; measured provenance does not imply accuracy outside its domain. */
export function sampleCalibrationMap(map: CalibrationMap, rpm: number, pressureBar: number): CalibrationSample {
	if (!Number.isFinite(rpm) || !Number.isFinite(pressureBar)) fail('consulta precisa de RPM e pressão finitos.');
	if (!map || !SPECS[map.kind] || map.rpm.length < 2 || map.pressureBar.length < 2) fail('normalize o mapa antes da consulta.');
	const clampedRpm = clamp(rpm, map.rpm[0], map.rpm.at(-1)!), clampedPressureBar = clamp(pressureBar, map.pressureBar[0], map.pressureBar.at(-1)!);
	const [r0, r1, rt] = bracket(map.rpm, clampedRpm), [p0, p1, pt] = bracket(map.pressureBar, clampedPressureBar);
	const a = map.values[r0][p0], b = map.values[r0][p1], c = map.values[r1][p0], d = map.values[r1][p1];
	if (![a, b, c, d, rt, pt].every(Number.isFinite)) fail('grade inválida; normalize o mapa antes da consulta.');
	const value = (a + (b - a) * pt) * (1 - rt) + (c + (d - c) * pt) * rt;
	const extrapolatedAxes: ('rpm' | 'pressure')[] = [];
	if (clampedRpm !== rpm) extrapolatedAxes.push('rpm');
	if (clampedPressureBar !== pressureBar) extrapolatedAxes.push('pressure');
	return { value, extrapolated: extrapolatedAxes.length > 0, extrapolatedAxes, clampedRpm, clampedPressureBar,
		source: map.provenance.source, mapLabel: map.provenance.label, provenance: map.provenance };
}

/** An original demonstrator curve, explicitly assumed. The shaped version is
 * not a geometry-derived prediction or a measured engine's calibration. */
export function createAssumedVeMap(idleRpm: number, redlineRpm: number, baseVe = 0.9, mode: 'uniform' | 'shaped' = 'shaped'): CalibrationMap {
	if (!Number.isFinite(idleRpm) || !Number.isFinite(redlineRpm) || idleRpm < 0 || redlineRpm <= idleRpm || redlineRpm > 22000) fail('faixa de giro para mapa assumido inválida.');
	const base = Number.isFinite(baseVe) ? clamp(baseVe, 0.2, 1.3) : 0.9;
	const rpm = [idleRpm, idleRpm + (redlineRpm - idleRpm) * 0.3, idleRpm + (redlineRpm - idleRpm) * 0.6, redlineRpm];
	const pressureBar = [0.15, 0.5, 1, 2, 4];
	const speedFactors = [0.8, 0.95, 1, 0.84], pressureFactors = [0.9, 0.96, 1, 1.015, 1.02];
	return normalizeCalibrationMap({ schema: 'carlab-calibration-map-1', kind: 've', rpm, pressureBar,
		values: speedFactors.map(r => pressureFactors.map(p => mode === 'uniform' ? base : clamp(base * r * p, 0.2, 1.3))),
		axisUnits: { rpm: 'rpm', pressure: 'bar-absolute' }, valueUnit: 'fraction', extrapolation: 'clamp',
		provenance: { source: 'assumed', label: mode === 'uniform' ? 'Hipótese uniforme de enchimento' : 'Hipótese genérica de enchimento por RPM e MAP', version: 'original-demo-1',
			engineId: 'generic-four-stroke', notes: 'Curva original de demonstração, sem dados medidos ou ajustados. Não prevê efeitos de geometria, comando ou ressonância.' } }, 've');
}

export function calibrationSnapshot(maps: Partial<Record<CalibrationKind, CalibrationMap>>): CalibrationBundle {
	const normalized: Partial<Record<CalibrationKind, CalibrationMap>> = {};
	for (const kind of KINDS) if (maps[kind] !== undefined) normalized[kind] = normalizeCalibrationMap(maps[kind], kind);
	return Object.freeze({ schema: 'carlab-calibration-bundle-1', maps: Object.freeze(normalized) });
}

export function parseCalibrationBundle(input: unknown): CalibrationBundle {
	let parsed = input;
	if (typeof parsed === 'string') { if (parsed.length > 200_000) fail('arquivo de mapas grande demais.'); try { parsed = JSON.parse(parsed); } catch { fail('JSON inválido.'); } }
	if (!record(parsed) || parsed.schema !== 'carlab-calibration-bundle-1' || !record(parsed.maps)) fail('pacote precisa de formato carlab-calibration-bundle-1.');
	if (Object.keys(parsed.maps).some(key => !KINDS.includes(key as CalibrationKind))) fail('grandeza desconhecida no pacote.');
	const maps: Partial<Record<CalibrationKind, CalibrationMap>> = {};
	for (const kind of KINDS) if (parsed.maps[kind] !== undefined) maps[kind] = normalizeCalibrationMap(parsed.maps[kind], kind);
	return calibrationSnapshot(maps);
}
