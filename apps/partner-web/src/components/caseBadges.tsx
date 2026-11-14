import type { ReactNode } from 'react';

import { t } from '../lib/i18n.ts';
import { isSafeRideActor, type OnwardStatus, type OnwardType, type PersonRef, type Priority } from '../lib/partnerApi.ts';
import {
  ChatBubblesIcon, EllipsisIcon, HeartIcon, HomeIcon, ScaleIcon, ShieldCheckIcon, UsersIcon, WarningIcon,
} from './icons.tsx';

/**
 * Case-management badges. Red always comes with an icon and words: an
 * escalation reads "Escalation" next to a warning triangle, and a case that
 * needs attention says so in bold next to its (pulsing) dot.
 */
export function PriorityBadge({ priority, quiet = false }: { priority: Priority; quiet?: boolean }) {
  if (priority === 'urgent') {
    return (
      <span className="chip chip-urgent" data-testid="priority-urgent">
        <WarningIcon className="h-4 w-4" />
        {t('priority.urgent')}
      </span>
    );
  }
  if (quiet) return <span className="text-sm text-ink-3">{t('priority.normal')}</span>;
  return <span className="chip chip-normal">{t('priority.normal')}</span>;
}

/** The pulsing red dot (static under prefers-reduced-motion) with its bold label. */
export function NeedsAttention({ className = '' }: { className?: string }) {
  return (
    <span className={`needs-attention ${className}`} data-testid="needs-attention">
      <AttentionDot />
      {t('attention.label')}
    </span>
  );
}

export function AttentionDot() {
  return (
    <span className="attention-dot" aria-hidden="true">
      <span className="attention-ping" data-testid="attention-ping" />
      <span className="attention-core" />
    </span>
  );
}

const ONWARD_ICONS: Record<OnwardType, (props: { className?: string }) => ReactNode> = {
  police: ShieldCheckIcon,
  medical: HeartIcon,
  psychosocial: ChatBubblesIcon,
  legal_aid: ScaleIcon,
  shelter: HomeIcon,
  child_protection: UsersIcon,
  other: EllipsisIcon,
};

export function OnwardTypeIcon({ type, className = 'h-5 w-5' }: { type: OnwardType; className?: string }) {
  const Icon = ONWARD_ICONS[type] ?? EllipsisIcon;
  return <Icon className={className} />;
}

function OnwardStatusShape({ status }: { status: OnwardStatus }) {
  const common = { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true, focusable: false } as const;
  switch (status) {
    case 'planned':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2" /></svg>;
    case 'made':
      return <svg {...common}><path d="M2 7h8M7 3.5L10.5 7 7 10.5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>;
    case 'accepted':
      return <svg {...common}><path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" /></svg>;
    case 'declined':
      return <svg {...common}><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" fill="none" stroke="currentColor" strokeWidth="2" /></svg>;
    case 'completed':
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="currentColor" /><path d="M4.5 7.2l1.8 1.8 3.4-4" fill="none" className="stroke-surface" strokeWidth="1.6" /></svg>;
    case 'cancelled':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M3.5 10.5l7-7" stroke="currentColor" strokeWidth="2" /></svg>;
  }
}

export function OnwardStatusChip({ status }: { status: OnwardStatus }) {
  return (
    <span className={`chip onward-${status}`} data-testid="onward-status">
      <OnwardStatusShape status={status} />
      {t(`onward.status.${status}`)}
    </span>
  );
}

/** "Name", "Name (you)" or "Unassigned". */
export function assigneeText(assignee: PersonRef | null, myUserId: string | null): string {
  if (!assignee) return t('assignee.unassigned');
  return assignee.id === myUserId ? t('assignee.you', { name: assignee.name }) : assignee.name;
}

/**
 * Who did something: a staff member as assigneeText shows them, or
 * "SafeRide" for entries SafeRide itself made (that ID is not a user).
 */
export function actorText(actor: PersonRef, myUserId: string | null): string {
  return isSafeRideActor(actor) ? t('brand.saferideName') : assigneeText(actor, myUserId);
}

/** Up to two initials from a staff member's display name (shown next to it). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('');
}
