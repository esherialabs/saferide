// Synthetic data only: invented people, cases, numbers and keys for local
// development and the e2e tests. None of it is real survivor data. Shapes
// follow P3 (apps/api/src/services/partnerCaseView.ts).

export const MOCK_PORT = Number(process.env.PARTNER_MOCK_PORT ?? 4320);
export const MOCK_ORIGIN = `http://localhost:${MOCK_PORT}`;
// Evidence downloads come from a separate storage origin, as in production;
// the e2e build (npm run build:e2e) allows exactly this one.
export const MOCK_STORAGE_PORT = Number(process.env.PARTNER_MOCK_STORAGE_PORT ?? 4321);
export const MOCK_STORAGE_ORIGIN = `http://localhost:${MOCK_STORAGE_PORT}`;

// Mock-only credentials; the real API never accepts these.
export const CASEWORKER = {
  email: 'caseworker@huria.test',
  displayName: 'Amina Test-Caseworker',
  password: 'test-partner-passphrase-2026',
  totpKey: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
};

export const ADMIN = {
  email: 'admin@huria.test',
  displayName: 'Zawadi Test-Admin',
  password: 'test-admin-passphrase-2026',
  totpKey: 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU',
};

// A second caseworker, so cases can be assigned to someone else.
export const COLLEAGUE = {
  email: 'juma@huria.test',
  displayName: 'Juma Test-Caseworker',
  password: 'test-colleague-passphrase-2026',
  totpKey: 'MFRGGZDFMZTWQ2LKMFRGGZDFMZTWQ2LK',
};

/** Staff IDs in the mock (the real API uses UUIDs). */
export const STAFF_IDS = { caseworker: 'usr_caseworker', colleague: 'usr_colleague', admin: 'usr_admin' };

export const INVITEE = {
  email: 'new.caseworker@huria.test',
  displayName: 'Baraka Test-Invitee',
  enrollmentToken: `srpe_${'synthetic-enrolment-link-for-tests'.padEnd(43, '0')}`,
};

/**
 * A caseworker whose account an operator created with `user:set-password`
 * (migration 013): a generated password, no authenticator yet, and a new
 * password to choose at first sign-in.
 */
export const ISSUED = {
  email: 'issued.caseworker@huria.test',
  displayName: 'Imani Test-Issued',
  password: 'test-k7mqa-2rx9p-hd4tz-w8nce',
  newPassword: 'blue kettle river stone',
};

export const HURIA_ORG = { id: 'org_huria', stableId: 'ke-coast-huria', displayName: 'Human Rights Agenda (HURIA)' };
export const OTHER_ORG = { id: 'org_other', stableId: 'test-partner', displayName: 'Other Test Partner' };

const referralId = n => `5a1e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const attachmentId = n => `a77a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const onwardId = n => `0e0e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Referral IDs by reference, for tests that navigate directly. */
export const REFERRAL_IDS = {
  'SR-7K3Q-9M2D': referralId(1),
  'SR-4T8N-2XHB': referralId(2),
  'SR-9PQR-6WZA': referralId(3),
  'SR-2MNB-8CVD': referralId(4),
  'SR-6HJK-3LTE': referralId(5),
  'SR-5DFG-7QWE': referralId(6),
  'SR-8ZXC-1VBN': referralId(7),
  'SR-OTHR-0RG1': referralId(9001),
};

const HOUR = 60 * 60 * 1000;

function at(base, hoursAgo) {
  return new Date(base - hoursAgo * HOUR).toISOString();
}

/**
 * Case-management records: `assigneeId` and `actorId` are staff IDs the
 * mock resolves to {id, name}; `onward` holds the onward referrals.
 */
const onward = (n, type, status, createdAt, statusChangedAt, createdById, extra = {}) => ({
  id: onwardId(n), type, organisation: null, contactRole: null, externalReference: null, note: null, status, createdAt,
  createdById, statusChangedAt, ...extra,
});

const attachment = (n, mediaType, ext, mimeType, sizeBytes, receivedAt, download) => ({
  id: attachmentId(n), mediaType, displayName: `evidence-${mediaType}-1.${ext}`, mimeType, sizeBytes, receivedAt, download,
});

/**
 * Internal records: the mock projects them the way P3 does (queue item,
 * summary with allowedTransitions, tombstone).
 */
export function syntheticReferrals(now = Date.now()) {
  return [
    {
      id: referralId(1), orgId: HURIA_ORG.id, reference: 'SR-7K3Q-9M2D', pathway: 'escalation', status: 'new',
      receivedAt: at(now, 1), statusChangedAt: at(now, 1), closureReason: null, revokedAt: null,
      callbackNumber: '+254 700 000 123',
      view: {
        kind: 'escalation',
        generatedAt: at(now, 1.5),
        redactionLevel: 'light',
        contact: { preference: 'alias', alias: 'Test-Alias Wanjiku', label: 'Alias only' },
        content: {
          timeRange: 'Weekday evening, about 18:30 (synthetic)',
          location: 'A matatu stage in [area masked] (synthetic)',
          incidentDescription: 'SYNTHETIC TEST CASE. A conductor made repeated comments and blocked the exit until the passenger paid twice.',
          statement: 'SYNTHETIC. I want this recorded so it does not happen to others on this route.',
          impactSummary: 'SYNTHETIC. Felt unsafe using this stage in the evening.',
          tags: ['verbal harassment', 'extortion'],
          patterns: ['evening'],
          transportIdentifiers: ['Vehicle plate: K** ***X (masked)'],
        },
        evidenceManifest: [
          { type: 'photo', label: 'Photo 1', sizeBytes: 482113, capturedAt: at(now, 2), description: 'SYNTHETIC. The stage sign.', metadataStatus: 'Location removed', privacyRequests: ['faceBlur'] },
          { type: 'audio', label: 'Audio 1', metadataStatus: 'Unchanged', privacyRequests: [], transcript: 'SYNTHETIC. [inaudible]' },
        ],
        redaction: {
          appliedLabels: ['Names', 'Phone numbers', 'Exact location'],
          textFields: ['location', 'incidentDescription'],
          evidenceMetadata: 'Location and device metadata removed',
          mediaProcessing: ['Faces blurred'],
        },
      },
      attachments: [
        attachment(1, 'photo', 'jpg', 'image/jpeg', 482113, at(now, 1), { available: true }),
        attachment(2, 'audio', 'm4a', 'audio/mp4', 1203110, at(now, 1), { available: false, reason: 'unscanned' }),
        attachment(3, 'document', 'pdf', 'application/pdf', 22011, at(now, 1), { available: false, reason: 'scan_rejected' }),
      ],
      timeline: [{ event: 'received', status: 'new', at: at(now, 1) }],
      notes: [],
      assigneeId: null,
      onward: [],
    },
    {
      id: referralId(2), orgId: HURIA_ORG.id, reference: 'SR-4T8N-2XHB', pathway: 'referral', status: 'acknowledged',
      receivedAt: at(now, 5), statusChangedAt: at(now, 4), closureReason: null, revokedAt: null, callbackNumber: null,
      view: {
        kind: 'referral',
        channel: 'whatsapp',
        brief: {
          incidentCategories: ['verbal harassment', 'unwanted touching'],
          timeContext: { date: '2026-10-18', accuracy: 'approximate' },
          locationType: 'matatu',
          isOngoing: false,
        },
      },
      attachments: [],
      timeline: [
        { event: 'received', status: 'new', at: at(now, 5) },
        { event: 'acknowledged', status: 'acknowledged', at: at(now, 4), actorId: STAFF_IDS.caseworker },
        { event: 'assigned', status: null, at: at(now, 4), actorId: STAFF_IDS.caseworker, assigneeId: STAFF_IDS.caseworker },
      ],
      notes: [{
        id: 'b0b00000-0000-4000-8000-000000000001', body: 'SYNTHETIC. Waiting for the survivor to call with the reference.',
        createdAt: at(now, 4), author: { id: 'usr_caseworker', displayName: CASEWORKER.displayName },
      }],
      assigneeId: STAFF_IDS.caseworker,
      onward: [],
    },
    {
      id: referralId(3), orgId: HURIA_ORG.id, reference: 'SR-9PQR-6WZA', pathway: 'escalation', status: 'in_progress',
      receivedAt: at(now, 26), statusChangedAt: at(now, 20), closureReason: null, revokedAt: null, callbackNumber: null,
      view: {
        kind: 'escalation',
        generatedAt: at(now, 27),
        redactionLevel: 'heavy',
        contact: { preference: 'none', label: 'No contact' },
        content: {
          timeRange: 'Morning (synthetic)',
          location: '[removed]',
          incidentDescription: 'SYNTHETIC TEST CASE. [identifying details removed] Driver refused to stop at the requested stage.',
          statement: 'SYNTHETIC. [removed]',
          tags: ['intimidation'],
          patterns: [],
          transportIdentifiers: [],
        },
        evidenceManifest: [],
        redaction: { appliedLabels: ['All identifying details'], textFields: ['location', 'statement'], evidenceMetadata: 'All metadata removed', mediaProcessing: [] },
      },
      attachments: [attachment(4, 'photo', 'jpg', 'image/jpeg', 300512, at(now, 26), { available: true })],
      timeline: [
        { event: 'received', status: 'new', at: at(now, 26) },
        { event: 'acknowledged', status: 'acknowledged', at: at(now, 25.5), actorId: STAFF_IDS.colleague },
        { event: 'assigned', status: null, at: at(now, 25.5), actorId: STAFF_IDS.admin, assigneeId: STAFF_IDS.colleague },
        { event: 'onward_created', status: null, at: at(now, 22), actorId: STAFF_IDS.caseworker, onwardId: onwardId(2), createdStatus: 'planned' },
        { event: 'status_change', status: 'in_progress', at: at(now, 20) },
        { event: 'onward_created', status: null, at: at(now, 19), actorId: STAFF_IDS.colleague, onwardId: onwardId(1), createdStatus: 'made' },
        { event: 'onward_status', status: null, at: at(now, 18), actorId: STAFF_IDS.colleague, onwardId: onwardId(1), onwardStatus: 'accepted' },
              ],
      notes: [],
      assigneeId: STAFF_IDS.colleague,
      onward: [
        onward(1, 'police', 'accepted', at(now, 19), at(now, 18), STAFF_IDS.colleague, {
          organisation: 'Central Police Station, gender desk (synthetic)',
          contactRole: 'Gender desk officer',
          externalReference: 'OB 14/21/10/2026',
          note: 'SYNTHETIC. Statement recorded; the survivor was accompanied.',
        }),
        onward(2, 'psychosocial', 'planned', at(now, 22), at(now, 22), STAFF_IDS.caseworker, {
          organisation: 'Coast counselling partner (synthetic)',
          contactRole: 'Duty counsellor',
        }),
      ],
    },
    {
      id: referralId(4), orgId: HURIA_ORG.id, reference: 'SR-2MNB-8CVD', pathway: 'referral', status: 'closed',
      receivedAt: at(now, 72), statusChangedAt: at(now, 50), closureReason: 'support_provided', revokedAt: null, callbackNumber: null,
      view: { kind: 'referral', channel: 'call', brief: null },
      attachments: [],
      timeline: [
        { event: 'received', status: 'new', at: at(now, 72) },
        { event: 'assigned', status: null, at: at(now, 70), actorId: STAFF_IDS.admin, assigneeId: STAFF_IDS.admin },
        { event: 'onward_created', status: null, at: at(now, 66), actorId: STAFF_IDS.admin, onwardId: onwardId(3), createdStatus: 'made' },
        { event: 'status_change', status: 'closed', at: at(now, 50) },
      ],
      notes: [],
      assigneeId: STAFF_IDS.admin,
      onward: [
        onward(3, 'legal_aid', 'completed', at(now, 66), at(now, 52), STAFF_IDS.admin, { organisation: 'Legal aid clinic (synthetic)', contactRole: 'Duty advocate' }),
      ],
    },
    {
      id: referralId(5), orgId: HURIA_ORG.id, reference: 'SR-6HJK-3LTE', pathway: 'referral', status: 'referred_onward',
      receivedAt: at(now, 120), statusChangedAt: at(now, 60), closureReason: null, revokedAt: at(now, 30), callbackNumber: null,
      view: { kind: 'referral', channel: 'sms', brief: { locationType: 'bus' } },
      attachments: [], timeline: [], notes: [], assigneeId: STAFF_IDS.colleague, onward: [],
    },
    {
      id: referralId(6), orgId: HURIA_ORG.id, reference: 'SR-5DFG-7QWE', pathway: 'referral', status: 'new',
      receivedAt: at(now, 144), statusChangedAt: at(now, 144), closureReason: null, revokedAt: null, callbackNumber: null,
      view: { kind: 'referral', channel: 'call', brief: { locationType: 'boda boda', isOngoing: true } },
      attachments: [],
      timeline: [{ event: 'received', status: 'new', at: at(now, 144) }],
      notes: [],
      assigneeId: null,
      onward: [],
    },
    {
      // A stored workflow P3 could not project: the view is "unavailable".
      id: referralId(7), orgId: HURIA_ORG.id, reference: 'SR-8ZXC-1VBN', pathway: 'escalation', status: 'new',
      receivedAt: at(now, 192), statusChangedAt: at(now, 192), closureReason: null, revokedAt: null, callbackNumber: null,
      view: { kind: 'unavailable' },
      attachments: [],
      timeline: [{ event: 'received', status: 'new', at: at(now, 192) }],
      notes: [],
      assigneeId: null,
      onward: [],
    },
    {
      // Belongs to another organisation: HURIA must get 404 for it.
      id: referralId(9001), orgId: OTHER_ORG.id, reference: 'SR-OTHR-0RG1', pathway: 'referral', status: 'new',
      receivedAt: at(now, 0.5), statusChangedAt: at(now, 0.5), closureReason: null, revokedAt: null, callbackNumber: null,
      view: { kind: 'referral', channel: 'call', brief: null },
      attachments: [], timeline: [{ event: 'received', status: 'new', at: at(now, 0.5) }], notes: [], assigneeId: null, onward: [],
    },
  ];
}
