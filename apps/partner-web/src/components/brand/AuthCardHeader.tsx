import { t } from '../../lib/i18n.ts';
import { LockIcon, ShieldCheckIcon } from '../icons.tsx';
import { PageHeading } from '../ui.tsx';
import { BrandLockup } from './BrandLockup.tsx';

/** The top of the sign-in and enrolment cards: the large lockup, the product line and the page's h1. */
export function AuthCardHeader({ heading }: { heading: string }) {
  return (
    <div className="space-y-6">
      <BrandLockup size="lg" />
      <div className="space-y-1 border-t border-line pt-6">
        <p className="eyebrow">{t('brand.eyebrow')}</p>
        <PageHeading>{heading}</PageHeading>
      </div>
    </div>
  );
}

/** Two quiet reassurances at the foot of the sign-in card. */
export function AuthTrustNotes() {
  return (
    <ul className="space-y-3 border-t border-line pt-6 text-sm text-ink-3">
      <li className="flex gap-3">
        <ShieldCheckIcon className="h-5 w-5 shrink-0" />
        <span>{t('brand.mfa')}</span>
      </li>
      <li className="flex gap-3">
        <LockIcon className="h-5 w-5 shrink-0" />
        <span>{t('brand.memoryOnly')}</span>
      </li>
    </ul>
  );
}
