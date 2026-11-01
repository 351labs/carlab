import assert from 'node:assert/strict';
import test from 'node:test';
import { catalog } from './locales/catalog.ts';
import { getLocale, getI18nDiagnostics, locales, setLocale, subscribeLocale, t } from './i18n.ts';

test('catalog rows contain seven nonempty translations and preserve interpolation tokens', () => {
 for (const row of catalog) {
  assert.equal(row.length, 7);
  for (const text of row) assert.ok(text.trim(), `Empty translation for ${row[1]}`);
  const tokens = (text: string) => [...text.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
  for (const text of row) assert.deepEqual(tokens(text), tokens(row[1]), `Tokens differ for ${row[1]}`);
 }
});

test('language changes, parameters, fallback and unsubscribe work without browser globals', () => {
 const original = getLocale(); let calls = 0;
 const unsubscribe = subscribeLocale(() => calls++);
 try {
  for (const { code } of locales) {
   setLocale(code);
   assert.equal(getLocale(), code);
   assert.ok(t('Engine').length);
   assert.ok(t('{count} cylinders', { count: 12 }).includes('12'));
   assert.equal(t('Unknown phrase {count}', { count: 42 }), 'Unknown phrase 42');
  }
  assert.ok(getI18nDiagnostics().missingEnglish.includes('Unknown phrase {count}'));
  assert.equal(calls, locales.length);
  unsubscribe(); setLocale('en'); assert.equal(calls, locales.length);
  assert.equal(t('Engine'), 'Engine');
  setLocale('pt'); assert.equal(t('Engine'), 'Motor');
 } finally { unsubscribe(); setLocale(original); }
});

test('Portuguese aliases for the same English key agree in other languages', () => {
 const seen = new Map<string, readonly string[]>();
 for (const row of catalog) {
  const previous = seen.get(row[1]);
  if (previous) assert.deepEqual(row.slice(2), previous.slice(2), `Conflicting translations for ${row[1]}`);
  else seen.set(row[1], row);
 }
});
