import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sourceRevision } from './source-revision.mjs';

function repository(run) {
  const root = mkdtempSync(join(tmpdir(), 'carlab-source-identity-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=CarLab Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q');
    writeFileSync(join(root, 'source.txt'), 'original source\n');
    git('add', 'source.txt'); git('commit', '-qm', 'source release');
    run({ root, git, revision: git('rev-parse', 'HEAD') });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('release identity requires an explicit real source commit', () => repository(({ root, revision }) => {
  assert.throws(() => sourceRevision({ root, revision: '', requireExplicit: true }), /required/);
  assert.throws(() => sourceRevision({ root, revision: 'abc' }), /full lowercase/);
  assert.throws(() => sourceRevision({ root, revision: '1'.repeat(40) }), /available source commit/);
  assert.deepEqual(sourceRevision({ root, revision, requireExplicit: true }), { sourceCommit: revision, sourceIdentity: 'explicit-verified' });
  assert.equal(sourceRevision({ root, revision: '' }).sourceIdentity, 'development-unverified');
}));

test('runner snapshots are rejected as release identity while their identical source tree is accepted', () => repository(({ root, revision, git }) => {
  git('commit', '--allow-empty', '-qm', 'lm-remote example-job');
  assert.throws(() => sourceRevision({ root, revision: git('rev-parse', 'HEAD'), requireExplicit: true }), /runner snapshot/);
  assert.equal(sourceRevision({ root, revision, requireExplicit: true }).sourceCommit, revision);
}));

test('different committed source, tracked edits and untracked files cannot reuse an old release identity', () => repository(({ root, revision, git }) => {
  writeFileSync(join(root, 'source.txt'), 'changed source\n');
  assert.throws(() => sourceRevision({ root, revision, requireExplicit: true }), /uncommitted changes/);
  git('add', 'source.txt'); git('commit', '-qm', 'new source');
  assert.throws(() => sourceRevision({ root, revision, requireExplicit: true }), /does not match/);
  const current = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'extra.txt'), 'untracked source\n');
  assert.throws(() => sourceRevision({ root, revision: current, requireExplicit: true }), /uncommitted changes/);
}));
