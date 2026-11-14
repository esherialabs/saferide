import { t } from '../../lib/i18n.ts';

/*
 * HURIA LOGO SLOT
 *
 * public/brand/huria-logo.png is HURIA's logo exactly as the SafeRide website
 * ships it on its partners page (web/public/images/partners/human-rights-agenda.png,
 * 320 x 197, transparent); provenance in ASSET-LICENSES.md. To replace it with
 * a file HURIA provides, save it as public/brand/huria-logo.svg (preferred),
 * .png or .webp, optionally with a huria-logo-dark.* version for dark
 * backgrounds, and rebuild: next.config.mjs picks the files up at build time.
 * Without any file the text wordmark below is shown. See README "Brand assets".
 */
const LOGO = process.env.PARTNER_LOGO ?? '';
const LOGO_DARK = process.env.PARTNER_LOGO_DARK ?? '';

const HEIGHT = { sm: 'h-9', md: 'h-10', lg: 'h-12 sm:h-16' } as const;

/** HURIA's mark; its text alternative is "Human Rights Agenda (HURIA)". */
export function PartnerLogo({ size = 'md' }: { size?: keyof typeof HEIGHT }) {
  const name = t('brand.partnerName');
  if (LOGO) {
    // In dark mode the logo (black lettering) sits on a light chip, unless a
    // dark-background version exists.
    return (
      <span className={`partner-logo ${LOGO_DARK ? '' : 'partner-logo-chip'}`} data-logo-slot="huria" data-logo-source="file">
        <picture>
          {LOGO_DARK ? <source media="(prefers-color-scheme: dark)" srcSet={LOGO_DARK} /> : null}
          <img src={LOGO} alt={name} className={`${HEIGHT[size]} w-auto max-w-none`} decoding="async" />
        </picture>
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 flex-col justify-center leading-none"
      data-logo-slot="huria"
      data-logo-source="text-fallback"
      role="img"
      aria-label={name}
    >
      <span className={`font-display font-bold tracking-wide text-ink ${size === 'lg' ? 'text-2xl' : 'text-lg'}`}>
        {t('brand.partnerShort')}
      </span>
      <span className={`mt-1 font-semibold text-ink-2 ${size === 'lg' ? 'text-sm' : 'text-xs'}`}>{t('brand.partnerLong')}</span>
    </span>
  );
}
