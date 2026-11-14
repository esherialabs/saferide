/**
 * QR codes are drawn locally as SVG from the otpauth URI, so the TOTP key
 * never leaves the browser for a QR service.
 */
import qrcode from 'qrcode-generator';

export const QR_QUIET_ZONE = 4;

/** Dark/light modules of the QR code (error correction M, byte mode). */
export function qrMatrix(text: string): boolean[][] {
  if (!/^[\x20-\x7e]+$/.test(text)) throw new Error('QR text must be printable ASCII');
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => code.isDark(row, col)));
}

/** One SVG path for all dark modules (row runs merged), plus the quiet zone. */
export function qrSvgPath(matrix: boolean[][], quietZone: number = QR_QUIET_ZONE): { size: number; d: string } {
  const parts: string[] = [];
  matrix.forEach((cells, row) => {
    let col = 0;
    while (col < cells.length) {
      if (!cells[col]) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < cells.length && cells[col]) col += 1;
      parts.push(`M${start + quietZone} ${row + quietZone}h${col - start}v1h${start - col}z`);
    }
  });
  return { size: matrix.length + quietZone * 2, d: parts.join('') };
}

/** `ABCD EFGH IJKL …`: easier to read and type. */
export function groupKey(secret: string): string {
  return secret.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}
