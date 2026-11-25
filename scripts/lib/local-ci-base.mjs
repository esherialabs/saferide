import { spawnSync } from 'node:child_process';

export function resolveCiBase(root, explicit) {
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : '';
  };
  const candidates = explicit ? [explicit] : git(['remote']).split('\n')
    .filter(remote => /(?:github\.com[:/])esherialabs\/saferide-internal(?:\.git)?$/i.test(git(['remote', 'get-url', remote])))
    .map(remote => `refs/remotes/${remote}/main`);
  for (const candidate of candidates) {
    const base = git(['merge-base', candidate, 'HEAD']);
    if (base) return base;
  }
  throw new Error('No verified private main ancestry; fetch the private remote or supply --base REF. In a public checkout this is expected: run `npm run verify:public` instead (see docs/open-source/build-and-test.md).');
}
