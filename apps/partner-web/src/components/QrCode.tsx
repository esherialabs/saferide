import { useMemo } from 'react';

import { qrMatrix, qrSvgPath } from '../lib/qr.ts';

/** An SVG QR code drawn in the browser; nothing is sent to a QR service. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, d } = useMemo(() => qrSvgPath(qrMatrix(text)), [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="totp-qr"
      viewBox={`0 0 ${size} ${size}`}
      width="224"
      height="224"
      shapeRendering="crispEdges"
      className="rounded-xl border border-line bg-white"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
