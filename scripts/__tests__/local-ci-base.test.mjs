import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveCiBase } from '../lib/local-ci-base.mjs';

test('mixed remotes select private ancestry, explicit bases survive, missing private base fails closed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'saferide-ci-base-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init');
    git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', 'https://github.com/esherialabs/saferide.git');
    git('remote', 'add', 'integration', 'git@github.com:esherialabs/saferide-internal.git');
    git('update-ref', 'refs/remotes/integration/main', base);
    git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'change');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    assert.equal(resolveCiBase(root), base);
    assert.equal(resolveCiBase(root, base), base);
    assert.throws(() => resolveCiBase(root, 'missing-ref'), /No verified private/);
    git('remote', 'remove', 'integration');
    assert.throws(() => resolveCiBase(root), /No verified private/);
    assert.equal(resolveCiBase(root, base), base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
