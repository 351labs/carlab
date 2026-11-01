import {
	LIBRARY_STORAGE_KEY, MAX_REVISIONS, emptyLibrary, parseLibrary, serializeLibrary,
	saveProject, saveExhaust, copyProject, mergeLibraries, capturePhysicalExhaust, physicalProvenanceSummary,
	type ProjectLibrary, type ProjectPayload, type ExhaustSnapshot, type PhysicalExhaustSnapshot,
} from './projects.ts';

export interface LibraryOptions {
	getProject(): ProjectPayload;
	applyProject(project: ProjectPayload): void;
	applyExhaust(exhaust: ExhaustSnapshot, physical?: PhysicalExhaustSnapshot): void;
	notify(message: string): void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, className?: string): HTMLElementTagNameMap[K] {
	const result = document.createElement(tag);
	if (content !== undefined) result.textContent = content;
	if (className) result.className = className;
	return result;
}

function field(label: string, input: HTMLElement): HTMLLabelElement {
	const result = element('label', undefined, 'library-field');
	result.append(element('span', label), input);
	return result;
}

/** This panel never uploads recordings or writes local storage until an explicit save/import/remove. */
export function mountLibrary(container: HTMLElement, options: LibraryOptions): { refresh(): void; dispose(): void } {
	const panel = element('section', undefined, 'library-panel');
	panel.append(element('h3', 'Biblioteca de vozes'), element('p', `Projetos neste navegador, com até ${MAX_REVISIONS} versões por voz. Exporte um backup para levar a biblioteca a outro dispositivo.`));
	const projectSelect = element('select'); projectSelect.id = 'library-project';
	const name = element('input'); name.id = 'library-name'; name.maxLength = 100; name.value = 'Minha voz'; name.placeholder = 'Ex.: V12 clássico · escape de rua';
	const notes = element('textarea'); notes.id = 'library-notes'; notes.maxLength = 4000; notes.rows = 3; notes.placeholder = 'Referência, intenção sonora e o que precisa melhorar…';
	const revisionSelect = element('select'); revisionSelect.id = 'library-revision';
	const fields = element('div', undefined, 'library-fields');
	fields.append(field('Projeto salvo', projectSelect), field('Nome da voz', name), field('Anotações desta versão', notes), field('Histórico', revisionSelect));
	const evidence = element('p', undefined, 'panel-note'); evidence.id = 'library-provenance'; evidence.setAttribute('aria-live', 'polite');
	const actions = element('div', undefined, 'library-actions');
	const save = element('button', 'Salvar projeto'); save.id = 'library-save';
	const load = element('button', 'Carregar versão'); load.id = 'library-load';
	const fresh = element('button', 'Novo projeto'); fresh.id = 'library-new';
	const remove = element('button', 'Remover projeto'); remove.id = 'library-remove';
	const exportButton = element('button', 'Exportar biblioteca'); exportButton.id = 'library-export';
	const importButton = element('button', 'Importar e acrescentar'); importButton.id = 'library-import';
	const importFile = element('input'); importFile.type = 'file'; importFile.accept = '.json,application/json'; importFile.hidden = true;
	actions.append(save, load, fresh, remove, exportButton, importButton, importFile);
	const exhaustName = element('input'); exhaustName.id = 'library-exhaust-name'; exhaustName.maxLength = 100; exhaustName.placeholder = 'Ex.: longo e abafado';
	const exhaustSelect = element('select'); exhaustSelect.id = 'library-exhaust';
	const exhaustFields = element('div', undefined, 'library-fields');
	exhaustFields.append(field('Nome do escape atual', exhaustName), field('Receitas salvas', exhaustSelect));
	const exhaustActions = element('div', undefined, 'library-actions');
	const exhaustSave = element('button', 'Salvar escape'); exhaustSave.id = 'library-exhaust-save';
	const exhaustApply = element('button', 'Aplicar escape'); exhaustApply.id = 'library-exhaust-apply';
	const exhaustRemove = element('button', 'Remover escape'); exhaustRemove.id = 'library-exhaust-remove';
	exhaustActions.append(exhaustSave, exhaustApply, exhaustRemove);
	const status = element('p', 'Nenhum projeto carregado.', 'library-status'); status.id = 'library-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
	panel.append(fields, evidence, actions, element('h4', 'Escapes independentes'), element('p', 'Salve a geometria acústica e, quando definidos, o volume e as perdas físicas do escape para experimentar em outro motor. A receita preserva arquitetura, mapas, térmica e materiais do motor atual.'), exhaustFields, exhaustActions, status);
	container.append(panel);
	let library: ProjectLibrary = emptyLibrary();
	let storageFault = false;
	let disposed = false;
	const cleanup: (() => void)[] = [];
	function on(target: HTMLElement, event: string, handler: EventListener): void { target.addEventListener(event, handler); cleanup.push(() => target.removeEventListener(event, handler)); }
	function message(value: string, error = false): void {
		status.textContent = value;
		status.classList.toggle('error', error);
		options.notify(value);
	}
	function attempt(action: () => void): void { try { action(); } catch (error) { message(error instanceof Error ? error.message : 'Não foi possível concluir a ação.', true); } }
	function persist(next: ProjectLibrary): void {
		const encoded = serializeLibrary(next);
		try { localStorage.setItem(LIBRARY_STORAGE_KEY, encoded); }
		catch { throw new Error('Não foi possível salvar neste navegador. Verifique espaço/permissões e exporte um backup.'); }
		library = next;
		storageFault = false;
	}
	function project() { return library.projects.find(item => item.id === projectSelect.value); }
	function revision() { return project()?.revisions.find(item => item.id === revisionSelect.value); }
	function date(value: string): string { return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
	function renderEvidence(physical: unknown, saved = true): void {
		const summary = physicalProvenanceSummary(physical);
		evidence.textContent = summary.length ? `Origem declarada ${saved ? 'da versão selecionada' : 'dos ajustes atuais'} — ${summary.join('; ')}. A declaração de origem não comprova calibração ou validação independente.` : 'Sem origem física declarada nesta versão. Você pode registrar a origem nas notas antes de salvar.';
	}
	function renderRevisions(): void {
		const current = project();
		revisionSelect.replaceChildren();
		for (let index = 0; index < (current?.revisions.length ?? 0); index++) {
			const item = current!.revisions[index];
			const option = element('option', `v${current!.revisions.length - index} · ${date(item.createdAt)}`); option.value = item.id; revisionSelect.append(option);
		}
		if (!current) { const option = element('option', 'Sem versões salvas'); option.value = ''; revisionSelect.append(option); }
		load.disabled = !current; remove.disabled = !current; revisionSelect.disabled = !current;
		save.textContent = current ? 'Salvar nova versão' : 'Salvar projeto';
		const selected = revision(); renderEvidence(selected ? selected.physical : options.getProject().physical, !!selected);
	}
	function refresh(): void {
		if (disposed) return;
		const selectedProject = projectSelect.value;
		const selectedExhaust = exhaustSelect.value;
		projectSelect.replaceChildren();
		const freshOption = element('option', 'Novo projeto'); freshOption.value = ''; projectSelect.append(freshOption);
		for (const item of library.projects) { const option = element('option', item.name); option.value = item.id; projectSelect.append(option); }
		projectSelect.value = library.projects.some(item => item.id === selectedProject) ? selectedProject : '';
		exhaustSelect.replaceChildren();
		const emptyExhaust = element('option', 'Escolha um escape'); emptyExhaust.value = ''; exhaustSelect.append(emptyExhaust);
		for (const item of library.exhausts) { const option = element('option', item.name); option.value = item.id; exhaustSelect.append(option); }
		exhaustSelect.value = library.exhausts.some(item => item.id === selectedExhaust) ? selectedExhaust : '';
		exhaustApply.disabled = !exhaustSelect.value; exhaustRemove.disabled = !exhaustSelect.value;
		save.disabled = storageFault; exhaustSave.disabled = storageFault;
		exportButton.disabled = storageFault || (!library.projects.length && !library.exhausts.length);
		renderRevisions();
	}
	function selectProject(id: string): void {
		projectSelect.value = id;
		const current = project();
		if (current) { name.value = current.name; notes.value = current.revisions[0].notes; }
		renderRevisions();
	}
	on(projectSelect, 'change', () => selectProject(projectSelect.value));
	on(revisionSelect, 'change', () => { const selected = revision(); if (selected) { notes.value = selected.notes; renderEvidence(selected.physical); } });
	on(fresh, 'click', () => { selectProject(''); name.value = 'Minha voz'; notes.value = ''; message('O motor atual será salvo como um projeto novo.'); });
	on(save, 'click', () => attempt(() => {
		const result = saveProject(library, { id: projectSelect.value || undefined, name: name.value, notes: notes.value, project: options.getProject() });
		persist(result.library); refresh(); selectProject(result.projectId);
		message('Voz e configuração física salvas neste navegador.');
	}));
	on(load, 'click', () => attempt(() => {
		const selected = revision(); if (!selected) throw new Error('Escolha uma versão.');
		options.applyProject(copyProject(selected)); notes.value = selected.notes; renderEvidence(selected.physical);
		message('Versão carregada. Os ajustes atuais só entram no histórico quando você salvar.');
	}));
	on(remove, 'click', () => attempt(() => {
		const selected = project(); if (!selected) return;
		persist({ ...library, projects: library.projects.filter(item => item.id !== selected.id) }); refresh();
		message('Projeto removido da biblioteca local. O motor em edição continua disponível.');
	}));
	on(exhaustSave, 'click', () => attempt(() => {
		const current = options.getProject();
		const result = saveExhaust(library, exhaustName.value, current.engine, undefined, current.physical);
		persist(result.library); refresh(); exhaustSelect.value = result.exhaustId; exhaustApply.disabled = false; exhaustRemove.disabled = false;
		message('Geometria e parâmetros físicos disponíveis do escape salvos separadamente.');
	}));
	on(exhaustSelect, 'change', () => { exhaustApply.disabled = !exhaustSelect.value; exhaustRemove.disabled = !exhaustSelect.value; });
	on(exhaustApply, 'click', () => attempt(() => {
		const selected = library.exhausts.find(item => item.id === exhaustSelect.value); if (!selected) throw new Error('Escolha um escape.');
		options.applyExhaust({ ...selected.config }, capturePhysicalExhaust(selected.physical));
		message(selected.physical ? 'Geometria e perdas físicas do escape aplicadas ao motor atual.' : 'Escape acústico aplicado. A receita antiga preserva os parâmetros físicos atuais.');
	}));
	on(exhaustRemove, 'click', () => attempt(() => {
		if (!exhaustSelect.value) return;
		persist({ ...library, exhausts: library.exhausts.filter(item => item.id !== exhaustSelect.value) }); refresh(); message('Escape removido da biblioteca local.');
	}));
	on(exportButton, 'click', () => attempt(() => {
		const url = URL.createObjectURL(new Blob([serializeLibrary(library)], { type: 'application/json' }));
		const anchor = element('a'); anchor.href = url; anchor.download = 'carlab-engine-library-v1.json'; anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 30_000); message('Backup da biblioteca exportado.');
	}));
	on(importButton, 'click', () => importFile.click());
	on(importFile, 'change', () => {
		const file = importFile.files?.[0]; importFile.value = ''; if (!file) return;
		if (file.size > 2_000_000) { message('Arquivo de biblioteca grande demais.', true); return; }
		void file.text().then(raw => {
			if (disposed) return;
			attempt(() => { const imported = parseLibrary(raw); persist(mergeLibraries(library, imported)); refresh(); message('Biblioteca importada. Os projetos anteriores foram preservados.'); });
		}).catch(() => { if (!disposed) message('Não foi possível ler o arquivo escolhido.', true); });
	});
	try { library = parseLibrary(localStorage.getItem(LIBRARY_STORAGE_KEY)); }
	catch (error) { storageFault = true; message(`Biblioteca local indisponível: ${error instanceof Error ? error.message : 'erro de leitura'} Importe um backup válido para recuperar; os dados existentes não foram substituídos.`, true); }
	refresh();
	return { refresh, dispose() { disposed = true; for (const removeListener of cleanup) removeListener(); panel.remove(); } };
}
