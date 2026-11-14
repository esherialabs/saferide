-- Explicit, revocable live monitoring; normal sessions retain idle expiry.
begin;
set local lock_timeout = '5s';
alter table saferide.partner_sessions
  add column if not exists coverage_active boolean not null default false,
  add column if not exists coverage_renewed_at timestamptz,
  add column if not exists coverage_epoch integer not null default 0 check (coverage_epoch >= 0);
alter table saferide.partner_sessions drop constraint if exists partner_session_max_lifetime;
alter table saferide.partner_sessions add constraint partner_session_max_lifetime check (
  absolute_expires_at <= coalesce(coverage_renewed_at, created_at) + interval '12 hours'
);
alter table saferide.partner_sessions drop constraint if exists partner_coverage_lease;
alter table saferide.partner_sessions add constraint partner_coverage_lease check (
  (not coverage_active or (coverage_epoch > 0 and coverage_renewed_at is not null))
  and (coverage_renewed_at is null or (
    (mfa_verified or mfa_waived) and coverage_renewed_at >= created_at and coverage_renewed_at <= last_seen_at
  ))
);
alter table saferide.partner_access_audit
  drop constraint if exists partner_access_audit_action_check;
alter table saferide.partner_access_audit
  add constraint partner_access_audit_action_check check (action in (
    'operator.operator.add', 'operator.operator.disable',
    'operator.org.create', 'operator.org.set_agreement', 'operator.org.intake', 'operator.org.mfa',
    'operator.user.invite', 'operator.user.disable', 'operator.user.reset', 'operator.user.set_password',
    'operator.sessions.revoke', 'operator.audit.export', 'operator.seed.synthetic',
    'operator.referral.list', 'operator.referral.revoke',
    'auth.enroll.start', 'auth.enroll.complete', 'auth.login', 'auth.totp', 'auth.totp.setup', 'auth.logout',
    'auth.lockout', 'auth.password.change',
    'partner.me.read', 'partner.referral.list', 'partner.referral.read',
    'partner.referral.status', 'partner.referral.note', 'partner.referral.callback.read',
    'partner.evidence.url',
    'partner.org.users.list', 'partner.org.user.disable', 'partner.org.audit.read',
    'partner.referral.assign', 'partner.onward.create', 'partner.onward.status',
    'partner.summary.read', 'partner.staff.list', 'partner.coverage.change'
  ));


insert into saferide.schema_migrations (version, name)
values ('016', 'partner_live_coverage') on conflict (version) do nothing;
commit;
