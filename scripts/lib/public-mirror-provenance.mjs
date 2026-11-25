import path from 'node:path';

/**
 * Picks the source branch recorded in PUBLIC_MIRROR_PROVENANCE.json.
 * headBranches are the branches HEAD is on: the checked-out branch, or for a
 * detached HEAD the remote branches whose tip is HEAD. An explicit name must
 * be one of them; a branch other than the policy's needs allowNonMain.
 */
export function resolveSourceBranch({ headBranches, explicit, policyBranch, allowNonMain, headShort }) {
  const branches = [...new Set(headBranches.filter(Boolean))].sort();
  let branch;
  if (explicit) {
    if (!branches.includes(explicit)) {
      throw new Error(`--source-branch ${explicit} does not match HEAD (${branches.join(', ') || 'detached, on no branch'}).`);
    }
    branch = explicit;
  } else if (branches.includes(policyBranch)) {
    branch = policyBranch;
  } else {
    branch = branches[0] ?? `detached@${headShort}`;
  }
  if (branch !== policyBranch && !allowNonMain) {
    throw new Error(`HEAD is on ${branch}, not ${policyBranch}. Publish from ${policyBranch}, or pass --allow-non-main for a review build.`);
  }
  return branch;
}

/**
 * The current Android release record: the JSON that importerPath imports.
 * It must be part of the snapshot (published).
 */
export function resolveReleaseRecord({ importerPath, importerText, published }) {
  const match = /import\s+\w+\s+from\s+['"]([^'"]+\.json)['"]/.exec(importerText);
  if (!match) throw new Error(`Cannot find the release record import in ${importerPath}.`);
  const record = path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), match[1]));
  if (!published.has(record)) throw new Error(`Release record ${record} is not part of the public snapshot.`);
  return record;
}
