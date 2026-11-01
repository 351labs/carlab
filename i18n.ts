import { catalog } from './locales/catalog.ts';

export const locales = [
 { code: 'pt', label: 'Português' }, { code: 'en', label: 'English' },
 { code: 'zh', label: '简体中文' }, { code: 'ja', label: '日本語' },
 { code: 'es', label: 'Español' }, { code: 'ko', label: '한국어' },
 { code: 'fr', label: 'Français' },
] as const;
export type Locale = typeof locales[number]['code'];
const storageKey = 'carlab-engine-lab-locale';
const valid = (value: string | null): value is Locale => locales.some(item => item.code === value);
function initialLocale(): Locale {
 if (typeof window === 'undefined') return 'pt';
 const query = new URL(window.location.href).searchParams.get('lang');
 if (valid(query)) return query;
 try { const stored = window.localStorage.getItem(storageKey); if (valid(stored)) return stored; } catch { /* Storage is optional. */ }
 return 'pt';
}
let locale: Locale = initialLocale();
const listeners = new Set<() => void>();
const byEnglish = new Map<string, readonly string[]>();
const byPortuguese = new Map<string, string>();
for (const row of catalog) { byEnglish.set(row[1], row); byPortuguese.set(row[0], row[1]); }
const columns: Record<Locale, number> = { pt: 0, en: 1, zh: 2, ja: 3, es: 4, ko: 5, fr: 6 };
const missingEnglish = new Set<string>();
const missingLegacy = new Set<string>();
export function getLocale(): Locale { return locale; }
export function setLocale(next: string): void {
 if (!valid(next)) return;
 locale = next;
 if (typeof document !== 'undefined') document.documentElement.lang = next === 'zh' ? 'zh-Hans' : next;
 if (typeof window !== 'undefined') {
  try { window.localStorage.setItem(storageKey, next); } catch { /* Private browsing may disable storage. */ }
  const url = new URL(window.location.href); url.searchParams.set('lang', next);
  window.history.replaceState(window.history.state, '', url);
 }
 listeners.forEach(listener => listener());
}
export function subscribeLocale(callback: () => void): () => void {
 listeners.add(callback); return () => listeners.delete(callback);
}
/** English source phrases are the keys. Unknown phrases remain visible. */
export function t(source: string, params: Record<string, string | number> = {}): string {
 const row = byEnglish.get(source);
 if (!row && source !== 'CARLAB / ENGINE LAB' && missingEnglish.size < 500) missingEnglish.add(source);
 return (row?.[columns[locale]] ?? source).replace(/\{([\w]+)\}/g, (match, key: string) => Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
}
/** Distinct untranslated keys observed since page load; useful for catalog review. */
export function getI18nDiagnostics(): { missingEnglish: string[]; missingLegacy: string[] } {
 return { missingEnglish: [...missingEnglish].sort(), missingLegacy: [...missingLegacy].sort() };
}

type RecordState = { source: string; rendered: string };
const excluded = 'script,style,pre,code,#library-project,#library-revision,[contenteditable="true"],[data-i18n-off]';
const textExcluded = `${excluded},textarea,input,canvas`;
const attributes = ['aria-label', 'title', 'placeholder'] as const;
function translateLegacy(raw: string): string {
 // Preserve the original legacy wording in Portuguese, including synonymous aliases.
 if (locale === 'pt') return raw;
 const match = raw.match(/^(\s*)(.*?)(\s*)$/s); if (!match || !match[2]) return raw;
 const [, before, content, after] = match;
 let key = byPortuguese.get(content);
 let params: Record<string, string> | undefined;
 const custom = content.match(/^(\d+) cilindros · (em linha|opostos|V de ([\d.,]+)°) · ([\d.,]+) L · (aspirado|([\d.,]+) bar de pressão alvo)(?: · limite em ([\d.,]+) RPM\.|\. Ajuste o motor e ouça como cada parte muda a voz\.)$/);
 if (custom) {
  const layout = custom[2] === 'em linha' ? t('Inline') : custom[2] === 'opostos' ? t('Opposed') : t('V at {angle}°', { angle: custom[3] });
  const aspiration = custom[5] === 'aspirado' ? t('Naturally aspirated') : t('{pressure} bar target boost', { pressure: custom[6] });
  const detail = t('{count} cylinders · {layout} · {displacement} L · {aspiration}', { count: custom[1], layout, displacement: custom[4], aspiration });
  return before + (custom[7] ? t('{detail} · limit at {rpm} RPM.', { detail, rpm: custom[7] }) : t('{detail}. Adjust the engine and hear how each part changes the voice.', { detail })) + after;
 }
 const metadata = content.match(/^([\d.,]+ L · )(ASPIRADO|TURBO)( · [\d.,]+ RPM)$/);
 if (metadata) return before + metadata[1] + (metadata[2] === 'ASPIRADO' ? t('NATURALLY ASPIRATED') : 'TURBO') + metadata[3] + after;
 const cylinder = content.match(/^(\d+) cilindros$/);
 if (cylinder) { key = '{count} cylinders'; params = { count: cylinder[1] }; }
 if (!key) {
  // Only track prose-like legacy strings; never rewrite unknown dynamic or user data.
  if (!locales.some(item => item.label === content) && missingLegacy.size < 500 && content.length < 180 && /[A-Za-zÀ-ÿ]{3}/.test(content) && /[À-ÿ]/.test(content)) missingLegacy.add(content);
  return raw;
 }
 return before + t(key, params) + after;
}
/** Translate legacy DOM without replacing elements, inputs, code, JSON or canvas contents.
 * Returns a disposer. A WeakMap retains canonical source across language changes. */
export function mountI18n(root: HTMLElement): () => void {
 const texts = new WeakMap<Text, RecordState>();
 const attrs = new WeakMap<Element, Map<string, RecordState>>();
 let stopped = false;
 const skip = (element: Element | null) => !!element?.closest(excluded);
 function textNode(node: Text): void {
  if (node.parentElement?.closest(textExcluded)) return;
  const current = node.data; const previous = texts.get(node);
  const source = previous && current === previous.rendered ? previous.source : current;
  const rendered = translateLegacy(source);
  texts.set(node, { source, rendered }); if (current !== rendered) node.data = rendered;
 }
 function element(node: Element): void {
  if (skip(node)) return;
  let state = attrs.get(node); if (!state) { state = new Map(); attrs.set(node, state); }
  for (const attr of attributes) {
   const current = node.getAttribute(attr); if (current === null) { state.delete(attr); continue; }
   const previous = state.get(attr); const source = previous && current === previous.rendered ? previous.source : current;
   const rendered = translateLegacy(source); state.set(attr, { source, rendered });
   if (current !== rendered) node.setAttribute(attr, rendered);
  }
 }
 function walk(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) { textNode(node as Text); return; }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element; if (skip(el)) return;
  element(el); if (el.matches('textarea,input,canvas')) return;
  for (const child of Array.from(el.childNodes)) walk(child);
 }
 const observer = new MutationObserver(records => {
  observer.disconnect();
  for (const record of records) {
   if (record.type === 'attributes') element(record.target as Element);
   else if (record.type === 'characterData') textNode(record.target as Text);
   else for (const node of Array.from(record.addedNodes)) walk(node);
  }
  if (!stopped) observe();
 });
 function observe(): void { observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...attributes] }); }
 function refresh(): void { observer.disconnect(); walk(root); if (!stopped) observe(); }
 if (typeof document !== 'undefined') document.documentElement.lang = locale === 'zh' ? 'zh-Hans' : locale;
 refresh(); const unsubscribe = subscribeLocale(refresh);
 return () => { stopped = true; observer.disconnect(); unsubscribe(); };
}
