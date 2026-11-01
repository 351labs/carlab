import type { EngineConfig } from './dsp.ts';
import { normalizeConfig } from './presets.ts';

export const LIBRARY_STORAGE_KEY = 'carlab-engine-lab-library-v1';
export const MAX_PROJECTS = 40;
export const MAX_REVISIONS = 12;
export const MAX_EXHAUSTS = 40;
const MAX_DOCUMENT_BYTES = 2_000_000;
const MAX_PHYSICAL_BYTES = 256_000;

export interface ProjectPayload {
	engine: EngineConfig;
	/** The physics module owns the interpretation and normalization of these inputs. */
	physical?: Record<string, unknown>;
}
export interface ProjectRevision extends ProjectPayload {
	id: string;
	createdAt: string;
	notes: string;
}
export interface SavedProject {
	id: string;
	name: string;
	revisions: ProjectRevision[];
}
export const EXHAUST_FIELDS = ['exhaustLength', 'headerLength', 'pipeDiameter', 'muffler', 'crossover', 'temperature', 'damping'] as const;
export type ExhaustSnapshot = Pick<EngineConfig, typeof EXHAUST_FIELDS[number]>;
export const PHYSICAL_EXHAUST_FIELDS = ['exhaustVolumeL', 'exhaustRestrictionK', 'exhaustFrictionFactor'] as const;
export type PhysicalExhaustSnapshot = Partial<Record<typeof PHYSICAL_EXHAUST_FIELDS[number], number>>;
const PHYSICAL_EXHAUST_BOUNDS = {
	exhaustVolumeL: [0.1, 30], exhaustRestrictionK: [0, 100], exhaustFrictionFactor: [0.005, 0.12],
} as const;
export interface SavedExhaust {
	id: string;
	name: string;
	createdAt: string;
	config: ExhaustSnapshot;
	/** Optional in schema 1 so older acoustic-only recipes remain importable. */
	physical?: PhysicalExhaustSnapshot;
}
export interface ProjectLibrary {
	kind: 'carlab-engine-library';
	schema: 1;
	projects: SavedProject[];
	exhausts: SavedExhaust[];
}

export function emptyLibrary(): ProjectLibrary {
	return { kind: 'carlab-engine-library', schema: 1, projects: [], exhausts: [] };
}

function record(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function text(value: unknown, maximum: number, label: string, required = true): string {
	if (typeof value !== 'string') throw new Error(`${label} inválido.`);
	const result = value.trim();
	if ((required && !result) || result.length > maximum) throw new Error(`${label}: use ${required ? '1 a ' : 'até '}${maximum} caracteres.`);
	return result;
}

function timestamp(value: unknown): string {
	if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Data de versão inválida.');
	return new Date(value).toISOString();
}

function jsonCopy(value: unknown, depth = 0): unknown {
	if (depth > 12) throw new Error('Configuração física contém níveis demais.');
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (Array.isArray(value)) {
		if (value.length > 256) throw new Error('Lista física grande demais.');
		// Array.from exposes holes as undefined instead of silently serializing them
		// to null, which would corrupt imported calibration maps or material tables.
		return Array.from(value, item => jsonCopy(item, depth + 1));
	}
	if (record(value)) {
		const output: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Campo físico reservado.');
			output[key] = jsonCopy(item, depth + 1);
		}
		return output;
	}
	throw new Error('Configuração física deve conter apenas dados JSON finitos.');
}

export function copyProject(input: unknown): ProjectPayload {
	if (!record(input) || !record(input.engine)) throw new Error('Projeto sem configuração de motor.');
	const engine = input.engine;
	if (typeof engine.cylinders !== 'number' || !Number.isFinite(engine.cylinders)
		|| typeof engine.displacement !== 'number' || !Number.isFinite(engine.displacement)) throw new Error('Configuração de motor inválida.');
	const result: ProjectPayload = { engine: normalizeConfig(engine as Partial<EngineConfig>) };
	if (input.physical !== undefined) {
		if (!record(input.physical)) throw new Error('Configuração física deve ser um objeto.');
		result.physical = jsonCopy(input.physical) as Record<string, unknown>;
		if (JSON.stringify(result.physical).length > MAX_PHYSICAL_BYTES) throw new Error('Configuração física grande demais.');
	}
	return result;
}

export function captureExhaust(engine: EngineConfig): ExhaustSnapshot {
	const normalized = normalizeConfig(engine);
	return Object.fromEntries(EXHAUST_FIELDS.map(key => [key, normalized[key]])) as ExhaustSnapshot;
}

/** Capture only physical exhaust boundary conditions, never the donor's engine,
 * calibration maps, thermal states or material evidence. No values are invented
 * when an older project does not provide these fields.
 */
export function capturePhysicalExhaust(physical: unknown): PhysicalExhaustSnapshot | undefined {
	if (physical === undefined) return undefined;
	if (!record(physical)) throw new Error('Parâmetros físicos do escape inválidos.');
	const snapshot: PhysicalExhaustSnapshot = {};
	for (const key of PHYSICAL_EXHAUST_FIELDS) {
		if (!Object.hasOwn(physical, key)) continue;
		const value = physical[key], [minimum, maximum] = PHYSICAL_EXHAUST_BOUNDS[key];
		if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Parâmetro físico do escape inválido: ${key}.`);
		snapshot[key] = value;
	}
	return Object.keys(snapshot).length ? snapshot : undefined;
}

function normalizePhysicalExhaust(input: unknown): PhysicalExhaustSnapshot | undefined {
	if (!record(input) || Object.keys(input).some(key => !(PHYSICAL_EXHAUST_FIELDS as readonly string[]).includes(key))) throw new Error('Receita física de escape contém campos não permitidos.');
	return capturePhysicalExhaust(input);
}

/** Merge the exhaust-only patch into fresh JSON data. The physical-model owner
 * still normalizes the resulting complete configuration before using it.
 */
export function applyPhysicalExhaust(physical: unknown, exhaust?: PhysicalExhaustSnapshot): Record<string, unknown> {
	if (physical !== undefined && !record(physical)) throw new Error('Configuração física inválida.');
	const base = physical === undefined ? {} : jsonCopy(physical) as Record<string, unknown>;
	const patch = exhaust === undefined ? undefined : normalizePhysicalExhaust(exhaust);
	const result = { ...base, ...patch };
	if (JSON.stringify(result).length > MAX_PHYSICAL_BYTES) throw new Error('Configuração física grande demais.');
	return result;
}

/** Display declared provenance without implying that the measurements or fit
 * were independently validated. Data remain untouched in the saved project.
 */
export function physicalProvenanceSummary(physical: unknown): string[] {
	if (!record(physical)) return [];
	const candidates: [string, unknown][] = [['Hipóteses físicas', physical.provenance]];
	for (const [key, label] of [['veMap', 'Mapa de enchimento'], ['indicatedEfficiencyMap', 'Mapa de eficiência'], ['fmepMap', 'Mapa de atrito']] as const) {
		if (record(physical[key])) candidates.push([label, physical[key].provenance]);
	}
	const labels: Record<string, string> = { assumed: 'assumido', fitted: 'ajustado', measured: 'medido' };
	return candidates.flatMap(([name, provenance]) => {
		if (!record(provenance)) return [];
		const source = typeof provenance.source === 'string' && Object.hasOwn(labels, provenance.source) ? labels[provenance.source] : 'origem não informada';
		const label = typeof provenance.label === 'string' ? provenance.label.trim().slice(0, 160) : '';
		const version = typeof provenance.version === 'string' ? provenance.version.trim().slice(0, 60) : '';
		const notes = typeof provenance.notes === 'string' ? provenance.notes.trim().slice(0, 180) : '';
		return [`${name}: ${source}${label ? ` · ${label}` : ''}${version ? ` · ${version}` : ''}${notes ? ` · ${notes}` : ''}`];
	});
}

function normalizeExhaust(input: unknown): ExhaustSnapshot {
	if (!record(input) || EXHAUST_FIELDS.some(key => typeof input[key] !== 'number' || !Number.isFinite(input[key]))) throw new Error('Receita de escape inválida.');
	return captureExhaust(normalizeConfig(input as Partial<EngineConfig>));
}

/** Changing an exhaust never recalls the donor engine's topology, character or mix. */
export function applyExhaust(engine: EngineConfig, exhaust: ExhaustSnapshot): EngineConfig {
	return normalizeConfig({ ...engine, ...normalizeExhaust(exhaust) });
}

function uniqueIds(items: { id: string }[], label: string): void {
	if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(`Identificadores duplicados em ${label}.`);
}

export function parseLibrary(raw: string | null): ProjectLibrary {
	if (raw === null) return emptyLibrary();
	if (raw.length > MAX_DOCUMENT_BYTES) throw new Error('Biblioteca grande demais.');
	let source: unknown;
	try { source = JSON.parse(raw); } catch { throw new Error('Biblioteca JSON inválida.'); }
	if (!record(source) || source.kind !== 'carlab-engine-library' || source.schema !== 1
		|| !Array.isArray(source.projects) || !Array.isArray(source.exhausts)) throw new Error('Formato ou versão de biblioteca não reconhecido.');
	if (source.projects.length > MAX_PROJECTS || source.exhausts.length > MAX_EXHAUSTS) throw new Error('Biblioteca excede o limite de projetos ou escapes.');
	const projects: SavedProject[] = source.projects.map((item: unknown) => {
		if (!record(item) || !Array.isArray(item.revisions) || !item.revisions.length || item.revisions.length > MAX_REVISIONS) throw new Error('Histórico de projeto inválido.');
		const revisions = item.revisions.map((revision: unknown): ProjectRevision => {
			if (!record(revision)) throw new Error('Versão inválida.');
			return { ...copyProject(revision), id: text(revision.id, 100, 'ID de versão'), createdAt: timestamp(revision.createdAt), notes: text(revision.notes, 4000, 'Notas', false) };
		});
		uniqueIds(revisions, 'versões');
		return { id: text(item.id, 100, 'ID de projeto'), name: text(item.name, 100, 'Nome'), revisions };
	});
	const exhausts: SavedExhaust[] = source.exhausts.map((item: unknown) => {
		if (!record(item)) throw new Error('Escape inválido.');
		const physical = item.physical === undefined ? undefined : normalizePhysicalExhaust(item.physical);
		return { id: text(item.id, 100, 'ID de escape'), name: text(item.name, 100, 'Nome do escape'), createdAt: timestamp(item.createdAt), config: normalizeExhaust(item.config), ...(physical ? { physical } : {}) };
	});
	uniqueIds(projects, 'projetos');
	uniqueIds(exhausts, 'escapes');
	return { kind: 'carlab-engine-library', schema: 1, projects, exhausts };
}

export function serializeLibrary(library: ProjectLibrary): string {
	const raw = JSON.stringify(library, null, 2);
	parseLibrary(raw);
	return raw;
}

function id(): string {
	return globalThis.crypto.randomUUID();
}

export function saveProject(library: ProjectLibrary, input: { id?: string; name: string; notes: string; project: ProjectPayload }, now = new Date().toISOString()): { library: ProjectLibrary; projectId: string } {
	const next = parseLibrary(serializeLibrary(library));
	const name = text(input.name, 100, 'Nome');
	const notes = text(input.notes, 4000, 'Notas', false);
	const existing = input.id ? next.projects.find(project => project.id === input.id) : undefined;
	if (input.id && !existing) throw new Error('Projeto selecionado não existe mais.');
	if (!existing && next.projects.length >= MAX_PROJECTS) throw new Error(`Limite de ${MAX_PROJECTS} projetos atingido. Exporte ou remova um projeto.`);
	const revision: ProjectRevision = { ...copyProject(input.project), id: id(), createdAt: timestamp(now), notes };
	if (existing) {
		existing.name = name;
		existing.revisions.unshift(revision);
		existing.revisions.length = Math.min(existing.revisions.length, MAX_REVISIONS);
		return { library: next, projectId: existing.id };
	}
	const projectId = id();
	next.projects.unshift({ id: projectId, name, revisions: [revision] });
	return { library: next, projectId };
}

export function saveExhaust(library: ProjectLibrary, name: string, engine: EngineConfig, now = new Date().toISOString(), physicalInput?: unknown): { library: ProjectLibrary; exhaustId: string } {
	const next = parseLibrary(serializeLibrary(library));
	if (next.exhausts.length >= MAX_EXHAUSTS) throw new Error(`Limite de ${MAX_EXHAUSTS} escapes atingido.`);
	const exhaustId = id();
	const physical = capturePhysicalExhaust(physicalInput);
	next.exhausts.unshift({ id: exhaustId, name: text(name, 100, 'Nome do escape'), createdAt: timestamp(now), config: captureExhaust(engine), ...(physical ? { physical } : {}) });
	return { library: next, exhaustId };
}

/** Import appends independent copies; an imported ID cannot overwrite a local project. */
export function mergeLibraries(local: ProjectLibrary, imported: ProjectLibrary): ProjectLibrary {
	const next = parseLibrary(serializeLibrary(local));
	const incoming = parseLibrary(serializeLibrary(imported));
	if (next.projects.length + incoming.projects.length > MAX_PROJECTS || next.exhausts.length + incoming.exhausts.length > MAX_EXHAUSTS) throw new Error('Importação excede o limite da biblioteca.');
	next.projects.push(...incoming.projects.map(project => ({ ...project, id: id(), revisions: project.revisions.map(revision => ({ ...revision, id: id() })) })));
	next.exhausts.push(...incoming.exhausts.map(exhaust => ({ ...exhaust, id: id() })));
	return next;
}
