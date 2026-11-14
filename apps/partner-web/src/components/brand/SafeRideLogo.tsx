/*
 * The official SafeRide wordmark, inlined from assets/logo.svg (and its
 * inverted twin assets/logo-inverted.svg): the same letters, highlight bars,
 * positions and colours. The letters use currentColor, so the one mark serves
 * light mode (ink #161616) and dark mode (near-white), as the two official
 * files do. Brand use follows TRADEMARKS.md and ASSET-LICENSES.md.
 */

import { t } from '../../lib/i18n.ts';

const LETTERS: { char: string; x: number; bar: { y: number; width: number; fill: string } }[] = [
  { char: 'S', x: 0, bar: { y: 32, width: 49, fill: '#F88539' } },
  { char: 'a', x: 48, bar: { y: 29, width: 45, fill: '#50C9F0' } },
  { char: 'f', x: 93, bar: { y: 32, width: 28, fill: '#53E17C' } },
  { char: 'e', x: 121, bar: { y: 29, width: 45, fill: '#F7EC36' } },
  { char: 'R', x: 169, bar: { y: 32, width: 52, fill: '#F06C13' } },
  { char: 'i', x: 222, bar: { y: 29, width: 20, fill: '#50C9F0' } },
  { char: 'd', x: 244, bar: { y: 30, width: 47, fill: '#53E17C' } },
  { char: 'e', x: 293, bar: { y: 29, width: 45, fill: '#F7EC36' } },
];

/** The wordmark; its text alternative is "SafeRide". */
export function SafeRideLogo({ className = 'h-7 w-auto' }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 338 74"
      role="img"
      aria-label={t('brand.saferideName')}
      focusable="false"
      data-logo="saferide"
    >
      <g fontFamily="Arial, Helvetica, 'Liberation Sans', sans-serif" fontSize="74" fontWeight="800" fill="currentColor">
        {LETTERS.map(letter => (
          <g key={letter.x} transform={`translate(${letter.x} 0)`}>
            <rect x="-1" y={letter.bar.y} width={letter.bar.width} height="30" rx="8" fill={letter.bar.fill} opacity="0.96" />
            <text x="0" y="63">{letter.char}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
