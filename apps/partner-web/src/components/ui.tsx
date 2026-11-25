import { forwardRef, useEffect, useId, useRef, type ReactNode } from 'react';

import { PartnerApiError, type PartnerStatus } from '../lib/partnerApi.ts';
import { t, type MessageKey } from '../lib/i18n.ts';
import { CheckCircleIcon, InfoIcon, SpinnerIcon, WarningIcon, XCircleIcon } from './icons.tsx';

let firstPageMount = true;

/**
 * The page's h1. After a client-side navigation it takes focus, so screen
 * reader and keyboard users start at the new page's heading.
 */
export function PageHeading({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (firstPageMount) {
      firstPageMount = false;
      return;
    }
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className={className}>
      {children}
    </h1>
  );
}

/** A card's h2 with its icon; `id` names the card's region (aria-labelledby). */
export function CardHeading({ id, icon, children, className = '' }: { id: string; icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`card-header ${className}`}>
      <span className="card-icon">{icon}</span>
      <h2 id={id}>{children}</h2>
    </div>
  );
}

/** A heading that takes focus when it appears (for steps within one page). */
export function FocusHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h2 ref={ref} tabIndex={-1}>
      {children}
    </h2>
  );
}

type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const toneClass: Record<NoticeTone, string> = {
  info: 'notice-info',
  success: 'notice-success',
  warning: 'notice-warning',
  error: 'notice-error',
};

const toneIcon: Record<NoticeTone, (props: { className?: string }) => ReactNode> = {
  info: InfoIcon,
  success: CheckCircleIcon,
  warning: WarningIcon,
  error: XCircleIcon,
};

/** A visible message box. `live` makes screen readers announce it when it changes. */
export function Notice({
  tone = 'info', children, live, className = '',
}: { tone?: NoticeTone; children: ReactNode; live?: 'polite' | 'assertive'; className?: string }) {
  const role = live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined;
  const Icon = toneIcon[tone];
  return (
    <div role={role} className={`notice ${toneClass[tone]} ${className}`}>
      <Icon />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Always-mounted polite live region; set `message` to announce it. */
export function LiveMessage({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}

export function errorText(error: unknown): string {
  if (error instanceof PartnerApiError) {
    const key: MessageKey = error.kind === 'network' ? 'error.network'
      : error.kind === 'timeout' ? 'error.timeout'
      : error.kind === 'rate_limited' ? 'error.rate_limited'
      : error.kind === 'forbidden' ? 'error.forbidden'
      : error.kind === 'bad_request' ? 'error.bad_request'
      : error.kind === 'unavailable' ? 'error.unavailable'
      : 'error.generic';
    return t(key);
  }
  return t('error.generic');
}

export function ErrorNotice({ error, children }: { error: unknown; children?: ReactNode }) {
  const requestId = error instanceof PartnerApiError ? error.requestId : undefined;
  return (
    <Notice tone="error" live="assertive">
      <p>{errorText(error)}</p>
      {requestId ? <p className="mt-1 text-sm">{t('error.reference', { requestId })}</p> : null}
      {children}
    </Notice>
  );
}

export type FieldError = { fieldId: string; message: string };

/** Lists form errors as links to their fields; takes focus when shown. */
export function ErrorSummary({ errors }: { errors: FieldError[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = errors.map(error => `${error.fieldId}:${error.message}`).join('|');
  useEffect(() => {
    if (errors.length > 0) ref.current?.focus();
  }, [key, errors.length]);
  if (errors.length === 0) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" aria-labelledby="error-summary-title" className="rounded-xl border-2 border-error-line bg-error-bg p-4 text-error-fg">
      <h2 id="error-summary-title" className="flex items-center gap-2 text-lg text-error-fg">
        <WarningIcon />
        {t('form.errorSummary')}
      </h2>
      <ul className="mt-2 list-disc pl-5">
        {errors.map(error => (
          <li key={`${error.fieldId}:${error.message}`}>
            {error.fieldId ? <a className="btn-link text-error-fg" href={`#${error.fieldId}`}>{error.message}</a> : error.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

type TextFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'password';
  autoComplete?: string;
  inputMode?: 'numeric' | 'email' | 'text';
  hint?: string;
  error?: string;
  maxLength?: number;
  required?: boolean;
  spellCheck?: boolean;
};

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { id, label, value, onChange, type = 'text', autoComplete, inputMode, hint, error, maxLength, required, spellCheck }, ref,
) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      {hint ? <span id={hintId} className="hint">{hint}</span> : null}
      {error ? <span id={errorId} className="field-error">{error}</span> : null}
      <input
        ref={ref}
        id={id}
        name={id}
        className="input mt-2"
        type={type}
        value={value}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        required={required}
        spellCheck={spellCheck}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        onChange={event => onChange(event.target.value)}
      />
    </div>
  );
});

// --- status badges: text plus a distinct shape, never colour alone -------------
// Colours per status live in globals.css (.chip-<status>), light and dark.
const chipClass: Record<PartnerStatus | 'withdrawn', string> = {
  new: 'chip-new',
  acknowledged: 'chip-acknowledged',
  in_progress: 'chip-in_progress',
  referred_onward: 'chip-referred_onward',
  closed: 'chip-closed',
  withdrawn: 'chip-withdrawn',
};

function BadgeIcon({ kind }: { kind: PartnerStatus | 'withdrawn' }) {
  const common = { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true, focusable: false } as const;
  switch (kind) {
    case 'new':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="currentColor" /></svg>;
    case 'acknowledged':
      return <svg {...common}><path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" /></svg>;
    case 'in_progress':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M7 2a5 5 0 010 10z" fill="currentColor" /></svg>;
    case 'referred_onward':
      return <svg {...common}><path d="M2 7h8M7 3.5L10.5 7 7 10.5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>;
    case 'closed':
      return <svg {...common}><rect x="2.5" y="2.5" width="9" height="9" fill="currentColor" /></svg>;
    case 'withdrawn':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M3.5 10.5l7-7" stroke="currentColor" strokeWidth="2" /></svg>;
  }
}

export function StatusBadge({ status }: { status: PartnerStatus | 'withdrawn' }) {
  const kind = status;
  const label = t(`status.${status}`);
  return (
    <span className={`chip ${chipClass[kind]}`}>
      <BadgeIcon kind={kind} />
      {label}
    </span>
  );
}

/**
 * Loading state: the label is announced (role=status); the grey placeholder
 * shapes are decorative. `list` mimics the case queue, `detail` a case page,
 * `inline` is the label alone with a spinner.
 */
export function Loading({ label, variant = 'inline' }: { label: string; variant?: 'inline' | 'list' | 'detail' }) {
  return (
    <div className="space-y-4" data-testid="loading">
      <p role="status" className="flex items-center gap-3 text-ink-2">
        <SpinnerIcon />
        {label}
      </p>
      {variant === 'list' ? (
        <div className="card space-y-4" aria-hidden="true">
          {[0, 1, 2, 3].map(row => (
            <div key={row} className="flex items-center gap-4">
              <span className="skeleton h-5 w-32" />
              <span className="skeleton hidden h-5 w-24 sm:block" />
              <span className="skeleton h-6 w-24 rounded-full" />
              <span className="skeleton ml-auto hidden h-5 w-40 md:block" />
            </div>
          ))}
        </div>
      ) : null}
      {variant === 'detail' ? (
        <div className="space-y-6" aria-hidden="true">
          <span className="skeleton block h-9 w-64" />
          <div className="card grid gap-3 p-3 sm:grid-cols-2 sm:p-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map(item => <span key={item} className="skeleton block h-16" />)}
          </div>
          <div className="grid gap-6 lg:grid-cols-12">
            <span className="skeleton block h-64 lg:col-span-7 xl:col-span-8" />
            <span className="skeleton block h-64 lg:col-span-5 xl:col-span-4" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Empty, withdrawn and not-found states share this calm card. */
export function EmptyState({ icon, title, titleId, children, action, testId, as = 'div' }: {
  icon: ReactNode;
  title?: string;
  /** With `as="section"`, the title's id names the region. */
  titleId?: string;
  children?: ReactNode;
  action?: ReactNode;
  testId?: string;
  as?: 'div' | 'section';
}) {
  const Tag = as;
  return (
    <Tag className="empty-state" data-testid={testId} aria-labelledby={as === 'section' ? titleId : undefined}>
      <span className="empty-state-icon">{icon}</span>
      {title ? <h2 id={titleId} className="text-lg">{title}</h2> : null}
      {children ? <div className="max-w-xl space-y-2 text-ink-2">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </Tag>
  );
}

export function useStableId(prefix: string): string {
  return `${prefix}-${useId().replace(/:/g, '')}`;
}
