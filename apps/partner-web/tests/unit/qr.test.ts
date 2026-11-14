import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatDuration, t } from '../../src/lib/i18n.ts';
import { QR_QUIET_ZONE, groupKey, qrMatrix, qrSvgPath } from '../../src/lib/qr.ts';

const URI = 'otpauth://totp/SafeRide%20Partners:caseworker%40huria.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=SafeRide+Partners&algorithm=SHA1&digits=6&period=30';

function finderAt(matrix: boolean[][], top: number, left: number): boolean {
  // 7x7: dark ring, light ring, dark 3x3 centre.
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      const expected = ring !== 2;
      if (matrix[top + r]?.[left + c] !== expected) return false;
    }
  }
  return true;
}

describe('QR code', () => {
  it('encodes the otpauth URI as a valid-sized QR matrix with finder patterns', () => {
    const matrix = qrMatrix(URI);
    const size = matrix.length;
    assert.equal((size - 17) % 4, 0, 'size is 4 x version + 17');
    assert.ok(size >= 41, 'a ~150-character URI needs version 6 or above');
    assert.ok(matrix.every(cells => cells.length === size));
    assert.ok(finderAt(matrix, 0, 0));
    assert.ok(finderAt(matrix, 0, size - 7));
    assert.ok(finderAt(matrix, size - 7, 0));
  });

  it('draws one path inside a quiet zone', () => {
    const matrix = qrMatrix(URI);
    const { size, d } = qrSvgPath(matrix);
    assert.equal(size, matrix.length + 2 * QR_QUIET_ZONE);
    assert.ok(d.startsWith(`M${QR_QUIET_ZONE} ${QR_QUIET_ZONE}h7`), 'the top-left finder starts the path');
    const dark = matrix.flat().filter(Boolean).length;
    const drawn = [...d.matchAll(/h(\d+)v1/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    assert.equal(drawn, dark);
  });

  it('refuses text that is not printable ASCII', () => {
    assert.throws(() => qrMatrix('otpauth://totp/é'));
  });

  it('groups the manual key in fours', () => {
    assert.equal(groupKey('JBSWY3DPEHPK3PXP'), 'JBSW Y3DP EHPK 3PXP');
    assert.equal(groupKey('ABCDE'), 'ABCD E');
  });
});

describe('i18n', () => {
  it('fills placeholders and leaves unknown ones', () => {
    assert.equal(t('case.heading', { reference: 'SR-7K3Q-9M2D' }), 'Case SR-7K3Q-9M2D');
    assert.equal(t('queue.updated'), 'Updated {time}');
  });

  it('formats countdowns', () => {
    assert.equal(formatDuration(119_500), '2 min 0 s');
    assert.equal(formatDuration(45_000), '45 s');
    assert.equal(formatDuration(-5), '0 s');
  });
});
