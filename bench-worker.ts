/// <reference lib="webworker" />
import { analyzeClip, auditionBankTransition, createBlindTrial, cropSegment, lockRenderOptions, matchLevels, renderLockedCandidate,
	type BankAuditionOptions, type MatchOptions, type StereoClip } from './listening-bench.ts';
import type { RenderOptions } from './offline.ts';
import type { EngineConfig } from './dsp.ts';
import { initializeBackend,type BackendName } from './backend.ts';

export type BenchWorkerRequest =
	| { type: 'analyze'; id: string | number; clip: StereoClip; startSeconds?: number; endSeconds?: number }
	| { type: 'bank-audition'; id: string | number; config: EngineConfig; options?: BankAuditionOptions }
	| { type: 'compare'; id: string | number; configs: { id: string; config: EngineConfig }[]; options: RenderOptions;
		reference?: StereoClip; match?: MatchOptions; seed?: number };

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<BenchWorkerRequest & {backend?:BackendName}>): Promise<void> => {
	const request = event.data;
	if (!request || (request.type !== 'analyze' && request.type !== 'compare' && request.type !== 'bank-audition')) return;
	const progress = (fraction: number, message: string): void => scope.postMessage({ type: 'progress', id: request.id, progress: fraction, message });
	try {
		await initializeBackend(request.backend??'rust');
		if (request.type === 'bank-audition') {
			const audition = auditionBankTransition(request.config, request.options, (value) => progress(value * 0.95, 'Construindo e auditando os loops reais do banco'));
			const analysis = analyzeClip(audition.clip);
			analysis.warnings.push(...audition.warnings);
			const clips = [{ id: 'Banco RPM × carga', clip: audition.clip, analysis, gainDb: 0 }];
			progress(1, 'Varredura de banco pronta');
			scope.postMessage({ type: 'complete', id: request.id, kind: 'bank-audition', clips,
				options: audition.options, bankTrace: audition.trace, matching: { mode: 'none', warnings: audition.warnings }, blind: null },
				[audition.clip.left.buffer, audition.clip.right.buffer] as ArrayBuffer[]);
			return;
		}
		if (request.type === 'analyze') {
			progress(0, 'Analisando seleção local');
			const clip = cropSegment(request.clip, request.startSeconds ?? 0, request.endSeconds ?? request.clip.left.length / request.clip.sampleRate);
			const analysis = analyzeClip(clip);
			progress(1, 'Análise concluída');
			scope.postMessage({ type: 'complete', id: request.id, kind: 'analyze', clip, analysis }, [clip.left.buffer, clip.right.buffer] as ArrayBuffer[]);
			return;
		}
		if (!Array.isArray(request.configs) || request.configs.length < 1 || request.configs.length > 3) throw new RangeError('Compare de uma a três configurações.');
		const ids = request.configs.map((candidate) => candidate.id);
		if (new Set(ids).size !== ids.length || ids.some((id) => !id || id === 'Referência')) throw new RangeError('Identificadores de comparação inválidos.');
		const reference = request.reference ? cropSegment(request.reference) : undefined;
		const options = lockRenderOptions(request.configs.map((candidate) => candidate.config), {
			...request.options, ...(reference ? { duration: reference.left.length / reference.sampleRate, sampleRate: reference.sampleRate } : {}),
		});
		const candidates: { id: string; clip: StereoClip }[] = reference ? [{ id: 'Referência', clip: reference }] : [];
		for (let index = 0; index < request.configs.length; index++) {
			const candidate = request.configs[index];
			const clip = renderLockedCandidate(candidate.config, options, (value) => progress((index + value) / request.configs.length * 0.7, `Renderizando ${candidate.id}`));
			candidates.push({ id: candidate.id, clip });
		}
		progress(0.72, 'Igualando nível e medindo');
		const matched = matchLevels(candidates.map((candidate) => candidate.clip), request.match);
		const clips = candidates.map((candidate, index) => {
			const clip = matched.clips[index], analysis = analyzeClip(clip);
			progress(0.75 + (index + 1) / candidates.length * 0.24, `Medindo ${candidate.id}`);
			return { id: candidate.id, clip, analysis, gainDb: matched.gainDb[index] };
		});
		const blind = clips.length >= 2 ? createBlindTrial(clips.map((candidate) => candidate.id), request.seed ?? 1) : null;
		const { clips: _audio, ...matching } = matched;
		progress(1, 'Comparação pronta');
		scope.postMessage({ type: 'complete', id: request.id, kind: 'compare', clips, blind, matching, options },
			clips.flatMap((candidate) => [candidate.clip.left.buffer, candidate.clip.right.buffer]) as ArrayBuffer[]);
	} catch (error) {
		scope.postMessage({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
	}
};
