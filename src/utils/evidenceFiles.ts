import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { draftStorage, type DraftData } from './draftStorage';
import { normalizeMediaPrivacyStatuses, withEvidencePrivacyStatus, resolveEvidencePrivacySettingsForDraft } from './evidencePrivacyStatus';

type EvidenceMedia = NonNullable<DraftData['mediaFiles']>[number];
export type NewEvidenceMedia = Omit<EvidenceMedia, 'id' | 'timestamp'>;
export interface EvidenceDraftEdits {
  media?: Record<string, Pick<Partial<EvidenceMedia>, 'description' | 'transcript' | 'annotations'>>;
  textEvidence?: string;
  privacySettings?: DraftData['privacySettings'];
}

/** Persisted membership/status wins; only fields the user edited override it. */
export function reconcileEvidenceDraft(draft: DraftData, edits: EvidenceDraftEdits = {}) {
  const privacySettings = resolveEvidencePrivacySettingsForDraft(edits.privacySettings ?? draft.privacySettings);
  const mediaFiles = normalizeMediaPrivacyStatuses((draft.mediaFiles ?? []).map(media => ({
    ...media, ...edits.media?.[media.id],
  })), privacySettings) ?? [];
  return { mediaFiles, privacySettings, textEvidence: edits.textEvidence ?? draft.textEvidence ?? '' };
}

function evidenceDirectory(): string {
  if (!FileSystem.documentDirectory) throw new Error('Persistent evidence storage is unavailable.');
  return `${FileSystem.documentDirectory}saferide-evidence/`;
}

function isManagedEvidenceUri(uri: string): boolean {
  if (!FileSystem.documentDirectory) return false;
  const directory = `${FileSystem.documentDirectory}saferide-evidence/`;
  return uri.startsWith(directory) && /^evidence-[a-f0-9-]+\.[a-z0-9]+$/i.test(uri.slice(directory.length));
}

function safeExtension(media: NewEvidenceMedia): string {
  const extension = media.fileName.split('.').pop()?.toLowerCase() ?? '';
  // Retain only a known extension, never the imported filename or path.
  if (/^(jpg|jpeg|png|gif|heic|heif|webp|mp4|mov|m4a|mp3|wav|aac|ogg|pdf|doc|docx|txt)$/.test(extension)) return `.${extension}`;
  return media.type === 'photo' ? '.jpg' : media.type === 'audio' ? '.m4a' : media.type === 'video' ? '.mp4' : '.bin';
}

async function checksum(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function inspectFile(uri: string): Promise<{ size: number; sha256: string }> {
  const bytes = await new File(uri).bytes();
  if (!bytes.byteLength) throw new Error('Selected evidence file is empty.');
  return { size: bytes.byteLength, sha256: await checksum(bytes) };
}

async function deleteUnreferencedManagedFile(uri: string): Promise<void> {
  if (!isManagedEvidenceUri(uri)) return;
  const drafts = await draftStorage.getAllDrafts();
  if (drafts.some(draft => draft.mediaFiles?.some(media => media.uri === uri))) return;
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

/** Copy only newly selected evidence; existing draft files are never migrated implicitly. */
export async function addPersistentEvidence(params: {
  draftId: string;
  media: NewEvidenceMedia;
  isCurrent: () => boolean;
}): Promise<{ media: EvidenceMedia; mediaFiles: EvidenceMedia[] } | null> {
  const { draftId, media, isCurrent } = params;
  let invalidated = false;
  const unsubscribe = draftStorage.subscribe(event => {
    if (event.type === 'clear' || event.type === 'replace' || (event.type === 'delete' && event.draftId === draftId)) invalidated = true;
  });
  const current = () => !invalidated && isCurrent();
  let copiedUri: string | null = null;
  let committed = false;
  try {
    if (!current()) return null;
    const id = Crypto.randomUUID();
    let prepared: EvidenceMedia = { ...media, id, timestamp: new Date(), uploadStatus: 'pending' };
    if (Platform.OS !== 'web') {
      const sourceInfo = await FileSystem.getInfoAsync(media.uri);
      if (!sourceInfo.exists || sourceInfo.isDirectory) throw new Error('Selected evidence file is unavailable.');
      const source = await inspectFile(media.uri);
      if (!current()) return null;
      const directory = evidenceDirectory();
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
      copiedUri = `${directory}evidence-${id}${safeExtension(media)}`;
      await FileSystem.copyAsync({ from: media.uri, to: copiedUri });
      const copiedInfo = await FileSystem.getInfoAsync(copiedUri);
      if (!copiedInfo.exists || copiedInfo.isDirectory) throw new Error('Evidence copy could not be verified.');
      const copy = await inspectFile(copiedUri);
      if (copy.size !== source.size || copy.sha256 !== source.sha256) {
        throw new Error('Evidence copy did not preserve the selected file.');
      }
      prepared = { ...prepared, uri: copiedUri, fileName: copiedUri.split('/').pop()!, size: copy.size, checksum: source.sha256 };
    }
    const saved = await draftStorage.updateExistingDraft(draftId, draft => {
      if (!current()) return null;
      prepared = withEvidencePrivacyStatus(prepared, resolveEvidencePrivacySettingsForDraft(draft.privacySettings));
      return { mediaFiles: [...(draft.mediaFiles ?? []), prepared] };
    });
    committed = Boolean(saved);
    return saved && current() ? { media: prepared, mediaFiles: saved.mediaFiles ?? [] } : null;
  } finally {
    unsubscribe();
    // A save can commit its row before a later metadata write fails. Check
    // references before deleting so a recovery attempt never destroys evidence.
    if (copiedUri && !committed) {
      await deleteUnreferencedManagedFile(copiedUri);
    }
  }
}

export async function removePersistentEvidence(params: {
  draftId: string;
  mediaId: string;
  uri: string;
  isCurrent: () => boolean;
  onSaved?: (saved: DraftData) => void;
}): Promise<boolean> {
  let removed: EvidenceMedia | undefined;
  const saved = await draftStorage.updateExistingDraft(params.draftId, draft => {
    if (!params.isCurrent()) return null;
    removed = draft.mediaFiles?.find(media => media.id === params.mediaId);
    return { mediaFiles: draft.mediaFiles?.filter(media => media.id !== params.mediaId) ?? [] };
  });
  if (!saved) return false;
  // Reconcile the screen's draft reference before awaiting filesystem cleanup,
  // so its blur/autosave cannot reintroduce the removed attachment.
  if (params.isCurrent()) params.onSaved?.(saved);
  if (Platform.OS !== 'web') await deleteUnreferencedManagedFile(removed?.uri ?? params.uri);
  return true;
}
