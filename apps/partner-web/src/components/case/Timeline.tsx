import { formatDateTime, t } from '../../lib/i18n.ts';
import { isSafeRideActor, type PersonRef, type TimelineEvent } from '../../lib/partnerApi.ts';
import { actorText, assigneeText } from '../caseBadges.tsx';
import { ClockIcon, ShieldCheckIcon } from '../icons.tsx';
import { CardHeading } from '../ui.tsx';

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Who did what: every case-management entry names its actor when the API gives one. */
export function describeEvent(event: TimelineEvent, myUserId: string | null): string {
  const who = (person: PersonRef | null | undefined) => (person ? assigneeText(person, myUserId) : null);
  const actor = event.actor ? actorText(event.actor, myUserId) : null;
  const bySaferide = isSafeRideActor(event.actor);
  const onwardType = event.onward ? t(`onward.type.${event.onward.type}`) : t('timeline.onwardUnknown');
  const onwardStatus = event.onward ? lower(t(`onward.status.${event.onward.status}`)) : '';
  switch (event.event) {
    case 'received':
      return t('timeline.received');
    case 'acknowledged':
      return actor ? t('timeline.acknowledgedBy', { actor }) : t('timeline.acknowledged');
    case 'assigned': {
      const assignee = who(event.assignee);
      if (actor && !bySaferide && event.assignee && event.actor && event.assignee.id === event.actor.id) return t('timeline.assignedSelf', { actor });
      if (!assignee) return t('timeline.assignedSomeone');
      return actor ? t('timeline.assignedBy', { actor, assignee }) : t('timeline.assigned', { assignee });
    }
    case 'unassigned':
      if (bySaferide) return t('timeline.unassignedBySaferide');
      return actor ? t('timeline.unassignedBy', { actor }) : t('timeline.unassigned');
    case 'onward_created':
      return actor
        ? t('timeline.onward_createdBy', { actor, type: onwardType, status: onwardStatus })
        : t('timeline.onward_created', { type: onwardType, status: onwardStatus });
    case 'onward_status':
      return actor
        ? t('timeline.onward_statusBy', { actor, type: onwardType, status: onwardStatus })
        : t('timeline.onward_status', { type: onwardType, status: onwardStatus });
    case 'status_change':
    default: {
      const status = event.status ? t(`status.${event.status}`) : '';
      return actor ? t('timeline.status_changeBy', { status, actor }) : t('timeline.status_change', { status });
    }
  }
}

export function Timeline({ events, myUserId = null }: { events: TimelineEvent[]; myUserId?: string | null }) {
  const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (
    <section aria-labelledby="timeline-heading" className="card space-y-3">
      <CardHeading id="timeline-heading" icon={<ClockIcon />}>{t('timeline.heading')}</CardHeading>
      <ol className="ml-2 border-l-2 border-line" data-testid="timeline">
        {ordered.map((event, index) => (
          <li
            key={`${event.at}-${index}`}
            className="relative pb-4 pl-6 last:pb-0"
            data-event={event.event}
            data-actor={isSafeRideActor(event.actor) ? 'saferide' : undefined}
          >
            {isSafeRideActor(event.actor) ? (
              // SafeRide's own entries: a neutral shield instead of the dot, and the words say "SafeRide".
              <span className="absolute -left-[11px] top-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-line bg-surface text-ink-3" aria-hidden="true">
                <ShieldCheckIcon className="h-3.5 w-3.5" />
              </span>
            ) : (
              <span className="absolute -left-[7px] top-2 h-3 w-3 rounded-full border-2 border-surface bg-ink-3" aria-hidden="true" />
            )}
            <span className="block text-ink">{describeEvent(event, myUserId)}</span>
            <span className="block text-sm text-ink-3">{formatDateTime(event.at)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
