import { describe, expect, it } from 'vitest';

import { loadRsiControls, type RsiControls } from '../../config/rsiControls.js';
import {
  findForbiddenRsiFields,
  rsiSignalSchema,
  validateAndMinimizeRsiSignal,
  validateAndMinimizeRsiSignalBatch,
  validateRsiSignalBatchSubmission,
} from '../rsiSignalService.js';

const consent = {
  recordId: '11111111-1111-4111-8111-111111111111',
  purpose: 'anonymous_aggregate' as const,
  version: 'synthetic-anonymous-consent-v1',
};
const ingestionId = '22222222-2222-4222-8222-222222222222';
const scenarioTime = new Date('2026-07-30T12:00:00.000Z');

function approvedControls(): RsiControls {
  const controls = structuredClone(loadRsiControls());
  controls.activation.signalIngestion = { status: 'enabled', reason: null };
  controls.approval = {
    status: 'approved', approvalId: 'synthetic-mentor-approval', approvedByRole: 'synthetic-reviewer',
    approvedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-08-30T00:00:00.000Z', minimumCount: 10,
  };
  controls.fixedBuckets.areaDefinitionVersion = 'synthetic-area-v1';
  controls.fixedBuckets.allowedAreaIds = ['cell-100-100'];
  controls.spatialTransform = {
    status: 'approved', executionBoundary: 'on_device', implementationVersion: 'synthetic-grid-v1',
    coarseCellSizeDegrees: 0.05, rawCoordinatesTransmitted: false,
  };
  controls.consent.requiredVersion = 'synthetic-anonymous-consent-v1';
  controls.rawSignalRetention = { status: 'approved', durationDays: 7 };
  return controls;
}

function signal() {
  return {
    schemaVersion: '1.0',
    configVersion: 'rsi-privacy-controls.2026-07-30.1',
    policyVersion: 'rsi-privacy-controls.2026-07-30.1',
    consentVersion: 'synthetic-anonymous-consent-v1',
    area: { type: 'coarse_cell', id: 'cell-100-100' },
    timeBucket: '2026-07-30T10:00:00.000Z',
    category: 'harassment',
  };
}

describe('minimized RSI signal ingestion', () => {
  it('accepts only a fixed approved bucket and emits no direct identifier or narrative', () => {
    const minimized = validateAndMinimizeRsiSignal(signal(), approvedControls(), new Date('2026-07-30T12:00:00.000Z'));
    expect(minimized).toMatchObject({ areaId: 'cell-100-100', category: 'harassment', timeBucketMinutes: 60 });
    const serialized = JSON.stringify(minimized);
    for (const forbidden of ['narrative', 'evidence', 'ownerId', 'latitude', 'longitude', 'caseId']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('rejects unknown fields, exact coordinates, arbitrary categories, and misaligned time buckets', () => {
    expect(rsiSignalSchema.safeParse({ ...signal(), latitude: -1.2 }).success).toBe(false);
    expect(findForbiddenRsiFields({ nested: { coordinates: [-1.2, 36.8], narrative: 'synthetic' } })).toEqual([
      '$.nested.coordinates', '$.nested.narrative',
    ]);
    expect(() => validateAndMinimizeRsiSignal({ ...signal(), category: 'unapproved' }, approvedControls(), scenarioTime)).toThrow(/category/);
    expect(() => validateAndMinimizeRsiSignal({ ...signal(), timeBucket: '2026-07-30T10:30:00.000Z' }, approvedControls(), scenarioTime)).toThrow(/aligned/);
  });

  it('fails before minimization when approval, consent, area, or retention is absent', () => {
    expect(() => validateAndMinimizeRsiSignal(signal(), loadRsiControls())).toThrow(/not approved/);
    const controls = approvedControls();
    controls.consent.requiredVersion = null;
    expect(() => validateAndMinimizeRsiSignal(signal(), controls, scenarioTime)).toThrow(/complete attributable/);
  });

  it('accepts an atomic bounded batch and rejects duplicate dimensions', () => {
    const controls = approvedControls();
    const batch = validateAndMinimizeRsiSignalBatch({
      consent,
      ingestionId,
      signals: [signal(), { ...signal(), category: 'unsafe_driving' }],
    }, controls, new Date('2026-07-30T12:00:00.000Z'));
    expect(batch.map(item => item.category)).toEqual(['harassment', 'unsafe_driving']);
    expect(() => validateAndMinimizeRsiSignalBatch({ consent, ingestionId, signals: [signal(), signal()] }, controls, scenarioTime)).toThrow(/duplicate/);
    expect(() => validateAndMinimizeRsiSignalBatch({ consent, ingestionId, signals: [] }, controls)).toThrow();
    expect(() => validateRsiSignalBatchSubmission({
      consent: { ...consent, version: 'different-consent-v1' },
      ingestionId,
      signals: [signal()],
    }, controls)).toThrow(/checkpoint/);
  });

  it.each([-1, 0, 1])('preserves approval expiry enforcement at offset %i milliseconds', offset => {
    const controls = approvedControls();
    const now = new Date(Date.parse(controls.approval.expiresAt!) + offset);
    if (offset < 0) {
      expect(validateAndMinimizeRsiSignal(signal(), controls, now).category).toBe('harassment');
    } else {
      expect(() => validateAndMinimizeRsiSignal(signal(), controls, now)).toThrow(/not approved/);
    }
  });
});
