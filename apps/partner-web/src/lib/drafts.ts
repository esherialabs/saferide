/**
 * Which parts of this tab hold unsaved text (today: a note not yet added),
 * so sign-out and the expiry warnings can say it will be lost. Memory only;
 * it records that a draft exists, never its text.
 */
const drafts = new Set<string>();
const listeners = new Set<() => void>();

export function setDraft(key: string, present: boolean): void {
  const had = drafts.has(key);
  if (present) drafts.add(key);
  else drafts.delete(key);
  if (had !== present) for (const listener of [...listeners]) listener();
}

export function hasDraft(): boolean {
  return drafts.size > 0;
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests. */
export function clearDrafts(): void {
  drafts.clear();
}
