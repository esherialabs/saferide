import { PartnerLogo } from './PartnerLogo.tsx';
import { SafeRideLogo } from './SafeRideLogo.tsx';

/*
 * "SafeRide × HURIA". The one-line SafeRide wordmark and HURIA's stacked mark
 * are optically balanced: the wordmark's letters sit at roughly the height of
 * HURIA's three-line block, so the HURIA image box is drawn taller than the
 * wordmark box. A thin rule separates them, with clear space either side.
 */
const SIZES = {
  sm: { wordmark: 'h-[1.375rem]', partner: 'sm', gap: 'gap-3', rule: 'h-7' },
  md: { wordmark: 'h-6', partner: 'md', gap: 'gap-4', rule: 'h-8' },
  lg: { wordmark: 'h-8 sm:h-10', partner: 'lg', gap: 'gap-4 sm:gap-5', rule: 'h-10 sm:h-12' },
} as const;

export function BrandLockup({ size = 'md' }: { size?: keyof typeof SIZES }) {
  const s = SIZES[size];
  return (
    <span className={`inline-flex items-center ${s.gap}`} data-testid="brand-lockup">
      <SafeRideLogo className={`${s.wordmark} w-auto shrink-0 text-ink`} />
      <span className={`w-px shrink-0 ${s.rule} bg-line-strong/60`} aria-hidden="true" />
      <PartnerLogo size={s.partner} />
    </span>
  );
}

/** The five-colour SafeRide stripe from the wordmark's highlights. Decorative. */
export function BrandStripe() {
  return (
    <div className="brand-stripe" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
