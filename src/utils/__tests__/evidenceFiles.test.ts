import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const state = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  copyFailure: false,
  corruptCopy: false,
  afterCopy: null as null | (() => void | Promise<void>),
  deletes: [] as string[],
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-file-system', () => ({ File: class {
  constructor(private uri: string) {}
  async bytes() { const bytes = state.files.get(this.uri); if (!bytes) throw new Error('missing synthetic file'); return bytes; }
} }));
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/', cacheDirectory: 'file:///cache/',
  getInfoAsync: vi.fn(async (uri: string) => ({ exists: state.files.has(uri), isDirectory: false, size: state.files.get(uri)?.length })),
  makeDirectoryAsync: vi.fn(),
  copyAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    if (state.copyFailure) throw new Error('synthetic copy failure');
    const bytes = state.files.get(from)!;
    state.files.set(to, state.corruptCopy ? new Uint8Array(bytes.length).fill(9) : bytes.slice());
    await state.afterCopy?.();
  }),
  deleteAsync: vi.fn(async (uri: string) => { state.deletes.push(uri); state.files.delete(uri); }),
}));

import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { draftStorage } from '../draftStorage';
import { addPersistentEvidence, reconcileEvidenceDraft, removePersistentEvidence } from '../evidenceFiles';

const media = { type: 'document' as const, uri: 'file:///cache/private-name.pdf', fileName: 'private-name.pdf', size: 0 };
const sourceBytes = new Uint8Array([1, 2, 3, 4]);
beforeEach(async () => {
  state.files.clear(); state.files.set(media.uri, sourceBytes);
  state.copyFailure = false; state.corruptCopy = false; state.afterCopy = null; state.deletes = [];
  await draftStorage.clearAll();
  await draftStorage.saveDraft({ id: 'evidence-draft', mediaFiles: [] });
  vi.spyOn(Crypto, 'digest').mockImplementation(async (_algorithm, bytes) => {
    const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return new Uint8Array(createHash('sha256').update(data).digest()).buffer;
  });
});

describe('new evidence persistence', () => {
  it('verifies byte-identical persistent copy before saving and survives cache eviction', async () => {
    const result = await addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => true });
    expect(result?.media.uri).toMatch(/^file:\/\/\/documents\/saferide-evidence\/evidence-[a-f0-9-]+\.pdf$/);
    expect(result?.media.uri).not.toContain('private-name');
    expect(result?.media.size).toBe(4);
    expect(result?.media.checksum).toBe(createHash('sha256').update(sourceBytes).digest('hex'));
    state.files.delete(media.uri);
    expect(state.files.get(result!.media.uri)).toEqual(sourceBytes);
    expect((await draftStorage.getDraft('evidence-draft'))?.mediaFiles?.[0].uri).toBe(result?.media.uri);
    expect(result?.media.privacyStatus?.fileEncryption.status).not.toBe('processed');
  });

  it.each(['copy', 'verification'])('does not add evidence when %s fails', async failure => {
    state.copyFailure = failure === 'copy'; state.corruptCopy = failure === 'verification';
    await expect(addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => true })).rejects.toThrow();
    expect((await draftStorage.getDraft('evidence-draft'))?.mediaFiles).toEqual([]);
    expect([...state.files.keys()]).toEqual([media.uri]);
  });

  it('cleans a verified copy when the user leaves before it commits', async () => {
    let current = true; state.afterCopy = () => { current = false; };
    expect(await addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => current })).toBeNull();
    expect((await draftStorage.getDraft('evidence-draft'))?.mediaFiles).toEqual([]);
    expect([...state.files.keys()]).toEqual([media.uri]);
  });

  it('does not resurrect a cleared draft or leave its pending copy', async () => {
    state.afterCopy = () => draftStorage.clearAll();
    expect(await addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => true })).toBeNull();
    expect(await draftStorage.getDraft('evidence-draft')).toBeNull();
    expect([...state.files.keys()]).toEqual([media.uri]);
  });

  it('keeps concurrent selections and removes only an unreferenced managed file', async () => {
    const results = await Promise.all([1, 2].map(() => addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => true })));
    expect((await draftStorage.getDraft('evidence-draft'))?.mediaFiles).toHaveLength(2);
    const item = results[0]!.media;
    await removePersistentEvidence({ draftId: 'evidence-draft', mediaId: item.id, uri: item.uri, isCurrent: () => true });
    expect(state.files.has(item.uri)).toBe(false);
    expect(state.files.has(media.uri)).toBe(true);
    expect((await draftStorage.getDraft('evidence-draft'))?.mediaFiles).toHaveLength(1);
  });

  it('does not destroy a file still referenced by another draft', async () => {
    const result = await addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => true });
    const item = result!.media;
    await draftStorage.saveDraft({ id: 'other-draft', mediaFiles: [item] });
    await removePersistentEvidence({ draftId: 'evidence-draft', mediaId: item.id, uri: item.uri, isCurrent: () => true });
    expect(state.files.has(item.uri)).toBe(true);
  });

  it('retains a saved file after a write acknowledgement fails', async () => {
    const update = draftStorage.updateExistingDraft.bind(draftStorage);
    const spy = vi.spyOn(draftStorage, 'updateExistingDraft').mockImplementationOnce(async (...args) => {
      await update(...args);
      throw new Error('synthetic acknowledgement failure');
    });
    try {
      await expect(addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => true })).rejects.toThrow();
      const saved = (await draftStorage.getDraft('evidence-draft'))!.mediaFiles![0];
      expect(state.files.has(saved.uri)).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('retains a capture committed just before blur and reconciles same-draft dirty fields', async () => {
    const first = await addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => true });
    const stale = (await draftStorage.getDraft('evidence-draft'))!;
    let current = true;
    const update = draftStorage.updateExistingDraft.bind(draftStorage);
    const spy = vi.spyOn(draftStorage, 'updateExistingDraft').mockImplementationOnce(async (...args) => {
      const saved = await update(...args);
      current = false; // Row and active-ID committed; UI callback is now stale.
      return saved;
    });
    try {
      expect(await addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => current })).toBeNull();
      await draftStorage.saveDraft(stale, { explicitKeys: new Set() });
      const persisted = (await draftStorage.getDraft('evidence-draft'))!;
      const reconciled = reconcileEvidenceDraft(persisted, { media: { [first!.media.id]: { description: 'New synthetic note' } }, textEvidence: 'Unsaved text' });
      expect(reconciled.mediaFiles).toHaveLength(2);
      expect(reconciled.mediaFiles[0].description).toBe('New synthetic note');
      expect(reconciled.mediaFiles[1].checksum).toBe(persisted.mediaFiles![1].checksum);
      expect(reconciled.textEvidence).toBe('Unsaved text');
      expect(state.files.has(persisted.mediaFiles![1].uri)).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('does not reintroduce removed IDs while applying pending notes/transcripts', async () => {
    const result = await addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => true });
    await removePersistentEvidence({ draftId: 'evidence-draft', mediaId: result!.media.id, uri: result!.media.uri, isCurrent: () => true });
    expect(reconcileEvidenceDraft((await draftStorage.getDraft('evidence-draft'))!, { media: { [result!.media.id]: { transcript: 'Delayed synthetic result' } } }).mediaFiles).toEqual([]);
  });

  it('cleans a deleted draft’s managed evidence while retaining other references and external paths', async () => {
    const results = await Promise.all([1, 2].map(() => addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => true })));
    await draftStorage.saveDraft({ id: 'other-draft', mediaFiles: [results[0]!.media] });
    await draftStorage.updateExistingDraft('evidence-draft', draft => ({ mediaFiles: [...draft.mediaFiles!, { ...results[0]!.media, id: 'external', uri: media.uri }] }));
    await draftStorage.deleteDraft('evidence-draft');
    expect(await draftStorage.getDraft('evidence-draft')).toBeNull();
    expect(state.files.has(results[0]!.media.uri)).toBe(true);
    expect(state.files.has(results[1]!.media.uri)).toBe(false);
    expect(state.files.has(media.uri)).toBe(true);
  });

  it('retains the draft for retry when managed evidence cleanup fails', async () => {
    const result = await addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => true });
    vi.mocked(FileSystem.deleteAsync).mockRejectedValueOnce(new Error('synthetic delete failure'));
    await expect(draftStorage.deleteDraft('evidence-draft')).rejects.toThrow();
    expect(await draftStorage.getDraft('evidence-draft')).not.toBeNull();
    expect(state.files.has(result!.media.uri)).toBe(true);
    await draftStorage.deleteDraft('evidence-draft');
    expect(state.files.has(result!.media.uri)).toBe(false);
  });

  it.each(['nested/evidence-ab.pdf', '../evidence-ab.pdf', '%2e%2e/evidence-ab.pdf', 'evidence-ab.pdf/../private.pdf'])('never deletes a nested or traversing evidence path %s', async suffix => {
    const uri = `file:///documents/saferide-evidence/${suffix}`;
    state.files.set(uri, sourceBytes);
    const item = { ...media, id: 'path-test', timestamp: new Date(), uri };
    await draftStorage.saveDraft({ id: 'evidence-draft', mediaFiles: [item] });
    await removePersistentEvidence({ draftId: 'evidence-draft', mediaId: item.id, uri, isCurrent: () => true });
    expect(state.files.has(uri)).toBe(true);
    expect(state.deletes).not.toContain(uri);
  });

  it('allows retry after managed file deletion fails without touching the external source', async () => {
    const result = await addPersistentEvidence({ draftId: 'evidence-draft', media, isCurrent: () => true });
    const item = result!.media;
    vi.mocked(FileSystem.deleteAsync).mockRejectedValueOnce(new Error('synthetic delete failure'));
    const removal = { draftId: 'evidence-draft', mediaId: item.id, uri: item.uri, isCurrent: () => true };
    await expect(removePersistentEvidence(removal)).rejects.toThrow();
    expect((await draftStorage.getDraft('evidence-draft'))?.mediaFiles).toEqual([]);
    expect(state.files.has(item.uri)).toBe(true);
    await expect(removePersistentEvidence(removal)).resolves.toBe(true);
    expect(state.files.has(item.uri)).toBe(false);
    expect(state.files.has(media.uri)).toBe(true);
  });
});
