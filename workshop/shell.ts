import type { EngineConfig } from '../dsp.ts';
import type { PhysicalConfig } from '../powertrain.ts';
import { presets } from '../presets.ts';
import { t, getLocale, setLocale, locales, subscribeLocale } from '../i18n.ts';
import type { LabMode, PartId } from './types.ts';

type Options = {
  getConfig: () => EngineConfig;
  getPhysical: () => PhysicalConfig;
  applyConfig: (patch: Partial<EngineConfig>) => void;
  applyPhysical: (patch: Partial<PhysicalConfig>) => void;
  selectPreset: (index: number) => void;
  onPart: (part: PartId) => void;
  onMode: (mode: LabMode) => void;
  onFuel: (fuel: string) => void;
};
const parts: PartId[] = ['engine', 'turbo', 'exhaust', 'injection', 'instruments'];
const partNames: Record<PartId, string> = { engine: 'Engine', turbo: 'Turbo', exhaust: 'Exhaust', injection: 'Injection', instruments: 'Instruments' };
const modeNames: Record<LabMode, string> = { normal: 'Normal', enthusiast: 'Enthusiast', scholar: 'Scholar' };
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

export function mountWorkshopShell(host: HTMLElement, options: Options): {
  canvasHost: HTMLElement; setPart(part: PartId): void; getPart(): PartId; getMode(): LabMode; refresh(): void; dispose(): void;
} {
  let part: PartId = 'engine';
  let mode: LabMode = 'normal';
  let exploded = 0, cutaway = false;
  let fuel = 'unavailable';
  try {
    const requested = new URLSearchParams(location.search).get('mode');
    const saved = localStorage.getItem('carlab-engine-lab-mode');
    const candidate = requested ?? saved;
    if (candidate === 'normal' || candidate === 'enthusiast' || candidate === 'scholar') mode = candidate;
  } catch { /* The workshop works without browser storage. */ }
  host.classList.add('workshop');
  host.innerHTML = `<div class="workshop-top"><div class="workshop-title"><span class="workshop-kicker"></span><h2></h2><p class="workshop-mode-description"></p><p class="workshop-scholar-note"></p></div><div class="workshop-settings"><label class="workshop-mode-label"><span></span><select data-workshop-mode></select></label><label class="workshop-language"><span></span><select data-workshop-language></select></label></div></div><div class="workshop-body"><div class="workshop-stage"><div class="workshop-stage-head"><div><span class="workshop-stage-index">01 / 05</span><h3></h3><p></p></div><span class="workshop-stage-mark">CarLab / STUDIO</span></div><div id="workshop-canvas" class="workshop-canvas"></div><div class="workshop-stage-foot"><div class="workshop-view-controls"><button type="button" data-view="exploded"></button><button type="button" data-view="cutaway"></button><button type="button" data-view="reset"></button></div><span class="workshop-gesture"></span><span class="workshop-illustration"></span></div></div><div class="workshop-panel"><div class="workshop-panel-header"><span></span><strong></strong></div><nav class="workshop-parts" aria-label="Parts"></nav><div class="workshop-content"></div><div class="workshop-panel-foot"></div></div></div>`;
  const q = <T extends HTMLElement>(selector: string): T => host.querySelector<T>(selector)!;
  const canvasHost = q<HTMLElement>('#workshop-canvas');
  const setMode = (next: LabMode) => {
    if (next !== 'normal' && next !== 'enthusiast' && next !== 'scholar') return;
    mode = next;
    document.documentElement.dataset.mode = mode;
    try { localStorage.setItem('carlab-engine-lab-mode', mode); const url = new URL(location.href); url.searchParams.set('mode', mode); history.replaceState(history.state, '', url); } catch { /* Optional persistence. */ }
    options.onMode(mode);
  };
  const view = () => host.dispatchEvent(new CustomEvent('workshop-view', { detail: { exploded, cutaway } }));
  const range = (key: string, label: string, min: number, max: number, step: number, unit: string) => `<label class="workshop-range"><span><b>${escape(t(label))}</b><output data-value="${key}"></output></span><input type="range" data-config="${key}" min="${min}" max="${max}" step="${step}" aria-label="${escape(t(label))}"><small>${escape(unit)}</small></label>`;
  const renderContent = () => {
    let content = '';
    if (part === 'engine') content = `<p class="workshop-copy">${escape(t('Start with a voice, then shape its character.'))}</p><label class="workshop-field"><span>${escape(t('Engine preset'))}</span><select data-preset-select><option value="custom" disabled>${escape(t('Custom configuration'))}</option>${presets.map((preset, i) => `<option value="${i}">${escape(t(preset.name))}</option>`).join('')}</select></label>${range('displacement','Displacement',.1,12,.1,'L')}${range('compression','Compression',6,16,.1,': 1')}`;
    if (part === 'turbo') content = `<p class="workshop-copy">${escape(t('Choose an aspiration setup. Boost and size change the model.'))}</p><div class="workshop-choices"><button type="button" data-turbo="na">${escape(t('Naturally aspirated'))}<small>0 bar</small></button><button type="button" data-turbo="compact">${escape(t('Compact turbo'))}<small>0.8 bar</small></button><button type="button" data-turbo="large">${escape(t('Larger turbo'))}<small>1.4 bar</small></button></div>${range('boostBar','Target boost',0,2.5,.05,'bar')}${range('turboSize','Turbo size',0,1,.01,'')}<p class="workshop-note workshop-turbo-note"></p>`;
    if (part === 'exhaust') content = `<p class="workshop-copy">${escape(t('Change the acoustic path and its assumed physical restriction.'))}</p><div class="workshop-choices"><button type="button" data-exhaust-recipe="street">${escape(t('Street'))}<small>${escape(t('More attenuation'))}</small></button><button type="button" data-exhaust-recipe="sport">${escape(t('Sport'))}<small>${escape(t('Balanced'))}</small></button><button type="button" data-exhaust-recipe="open">${escape(t('Open'))}<small>${escape(t('Less attenuation'))}</small></button></div>${range('muffler','Muffler attenuation',0,1,.01,'')}`;
    if (part === 'injection') content = `<p class="workshop-copy">${escape(t('Choose a fuel for the ECU model. Physical driving is required for live EFI behavior.'))}</p><label class="workshop-field"><span>${escape(t('Fuel'))}</span><select data-fuel><option value="unavailable" disabled>${escape(t('ECU not configured'))}</option><option value="custom" disabled>${escape(t('Custom blend'))}</option><option value="gasoline">${escape(t('Gasoline'))}</option><option value="ethanol">${escape(t('Ethanol'))}</option><option value="e85">E85</option><option value="diesel">${escape(t('Diesel'))}</option></select></label><p class="workshop-note">${escape(t('Fuel selection preserves engine geometry and calibration. Diesel uses prescribed combustion.'))}</p><p class="workshop-drive-status" role="status"></p><button type="button" data-workshop-drive class="workshop-drive">${escape(t('Use physical driving'))}</button><a class="workshop-link" data-open-efi href="#ecu-panel">${escape(t('Open EFI controls'))} ↗</a>`;
    if (part === 'instruments') content = `<p class="workshop-copy">${escape(t('The live tachometer and signal are below the workshop. Start the engine to listen and watch.'))}</p><a class="workshop-link" href="#gauge">${escape(t('View instruments'))} ↓</a><div class="workshop-note">${escape(t('The visual model is illustrative. Readings come from the simulation.'))}</div>`;
    q('.workshop-content').innerHTML = content;
    refresh();
  };
  const renderLabels = () => {
    q('.workshop-kicker').textContent = 'CarLab / ENGINE SOUND STUDIO';
    q('.workshop-title h2').textContent = t('The workshop');
    const descriptions: Record<LabMode, string> = { normal: 'Choose parts and listen.', enthusiast: 'Tune, drive and compare.', scholar: 'Explore maps, cycles and evidence.' };
    q('.workshop-mode-description').textContent = t(descriptions[mode]);
    q('.workshop-scholar-note').textContent = t('Technical notes and imported research remain in their source language.');
    q('.workshop-mode-label span').textContent = t('Experience');
    q('.workshop-language span').textContent = t('Language');
    q<HTMLSelectElement>('[data-workshop-mode]').innerHTML = (Object.keys(modeNames) as LabMode[]).map(id => `<option value="${id}">${escape(t(modeNames[id]))}</option>`).join('');
    q<HTMLSelectElement>('[data-workshop-mode]').value = mode;
    q<HTMLSelectElement>('[data-workshop-language]').innerHTML = locales.map(locale => `<option value="${escape(locale.code)}">${escape(locale.label)}</option>`).join('');
    q<HTMLSelectElement>('[data-workshop-language]').value = getLocale();
    q('.workshop-parts').setAttribute('aria-label', t('Parts'));
    q('.workshop-parts').innerHTML = parts.map((id, i) => `<button type="button" data-part="${id}" aria-pressed="${part === id}"><span>0${i + 1}</span>${escape(t(partNames[id]))}<b>↗</b></button>`).join('');
    q('.workshop-panel-header span').textContent = t('SELECT A PART');
    q('.workshop-panel-header strong').textContent = '05';
    q('.workshop-stage-index').textContent = `0${parts.indexOf(part) + 1} / 05`;
    q('.workshop-stage-head h3').textContent = t(partNames[part]);
    q('.workshop-stage-head p').textContent = t('Interactive model');
    q('.workshop-gesture').textContent = t('Drag to rotate · scroll to zoom');
    q('.workshop-illustration').textContent = t('Illustrative geometry · slowed motion · not CAD or CFD');
    q('[data-view="exploded"]').textContent = t('Exploded');
    q('[data-view="cutaway"]').textContent = t('Cutaway');
    q('[data-view="reset"]').textContent = t('Reset view');
    q('.workshop-panel-foot').textContent = t('An instrument for exploring engine sound.');
    renderContent();
  };
  const refresh = () => {
    const config = options.getConfig();
    host.querySelectorAll<HTMLInputElement>('[data-config]').forEach(input => {
      const key = input.dataset.config as keyof EngineConfig;
      const value = Number(config[key]);
      if (!Number.isFinite(value)) return;
      input.value = String(value);
      const output = host.querySelector<HTMLOutputElement>(`[data-value="${key}"]`);
      if (output) {
        const digits = key === 'boostBar' || key === 'turboSize' || key === 'muffler' ? 2 : 1;
        const formatted = new Intl.NumberFormat(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
        output.textContent = `${formatted}${key === 'displacement' ? ' L' : key === 'compression' ? ' : 1' : key === 'boostBar' ? ' bar' : ''}`;
      }
    });
    const fuelSelect = host.querySelector<HTMLSelectElement>('[data-fuel]');
    const ecu = options.getPhysical().ecu;
    if (ecu?.fuel) {
      const fraction = ecu.fuel.ethanolVolumeFraction;
      fuel = ecu.combustionMode === 'directInjectionDiesel' ? 'diesel' : fraction === 0 ? 'gasoline' : fraction === 1 ? 'ethanol' : Math.abs(fraction - .85) < .001 ? 'e85' : 'custom';
    } else fuel = 'unavailable';
    if (fuelSelect) fuelSelect.value = fuel;
    const driveStatus = host.querySelector<HTMLElement>('.workshop-drive-status');
    if (driveStatus) driveStatus.textContent = t(document.querySelector('#physical-enable')?.classList.contains('active') ? 'Physical driving active' : 'Manual or acoustic scenario active');
    const turboNote = host.querySelector<HTMLElement>('.workshop-turbo-note');
    if (turboNote) { turboNote.hidden = config.boostBar > 0; turboNote.textContent = t('Turbo inactive: target boost is zero.'); }
    const presetSelect = host.querySelector<HTMLSelectElement>('[data-preset-select]');
    if (presetSelect) {
      const match = presets.findIndex(p => Object.keys(p.config).every(key => JSON.stringify(p.config[key as keyof EngineConfig]) === JSON.stringify(config[key as keyof EngineConfig])));
      presetSelect.value = match < 0 ? 'custom' : String(match);
    }
    q('[data-view="exploded"]').setAttribute('aria-pressed', String(exploded > 0));
    q('[data-view="cutaway"]').setAttribute('aria-pressed', String(cutaway));
  };
  const setPart = (next: PartId) => { if (!parts.includes(next)) return; part = next; renderLabels(); options.onPart(part); };
  const onClick = (event: Event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('[data-open-efi]');
    if (link && host.contains(link) && mode === 'normal') {
      event.preventDefault(); setMode('enthusiast'); renderLabels(); document.querySelector('#ecu-panel')?.scrollIntoView({ behavior: 'smooth' }); return;
    }
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || !host.contains(button)) return;
    if (button.dataset.part) setPart(button.dataset.part as PartId);
    if (button.hasAttribute('data-workshop-drive')) host.dispatchEvent(new CustomEvent('workshop-drive'));
    if (button.dataset.view) {
      if (button.dataset.view === 'exploded') exploded = exploded ? 0 : 1;
      if (button.dataset.view === 'cutaway') cutaway = !cutaway;
      if (button.dataset.view === 'reset') { exploded = 0; cutaway = false; host.dispatchEvent(new CustomEvent('workshop-view', { detail: { exploded, cutaway, reset: true } })); } else view();
      refresh();
    }
    if (button.dataset.turbo) {
      const patches: Record<string, Partial<EngineConfig>> = { na: {boostBar:0, turboSize:0}, compact:{boostBar:.8,turboSize:.25}, large:{boostBar:1.4,turboSize:.75} };
      options.applyConfig(patches[button.dataset.turbo]); refresh();
    }
    if (button.dataset.exhaustRecipe) {
      const patches: Record<string, {config:Partial<EngineConfig>; physical:Partial<PhysicalConfig>}> = {
        street:{config:{muffler:.75,exhaustLength:2.2,pipeDiameter:50},physical:{exhaustRestrictionK:8}},
        sport:{config:{muffler:.35,exhaustLength:1.7,pipeDiameter:65},physical:{exhaustRestrictionK:4}},
        open:{config:{muffler:.05,exhaustLength:1.1,pipeDiameter:80},physical:{exhaustRestrictionK:2}}
      };
      const recipe = patches[button.dataset.exhaustRecipe]; options.applyConfig(recipe.config); options.applyPhysical(recipe.physical); refresh();
    }
  };
  const onInput = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.config) { options.applyConfig({[input.dataset.config]: Number(input.value)} as Partial<EngineConfig>); refresh(); }
  };
  const onChange = (event: Event) => {
    const select = event.target as HTMLSelectElement;
    if (select.matches('[data-workshop-mode]')) { setMode(select.value as LabMode); renderLabels(); }
    if (select.matches('[data-workshop-language]')) setLocale(select.value as ReturnType<typeof getLocale>);
    if (select.matches('[data-preset-select]')) { options.selectPreset(Number(select.value)); refresh(); }
    if (select.matches('[data-fuel]')) { fuel = select.value; options.onFuel(fuel); refresh(); }
  };
  host.addEventListener('click', onClick); host.addEventListener('input', onInput); host.addEventListener('change', onChange);
  const unsubscribe = subscribeLocale(renderLabels);
  setMode(mode); renderLabels();
  return { canvasHost, setPart, getPart: () => part, getMode: () => mode, refresh, dispose: () => { host.removeEventListener('click', onClick); host.removeEventListener('input', onInput); host.removeEventListener('change', onChange); unsubscribe(); host.replaceChildren(); host.classList.remove('workshop'); } };
}
