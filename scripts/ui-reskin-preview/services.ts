// Synthetic, volatile data only. Never imported by the production entry point.
import tipSeeds from '../../assets/data/tips.json';
// Public bundled guidance only; no account data, downloads or durable writes.
export const getTips = async () => tipSeeds.map(tip => ({
  ...tip,
  hasCopySteps: Boolean(tip.copySteps?.length),
}));
// `?draft=1` supplies one invented draft so review/summary states can be inspected.
const withDraft = new URLSearchParams(window.location.search).get('draft') === '1';
const syntheticDraft = {
  id: 'synthetic-ui-draft', createdAt: new Date('2026-10-04T09:00:00Z'), updatedAt: new Date('2026-10-04T09:30:00Z'),
  currentStep: 'ConsentGate', completedSteps: ['WhatHappened', 'WhereWhen', 'EvidenceDetail'], status: 'draft',
  incidentTypes: ['verbal'], locationMode: 'general', locationContext: 'matatu',
};
export const draftStorage = {
  getAllDrafts: async () => (withDraft ? [syntheticDraft] : []), getDraft: async () => (withDraft ? syntheticDraft : null),
  subscribe: () => () => {},
};
const catalog = { items: [], source: 'seed', lastUpdated: null };
export const getProvidersWithInfo = async () => catalog;
export const refreshProviders = async () => catalog;
export const refreshLegalTags = async () => catalog;
export const refreshTips = async () => catalog;
export const getCatalogInfo = async () => ({ providersLastUpdated: null, legalTagsLastUpdated: null, tipsLastUpdated: null });
export const captureMeasurementEvent = async () => {};
// Moderated-test measurement stays empty and volatile in the preview.
export const getMeasurementConsent = async () => null;
export const getMeasurementSession = async () => null;
export const grantMeasurementConsent = async () => { throw new Error('Synthetic preview: measurement unavailable.'); };
export const withdrawMeasurementConsent = async () => {};
export const hasCurrentMeasurementAuthorization = async () => false;
export const listMeasurementEvents = async () => [];
export const deleteMeasurementEvents = async () => {};
export const listIssueReports = async () => [];
export const deleteIssueReports = async () => {};
export const saveIssueReport = async () => { throw new Error('Synthetic preview: issue reports unavailable.'); };
export const setMeasurementSessionAssistance = async () => {};
export const getMeasurementModeDecision = () => ({ enabled: false, reason: 'Synthetic preview', controls: null });
export const listCases = async () => [];
export const getSyncQueue = async () => [];
export const fetchDrafts = async () => [];
export const fetchCases = async () => [];
export const deleteDraft = async () => { throw new Error('Synthetic preview: no stored drafts.'); };
export const offlineSyncManager = { getSyncQueueItems: () => [], removeQueueItemsForDraft: async () => {} };
export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
