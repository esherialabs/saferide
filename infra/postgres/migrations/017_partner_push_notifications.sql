-- Generic browser notifications. Endpoints and browser keys are sealed at rest.
begin;
set local lock_timeout = '5s';
create table if not exists saferide.partner_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  org_id uuid not null,
  session_id uuid not null unique references saferide.partner_sessions(id) on delete cascade,
  endpoint_hash text not null unique check (endpoint_hash ~ '^[a-f0-9]{64}$'),
  subscription_enc text not null check (subscription_enc ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$'),
  created_at timestamptz not null default now(),
  last_accepted_at timestamptz,
  last_outcome text check (last_outcome in ('accepted', 'retry', 'refused')),
  foreign key (user_id, org_id) references saferide.partner_users(id, org_id) on delete cascade
);
create index if not exists partner_push_user_idx on saferide.partner_push_subscriptions(user_id);
create table if not exists saferide.partner_push_jobs (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references saferide.partner_push_subscriptions(id) on delete cascade,
  referral_id uuid references saferide.partner_referrals(id) on delete cascade,
  kind text not null check (kind in ('attention', 'test')),
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts between 0 and 5),
  claim_token uuid,
  claim_until timestamptz,
  unique (subscription_id, referral_id),
  check ((kind = 'test') = (referral_id is null))
);
create index if not exists partner_push_due_idx on saferide.partner_push_jobs(next_attempt_at);
create or replace function saferide.enqueue_partner_push()
returns trigger language plpgsql as $$
begin
  insert into saferide.partner_push_jobs(subscription_id, referral_id, kind)
    select p.id, new.id, 'attention' from saferide.partner_push_subscriptions p
    join saferide.partner_sessions s on s.id = p.session_id
    join saferide.partner_users u on u.id = s.user_id
    join saferide.partner_organizations o on o.id = s.org_id
    where p.org_id = new.org_id and s.revoked_at is null
      and s.idle_expires_at > now() and s.absolute_expires_at > now()
      and u.status = 'active' and not u.must_change_password and o.status = 'active'
      and (s.mfa_verified or (s.mfa_waived and not o.mfa_required))
    on conflict (subscription_id, referral_id) do nothing;
  return new;
end;
$$;
drop trigger if exists enqueue_partner_push on saferide.partner_referrals;
create trigger enqueue_partner_push after insert on saferide.partner_referrals
for each row execute function saferide.enqueue_partner_push();
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
    'partner.summary.read', 'partner.staff.list', 'partner.coverage.change', 'partner.push.subscribe', 'partner.push.unsubscribe', 'partner.push.test'
  ));



do $$ begin
  if exists (select 1 from pg_roles where rolname = 'saferide_api') then
    grant select, insert, update, delete on saferide.partner_push_subscriptions, saferide.partner_push_jobs to saferide_api;
  end if;
end $$;
insert into saferide.schema_migrations(version, name) values ('017', 'partner_push_notifications') on conflict(version) do nothing;
commit;
