import Head from 'next/head';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { endSession, sessionSync, store, useAppState } from '../lib/app.ts';
import { titleWithCount } from '../lib/attentionRules.ts';
import { prepareChime } from '../lib/chime.ts';
import { hasDraft } from '../lib/drafts.ts';
import { t } from '../lib/i18n.ts';
import { attentionCount, chimeSet, queueFilterChanged } from '../lib/store.ts';
import { BrandLockup, BrandStripe } from './brand/BrandLockup.tsx';
import { AttentionDot, initials } from './caseBadges.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { BellIcon, BellSlashIcon, CasesIcon, MapIcon, SignOutIcon, WarningIcon } from './icons.tsx';
import { ThemeControl } from './ThemeControl.tsx';
import { CoverageControl } from './CoverageControl.tsx';
import { NotificationControl } from './NotificationControl.tsx';

/**
 * Page titles never carry case content: a fixed name per screen, and while
 * signed in at most a count of cases that need attention, e.g. "(2) Cases".
 */
export function PageTitle({ title }: { title: string }) {
  const count = useAppState(state => (state.auth.status === 'signed_in' ? attentionCount(state) : 0));
  return (
    <Head>
      <title>{`${titleWithCount(title, count)} · ${t('app.titleSuffix')}`}</title>
    </Head>
  );
}

/**
 * The attention banner, under the header on every signed-in page: how many
 * new escalations nobody has acknowledged, and a link to exactly those.
 * Polite live region, so a change is announced once, without stealing focus.
 */
function AttentionBanner() {
  const count = useAppState(attentionCount);
  const unavailable = useAppState(state => state.alerts.unavailable);
  return (
    <div role="status" aria-live="polite" data-testid="attention-region">
      {unavailable ? <p className="mx-auto max-w-content px-4 py-2 text-warning-fg" data-testid="summary-unavailable">{t('attention.unavailable')}</p> : null}
      {count > 0 ? (
        <div className="attention-banner" data-testid="attention-banner">
          <div className="mx-auto flex max-w-content flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 sm:px-6 lg:px-8">
            <AttentionDot />
            <WarningIcon className="h-5 w-5 shrink-0" />
            <p className="font-semibold">
              {count === 1 ? t('attention.banner.one') : t('attention.banner.other', { count })}
            </p>
            <span aria-hidden="true">·</span>
            <Link
              href="/cases/?view=attention"
              className="btn-link"
              onClick={() => store.update(state => queueFilterChanged(state, { view: 'attention', status: 'all' }))}
            >
              {count === 1 ? t('attention.showOne') : t('attention.show')}
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The optional chime: off by default, memory only (off again after a reload). */
function ChimeToggle() {
  const on = useAppState(state => state.alerts.chime);
  return (
    <button
      type="button"
      className="btn-quiet px-3"
      aria-pressed={on}
      data-testid="chime-toggle"
      title={t('attention.chimeHint')}
      onClick={() => {
        if (!on) prepareChime();
        store.update(state => chimeSet(state, !on));
      }}
    >
      {on ? <BellIcon /> : <BellSlashIcon />}
      <span className="sr-only lg:not-sr-only">{t('attention.chime')}</span>
      <span className="sr-only">{` ${t('attention.chimeFor')}`}</span>
    </button>
  );
}

export function Layout({ children, title, section, variant = 'app' }: {
  children: ReactNode;
  title: string;
  /** Marks the matching navigation link as the current page. */
  section?: 'cases' | 'safety-map';
  /** 'auth': sign-in and enrolment, whose card carries the brand. */
  variant?: 'app' | 'auth';
}) {
  const auth = useAppState(state => state.auth);
  const [signingOut, setSigningOut] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState<{ here: boolean; elsewhere: boolean } | null>(null);
  const identity = auth.status === 'signed_in' ? auth.identity : null;
  const attention = useAppState(attentionCount);

  // Signing out ends every tab: first ask whether this or another tab holds an unsaved note.
  async function requestSignOut() {
    setSigningOut(true);
    const here = hasDraft();
    const elsewhere = await sessionSync().otherTabsHaveDraft();
    if (here || elsewhere) {
      setSigningOut(false);
      setDraftPrompt({ here, elsewhere });
      return;
    }
    void endSession('user');
  }

  return (
    <>
      <PageTitle title={title} />
      <a className="skip-link" href="#main">{t('app.skipToContent')}</a>
      <div className="flex min-h-screen flex-col">
        {variant === 'auth' ? (
          // Sign-in and enrolment carry the brand on their card; appearance stays available above it.
          <div>
            <BrandStripe />
            <div className="mx-auto flex max-w-content justify-end px-4 pt-4 sm:px-6 lg:px-8"><ThemeControl /></div>
          </div>
        ) : (
          <header className="z-30 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/90 md:sticky md:top-0">
            <BrandStripe />
            <div className="mx-auto flex max-w-content flex-wrap items-center gap-x-6 px-4 sm:px-6 xl:h-16 xl:flex-nowrap lg:px-8">
              <div className="flex min-h-16 flex-1 items-center xl:flex-none">
                {identity ? (
                  <Link href="/cases/" className="inline-flex min-h-target items-center rounded-lg">
                    <BrandLockup size="sm" />
                    <span className="sr-only">{t('brand.home')}</span>
                  </Link>
                ) : (
                  <BrandLockup size="sm" />
                )}
              </div>
              <ThemeControl />
              {identity ? (
                <div className="order-last flex w-full items-center justify-between gap-4 border-t border-line xl:order-none xl:w-auto xl:flex-1 xl:self-stretch xl:border-0">
                  <nav aria-label="Main" className="flex self-stretch">
                    <ul className="flex gap-1">
                      <li className="flex">
                        <Link
                          href="/cases/"
                          aria-current={section === 'cases' ? 'page' : undefined}
                          className="nav-link"
                        >
                          <CasesIcon />
                          {t('title.cases')}
                          {attention > 0 ? (
                            <span className="count-badge" data-testid="attention-count">
                              {attention}
                              <span className="sr-only">{` ${t('attention.badgeSr')}`}</span>
                            </span>
                          ) : null}
                        </Link>
                      </li>
                      <li className="flex">
                        <Link href="/safety-map/" aria-current={section === 'safety-map' ? 'page' : undefined} className="nav-link">
                          <MapIcon />{t('title.safetyMap')}
                        </Link>
                      </li>
                    </ul>
                  </nav>
                  <p className="min-w-0 truncate text-sm text-ink-3 md:hidden" aria-hidden="true">
                    {identity.displayName} · {identity.orgName}
                  </p>
                </div>
              ) : null}
              {identity ? (
                <div className="flex items-center gap-3">
                  <div className="hidden items-center gap-3 md:flex" aria-hidden="true">
                    <span className="flex max-w-[16rem] flex-col text-right leading-tight">
                      <span className="truncate text-sm font-semibold text-ink">{identity.displayName}</span>
                      <span className="truncate text-[0.8125rem] text-ink-3">{identity.orgName}</span>
                    </span>
                    <span className="avatar">{initials(identity.displayName)}</span>
                  </div>
                  <p className="sr-only" data-testid="signed-in-as">
                    {t('app.signedInAs', { name: identity.displayName, org: identity.orgName })}
                  </p>
                  <ChimeToggle />
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={signingOut}
                    onClick={() => void requestSignOut()}
                  >
                    <SignOutIcon />
                    <span className="max-[374px]:sr-only">{signingOut ? t('app.signingOut') : t('app.signOut')}</span>
                  </button>
                </div>
              ) : null}
            </div>
          </header>
        )}
        {identity ? <><CoverageControl /><NotificationControl /><AttentionBanner /></> : null}
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-content flex-1 px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
        <footer className="mt-8 border-t border-line">
          <div className="mx-auto flex max-w-content items-center px-4 py-5 text-sm text-ink-3 sm:px-6 lg:px-8">
            {t('brand.eyebrow')}
          </div>
        </footer>
        <ConfirmDialog
          open={draftPrompt !== null}
          title={t('signOut.confirmTitle')}
          confirmLabel={t('signOut.confirm')}
          cancelLabel={t('signOut.keepWorking')}
          tone="danger"
          testId="sign-out-draft"
          busy={signingOut}
          onConfirm={() => {
            setSigningOut(true);
            void endSession('user');
          }}
          onCancel={() => setDraftPrompt(null)}
        >
          {draftPrompt?.here ? <p>{t('signOut.draftHere')}</p> : null}
          {draftPrompt?.elsewhere ? <p>{t('signOut.draftElsewhere')}</p> : null}
        </ConfirmDialog>
      </div>
    </>
  );
}
