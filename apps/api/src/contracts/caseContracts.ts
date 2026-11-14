import { z } from 'zod';

import { normalizeCallbackPhone } from '../services/partnerCallbackSeal.js';
import { rsiSignalSchema } from './rsiContracts.js';

const safeIdentifier = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/);
const category = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9 _-]+$/);

// Save-private is deliberately a local record contract, not an API body.
// No route accepts it; keeping the schema explicit prevents it from being
// confused with submitted-case payloads by validators and migration tooling.
export const savePrivateLocalRecordSchema = z.object({
  schemaVersion: z.literal('1.0'),
  workflowType: z.literal('save-private'),
  storage: z.literal('local-only'),
}).strict();

export const anonymousSignalSchema = rsiSignalSchema;

const referralSelectedFieldSchema = z.enum([
  'incident_categories',
  'time_context',
  'location_type',
  'ongoing_status',
]);

const referralBriefWorkflowSchema = z.object({
  schemaVersion: z.literal('1.0'),
  workflowType: z.literal('referral'),
  providerId: safeIdentifier,
  channel: z.enum(['call', 'whatsapp', 'sms', 'partner_dashboard']),
  supportBrief: z.union([
    z.object({
      included: z.literal(false),
      selectedFields: z.array(referralSelectedFieldSchema).length(0),
    }).strict(),
    z.object({
      included: z.literal(true),
      selectedFields: z.array(referralSelectedFieldSchema).min(1).max(4),
      incidentCategories: z.array(category).max(12).optional(),
      timeContext: z.object({
        date: z.string().date(),
        accuracy: z.enum(['exact', 'approximate', 'estimated']),
      }).strict().optional(),
      locationType: category.optional(),
      isOngoing: z.boolean().optional(),
    }).strict().superRefine((brief, ctx) => {
      const fieldToValue: Record<z.infer<typeof referralSelectedFieldSchema>, unknown> = {
        incident_categories: brief.incidentCategories,
        time_context: brief.timeContext,
        location_type: brief.locationType,
        ongoing_status: brief.isOngoing,
      };
      const selected = new Set(brief.selectedFields);
      for (const [field, value] of Object.entries(fieldToValue)) {
        if (selected.has(field as z.infer<typeof referralSelectedFieldSchema>) !== (value !== undefined)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['selectedFields'],
            message: `${field} selection must exactly match its supplied value`,
          });
        }
      }
    }),
  ]),
}).strict();

const packetEvidenceSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(['photo', 'video', 'audio', 'document']),
  label: z.string().min(1).max(180),
  sizeBytes: z.number().int().nonnegative().optional(),
  capturedAt: z.string().datetime().optional(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  description: z.string().max(2000).optional(),
  transcript: z.string().max(8000).optional(),
  metadataStatus: z.string().min(1).max(120),
  privacyRequests: z.array(z.string().min(1).max(180)).max(3),
}).strict();

export const escalationWorkflowSchema = z.object({
  schemaVersion: z.literal('1.0'),
  workflowType: z.literal('escalation'),
  packet: z.object({
    version: z.literal('1.0'),
    generatedAt: z.string().datetime(),
    pathway: z.literal('escalate'),
    redactionLevel: z.enum(['none', 'light', 'heavy']),
    contact: z.object({
      preference: z.enum(['alias', 'none']),
      alias: z.string().min(1).max(120).optional(),
      label: z.string().min(1).max(180),
    }).strict(),
    content: z.object({
      timeRange: z.string().max(180),
      location: z.string().max(500),
      incidentDescription: z.string().max(8000),
      statement: z.string().max(8000),
      impactSummary: z.string().max(2000).optional(),
      witnessDetails: z.string().max(2000).optional(),
      tags: z.array(z.string().max(80)).max(30),
      patterns: z.array(z.string().max(80)).max(30),
      transportIdentifiers: z.array(z.string().max(180)).max(10),
    }).strict(),
    evidenceManifest: z.array(packetEvidenceSchema).max(50),
    redaction: z.object({
      appliedLabels: z.array(z.string().max(180)).max(20),
      textFields: z.array(z.string().max(80)).max(20),
      evidenceMetadata: z.string().max(180),
      mediaProcessing: z.array(z.string().max(180)).max(10),
    }).strict(),
  }).strict(),
}).strict();

// v3 is a distinct, separately recorded HURIA consent. Legacy briefs remain valid.
export const HURIA_PACKET_CONSENT_VERSION = 'partner-follow-up.ke-coast-huria.v3';
export const referralWorkflowSchema = referralBriefWorkflowSchema.extend({
  partnerPacket: z.object({
    consentVersion: z.literal(HURIA_PACKET_CONSENT_VERSION),
    packet: escalationWorkflowSchema.shape.packet,
  }).strict().optional(),
});

export const submittedCaseWorkflowSchema = z.object({
  schemaVersion: z.literal('1.0'),
  workflowType: z.literal('submitted-case'),
  pathway: z.literal('escalation'),
  submission: escalationWorkflowSchema,
}).strict();

/**
 * Partners a survivor can route to in phase 1: HURIA, and the synthetic
 * `test-partner` that only the dev/test seed creates (it never exists live,
 * so routing to it there is refused as not accepting).
 */
export const ROUTABLE_PARTNER_STABLE_IDS = ['ke-coast-huria', 'test-partner'] as const;

// Kenyan mobile subscriber numbers: +254 7XX XXX XXX or the 10X/11X ranges.
const KENYAN_MOBILE_E164 = /^\+254(7\d{8}|1[01]\d{7})$/;

/** A Kenyan mobile number in E.164 (via P1's normaliser), or null for landlines, short codes and other countries. */
export function normalizeKenyanMobile(input: string): string | null {
  const e164 = normalizeCallbackPhone(input);
  return e164 && KENYAN_MOBILE_E164.test(e164) ? e164 : null;
}

const kenyanMobileSchema = z.string().max(24).transform((value, ctx) => {
  const normalized = normalizeKenyanMobile(value);
  if (!normalized) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a Kenyan mobile number' });
    return z.NEVER;
  }
  return normalized;
});

/**
 * The survivor's explicit, per-report choice to route this case to a
 * partner's secure dashboard. Both consents are recorded first through
 * POST /api/privacy/consents and must still be granted and unused.
 */
export const partnerRoutingSchema = z.object({
  partnerStableId: z.enum(ROUTABLE_PARTNER_STABLE_IDS),
  consentRecordId: z.string().uuid(),
  callback: z.object({
    phoneNumber: kenyanMobileSchema,
    consentRecordId: z.string().uuid(),
  }).strict().optional(),
}).strict();

export type PartnerRoutingInput = z.infer<typeof partnerRoutingSchema>;

export const createCaseSchema = z.object({
  idempotencyKey: z.string().uuid(),
  draftId: z.string().min(1).max(180).nullable().optional(),
  pathwayConsent: z.object({
    recordId: z.string().uuid(),
    purpose: z.literal('pathway_submission'),
    version: z.literal('pathway-consent.v1'),
  }).strict(),
  workflow: z.discriminatedUnion('workflowType', [referralWorkflowSchema, submittedCaseWorkflowSchema]),
  partnerRouting: partnerRoutingSchema.optional(),
}).strict().superRefine((submission, ctx) => {
  if (submission.idempotencyKey !== submission.pathwayConsent.recordId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'submission idempotency must be bound to the pathway consent record',
    });
  }
  const routing = submission.partnerRouting;
  if (submission.workflow.workflowType === 'referral' && submission.workflow.channel === 'partner_dashboard'
    && (submission.workflow.providerId !== 'ke-coast-huria' || routing?.partnerStableId !== 'ke-coast-huria' || !submission.workflow.partnerPacket)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workflow', 'channel'], message: 'digital referral requires a reviewed packet and explicit HURIA routing consent' });
  }
  if (submission.workflow.workflowType === 'referral' && submission.workflow.partnerPacket && routing?.partnerStableId !== 'ke-coast-huria') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workflow', 'partnerPacket'], message: 'a reviewed HURIA packet requires explicit HURIA routing' });
  }
  if (!routing) return;
  if (submission.workflow.workflowType === 'referral' && submission.workflow.providerId !== routing.partnerStableId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['partnerRouting', 'partnerStableId'],
      message: 'a referral can only be routed to the provider it names',
    });
  }
  const consentIds = [submission.pathwayConsent.recordId, routing.consentRecordId, routing.callback?.consentRecordId]
    .filter((id): id is string => Boolean(id));
  if (new Set(consentIds).size !== consentIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['partnerRouting', 'consentRecordId'],
      message: 'each purpose needs its own consent record',
    });
  }
});

export type CaseWorkflow = z.infer<typeof createCaseSchema>['workflow'];

export function buildLifecyclePayload(workflow: CaseWorkflow): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    workflowType: workflow.workflowType,
    status: 'submitted',
  };
}
