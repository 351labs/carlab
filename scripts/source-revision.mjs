import { execFileSync } from 'node:child_process';

/** Bind a release to an existing, clean source tree rather than a runner SHA. */
export function sourceRevision({ root, revision = process.env.CARLAB_SOURCE_COMMIT, requireExplicit = false }) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!revision) {
    if (requireExplicit) throw new Error('CARLAB_SOURCE_COMMIT is required: capture git rev-parse HEAD before entering lm-remote.');
    return { sourceCommit: git(['rev-parse', 'HEAD']), sourceIdentity: 'development-unverified' };
  }
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('CARLAB_SOURCE_COMMIT must be a full lowercase Git commit ID.');
  try { git(['cat-file', '-e', `${revision}^{commit}`]); }
  catch { throw new Error('CARLAB_SOURCE_COMMIT does not identify an available source commit.'); }
  if (/^lm-remote\s/.test(git(['show', '-s', '--format=%s', revision]))) {
    throw new Error('A runner snapshot cannot identify a source release; capture the source commit before lm-remote.');
  }
  if (git(['rev-parse', `${revision}^{tree}`]) !== git(['rev-parse', 'HEAD^{tree}'])) {
    throw new Error('The supplied source commit does not match the tree being built. Commit the source before building.');
  }
  if (git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Release source has uncommitted changes. Commit the source before building.');
  }
  return { sourceCommit: revision, sourceIdentity: 'explicit-verified' };
}
