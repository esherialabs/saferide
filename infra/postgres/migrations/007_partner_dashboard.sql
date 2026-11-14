-- Partner dashboard, phase 1 (HURIA): an operator registry, organisations,
-- named partner users, server-side partner sessions, case routing,
-- append-only notes, an optional consented callback number and a named
-- partner access audit. Nothing here routes a case or enables intake: every
-- organisation starts with intake_enabled = false, and routing also needs
-- the separately gated partner_follow_up consent purpose.
--
-- New volumes apply this automatically (initdb). On an EXISTING volume, take
-- a backup first (`saferide.sh backup`), then:
--   docker compose -p "$SAFERIDE_PROJECT" exec -T postgres \
--     psql -X -v ON_ERROR_STOP=1 -U postgres -d saferide \
--     < infra/postgres/migrations/007_partner_dashboard.sql
-- It is one transaction with lock_timeout 5s: if a lock (consent_records,
-- cases) is not granted in time, nothing is applied; retry when quieter.
-- Re-applying is a no-op. It also revokes saferide_api's UPDATE/DELETE on
-- the audit, so runtime-role.sql need not be re-run.
-- Note (pre-existing): 006 does not record itself in schema_migrations;
-- 007 assumes 006 is applied (it needs consent_records_id_owner_unique).
--
-- Rollback. Prefer restoring the pre-migration backup. Otherwise, and only
-- while no partner data needs keeping (this destroys it):
--   begin;
--   drop trigger if exists revoke_partner_referrals_on_withdrawal on saferide.consent_records;
--   drop trigger if exists remove_partner_callback_on_withdrawal on saferide.consent_records;
--   drop table if exists saferide.partner_referral_callbacks, saferide.partner_case_notes,
--     saferide.partner_referrals, saferide.partner_sessions, saferide.partner_users,
--     saferide.partner_organizations, saferide.partner_operators, saferide.partner_access_audit;
--   drop function if exists saferide.enforce_partner_referral_consent(),
--     saferide.enforce_partner_referral_intake(), saferide.enforce_partner_referral_update(),
--     saferide.enforce_partner_callback_consent(), saferide.remove_partner_callback_on_withdrawal(),
--     saferide.revoke_partner_referrals_on_withdrawal(), saferide.remove_partner_callback_on_revocation(),
--     saferide.reject_partner_append_only_update();
--   drop index if exists saferide.cases_id_owner_unique;
--   -- only if no consent_records row has purpose 'partner_callback':
--   alter table saferide.consent_records drop constraint consent_records_purpose_check;
--   alter table saferide.consent_records add constraint consent_records_purpose_check check (purpose in (
--     'pathway_submission', 'anonymous_aggregate', 'analytics', 'research', 'model_training', 'partner_follow_up'));
--   delete from saferide.schema_migrations where version = '007';
--   commit;
begin;
set local lock_timeout = '5s';

-- partner_callback: the survivor's separate, optional consent to share a
-- callback number with the partner (design section 11).
alter table saferide.consent_records
  drop constraint if exists consent_records_purpose_check;
alter table saferide.consent_records
  add constraint consent_records_purpose_check check (purpose in (
    'pathway_submission', 'anonymous_aggregate', 'analytics', 'research',
    'model_training', 'partner_follow_up', 'partner_callback'
  ));

-- SafeRide operators who run jobs/partnerAdmin.ts. Created by that CLI, never
-- seeded with names; every CLI command must name an active operator here.
create table if not exists saferide.partner_operators (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique check (handle ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  display_name text not null check (length(display_name) between 1 and 120),
  role_label text not null check (length(role_label) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'disabled')),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partner_operator_disabled_state check ((status = 'disabled') = (disabled_at is not null))
);

create table if not exists saferide.partner_organizations (
  id uuid primary key default gen_random_uuid(),
  stable_id text not null unique check (
    length(stable_id) between 3 and 80 and stable_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  display_name text not null check (length(display_name) between 1 and 160),
  status text not null default 'active' check (status in ('active', 'suspended')),
  intake_enabled boolean not null default false,
  agreement_ref text check (agreement_ref is null or length(agreement_ref) between 1 and 160),
  agreement_signed_at timestamptz,
  agreement_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partner_org_agreement_window check (
    (agreement_ref is null and agreement_signed_at is null and agreement_expires_at is null) or
    (
      agreement_ref is not null and agreement_signed_at is not null and
      agreement_expires_at is not null and agreement_expires_at > agreement_signed_at
    )
  ),
  constraint partner_org_intake_requires_agreement check (
    intake_enabled = false or (status = 'active' and agreement_ref is not null)
  )
);

create table if not exists saferide.partner_users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references saferide.partner_organizations(id),
  email text not null check (
    length(email) between 3 and 254 and email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  ),
  display_name text not null check (length(display_name) between 1 and 120),
  role text not null check (role in ('partner_admin', 'partner_caseworker')),
  status text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  password_hash text check (password_hash is null or (length(password_hash) <= 512 and password_hash ~ '^scrypt\$')),
  totp_secret_enc text check (
    totp_secret_enc is null or (
      length(totp_secret_enc) <= 512 and totp_secret_enc ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{8,}$'
    )
  ),
  totp_enrolled_at timestamptz,
  totp_last_step bigint check (totp_last_step is null or totp_last_step >= 0),
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  lockout_count integer not null default 0 check (lockout_count >= 0),
  locked_until timestamptz,
  enrollment_token_hash text unique check (
    enrollment_token_hash is null or enrollment_token_hash ~ '^[a-f0-9]{64}$'
  ),
  enrollment_expires_at timestamptz,
  last_login_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  constraint partner_user_enrollment_pair check (
    (enrollment_token_hash is null) = (enrollment_expires_at is null)
  ),
  constraint partner_user_active_credentials check (
    status <> 'active' or (
      password_hash is not null and totp_secret_enc is not null and totp_enrolled_at is not null
    )
  ),
  constraint partner_user_disabled_state check (
    (status = 'disabled') = (disabled_at is not null) and
    (status <> 'disabled' or enrollment_token_hash is null)
  )
);

create unique index if not exists partner_users_email_unique on saferide.partner_users(email);

create table if not exists saferide.partner_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null,
  org_id uuid not null,
  mfa_verified boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or revoke_reason in (
    'logout', 'mfa_upgrade', 'operator', 'user_disabled', 'credential_reset', 'org_suspended'
  )),
  foreign key (user_id, org_id) references saferide.partner_users(id, org_id) on delete cascade,
  constraint partner_session_expiry_order check (
    idle_expires_at <= absolute_expires_at and absolute_expires_at > created_at
  ),
  constraint partner_session_max_lifetime check (
    absolute_expires_at <= created_at + interval '12 hours'
  ),
  constraint partner_session_pre_mfa_lifetime check (
    mfa_verified or absolute_expires_at <= created_at + interval '5 minutes'
  ),
  constraint partner_session_revocation check ((revoked_at is null) = (revoke_reason is null))
);

-- Lets partner_referrals prove the consent and the case share one owner.
create unique index if not exists cases_id_owner_unique on saferide.cases(id, owner_id);

create table if not exists saferide.partner_referrals (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  owner_id uuid not null,
  org_id uuid not null references saferide.partner_organizations(id),
  -- One partner_follow_up consent backs exactly one referral.
  consent_record_id uuid not null unique,
  reference text not null unique check (reference ~ '^SR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  status text not null default 'new' check (status in (
    'new', 'acknowledged', 'in_progress', 'referred_onward', 'closed'
  )),
  closure_reason text check (closure_reason is null or length(closure_reason) between 1 and 500),
  status_changed_at timestamptz not null default now(),
  access_revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or revoke_reason in (
    'consent_withdrawn', 'case_deleted', 'operator'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, org_id),
  unique (id, org_id),
  unique (id, org_id, owner_id),
  foreign key (case_id, owner_id) references saferide.cases(id, owner_id) on delete cascade,
  foreign key (consent_record_id, owner_id) references saferide.consent_records(id, owner_id) on delete cascade,
  constraint partner_referral_closure check ((status = 'closed') = (closure_reason is not null)),
  constraint partner_referral_revocation check ((access_revoked_at is null) = (revoke_reason is null))
);

create table if not exists saferide.partner_case_notes (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null,
  org_id uuid not null,
  author_user_id uuid not null,
  body text not null check (length(body) between 1 and 2000 and btrim(body) <> ''),
  created_at timestamptz not null default now(),
  foreign key (referral_id, org_id) references saferide.partner_referrals(id, org_id) on delete cascade,
  foreign key (author_user_id, org_id) references saferide.partner_users(id, org_id)
);

-- Optional callback number. Only the application-encrypted value is stored
-- (never in clear, no partial digits). One per referral, owned by the same
-- survivor, under its own partner_callback consent; removed when that
-- consent is withdrawn or the referral's access is revoked.
create table if not exists saferide.partner_referral_callbacks (
  referral_id uuid primary key,
  org_id uuid not null,
  owner_id uuid not null,
  consent_record_id uuid not null unique,
  -- v1.<iv>.<tag>.<ciphertext>, base64url: AES-256-GCM, AAD bound to the referral id.
  phone_enc text not null check (
    length(phone_enc) <= 512 and phone_enc ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{8,}$'
  ),
  created_at timestamptz not null default now(),
  foreign key (referral_id, org_id, owner_id)
    references saferide.partner_referrals(id, org_id, owner_id) on delete cascade,
  foreign key (consent_record_id, owner_id) references saferide.consent_records(id, owner_id) on delete cascade
);

-- Named for DPA accountability, but never content or IP addresses. The
-- referral, attachment and user identifiers carry no foreign key so the log
-- outlives deletion of what it describes.
create table if not exists saferide.partner_access_audit (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  actor_type text not null check (actor_type in ('partner_user', 'operator', 'anonymous')),
  partner_user_id uuid,
  operator_ref text check (operator_ref is null or operator_ref ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  action text not null check (action in (
    'operator.operator.add', 'operator.operator.disable',
    'operator.org.create', 'operator.org.set_agreement', 'operator.org.intake',
    'operator.user.invite', 'operator.user.disable', 'operator.user.reset',
    'operator.sessions.revoke', 'operator.audit.export', 'operator.seed.synthetic',
    'auth.enroll.start', 'auth.enroll.complete', 'auth.login', 'auth.totp', 'auth.logout',
    'auth.lockout',
    'partner.me.read', 'partner.referral.list', 'partner.referral.read',
    'partner.referral.status', 'partner.referral.note', 'partner.referral.callback.read',
    'partner.evidence.url',
    'partner.org.users.list', 'partner.org.user.disable', 'partner.org.audit.read'
  )),
  referral_id uuid,
  attachment_id uuid,
  target_user_id uuid,
  outcome text not null check (outcome in ('success', 'denied', 'failed')),
  request_id text not null check (length(request_id) between 1 and 180),
  policy_version text not null check (
    length(policy_version) between 1 and 120 and policy_version ~ '^[A-Za-z0-9._:-]+$'
  ),
  created_at timestamptz not null default now(),
  constraint partner_audit_actor check (
    (actor_type = 'partner_user' and partner_user_id is not null and operator_ref is null) or
    (actor_type = 'operator' and operator_ref is not null and partner_user_id is null) or
    (actor_type = 'anonymous' and partner_user_id is null and operator_ref is null)
  )
);

create or replace function saferide.enforce_partner_referral_consent()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from saferide.consent_records consent
    where consent.id = new.consent_record_id
      and consent.owner_id = new.owner_id
      and consent.purpose = 'partner_follow_up'
      and consent.status = 'granted'
  ) then
    raise exception 'partner referral requires granted partner_follow_up consent';
  end if;
  return new;
end;
$$;

-- Intake is checked when the referral is written, not when it was switched
-- on: an expired or not-yet-signed agreement stops routing immediately.
create or replace function saferide.enforce_partner_referral_intake()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from saferide.partner_organizations org
    where org.id = new.org_id
      and org.status = 'active'
      and org.intake_enabled
      and org.agreement_signed_at <= now()
      and org.agreement_expires_at > now()
  ) then
    raise exception 'partner organisation is not open for intake';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_partner_referral_intake on saferide.partner_referrals;
create trigger enforce_partner_referral_intake
before insert on saferide.partner_referrals
for each row execute function saferide.enforce_partner_referral_intake();

drop trigger if exists enforce_partner_referral_consent on saferide.partner_referrals;
create trigger enforce_partner_referral_consent
before insert on saferide.partner_referrals
for each row execute function saferide.enforce_partner_referral_consent();

create or replace function saferide.enforce_partner_referral_update()
returns trigger language plpgsql as $$
begin
  if new.case_id <> old.case_id or new.owner_id <> old.owner_id or new.org_id <> old.org_id or
    new.consent_record_id <> old.consent_record_id or new.reference <> old.reference or
    new.created_at <> old.created_at then
    raise exception 'partner referral identity is immutable';
  end if;
  if old.access_revoked_at is not null then
    if new.access_revoked_at is distinct from old.access_revoked_at or
      new.revoke_reason is distinct from old.revoke_reason or
      new.status <> old.status or new.closure_reason is distinct from old.closure_reason then
      raise exception 'revoked partner referrals are frozen';
    end if;
    return new;
  end if;
  if new.status <> old.status then
    if not (
      (old.status = 'new' and new.status in ('acknowledged', 'closed')) or
      (old.status = 'acknowledged' and new.status in ('in_progress', 'closed')) or
      (old.status = 'in_progress' and new.status in ('referred_onward', 'closed')) or
      (old.status = 'referred_onward' and new.status = 'closed')
    ) then
      raise exception 'invalid partner referral status transition: % -> %', old.status, new.status;
    end if;
    new.status_changed_at := now();
  elsif new.closure_reason is distinct from old.closure_reason then
    raise exception 'partner referral closure reason changes only when closing';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_partner_referral_update on saferide.partner_referrals;
create trigger enforce_partner_referral_update
before update on saferide.partner_referrals
for each row execute function saferide.enforce_partner_referral_update();

create or replace function saferide.enforce_partner_callback_consent()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from saferide.consent_records consent
    where consent.id = new.consent_record_id
      and consent.owner_id = new.owner_id
      and consent.purpose = 'partner_callback'
      and consent.status = 'granted'
  ) then
    raise exception 'partner callback requires granted partner_callback consent';
  end if;
  if exists (
    select 1 from saferide.partner_referrals referral
    where referral.id = new.referral_id and referral.access_revoked_at is not null
  ) then
    raise exception 'partner callback cannot be added to a revoked referral';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_partner_callback_consent on saferide.partner_referral_callbacks;
create trigger enforce_partner_callback_consent
before insert or update on saferide.partner_referral_callbacks
for each row execute function saferide.enforce_partner_callback_consent();

create or replace function saferide.remove_partner_callback_on_withdrawal()
returns trigger language plpgsql as $$
begin
  if new.status = 'withdrawn' and old.status <> 'withdrawn' then
    delete from saferide.partner_referral_callbacks where consent_record_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists remove_partner_callback_on_withdrawal on saferide.consent_records;
create trigger remove_partner_callback_on_withdrawal
after update of status on saferide.consent_records
for each row when (new.purpose = 'partner_callback')
execute function saferide.remove_partner_callback_on_withdrawal();

-- Withdrawing partner_follow_up revokes the referral it backs in the same
-- transaction: the partner keeps only a tombstone, its internal notes are
-- deleted, and the callback number goes with the revocation (below).
create or replace function saferide.revoke_partner_referrals_on_withdrawal()
returns trigger language plpgsql as $$
begin
  if new.status = 'withdrawn' and old.status <> 'withdrawn' then
    update saferide.partner_referrals
    set access_revoked_at = now(), revoke_reason = 'consent_withdrawn'
    where consent_record_id = new.id and access_revoked_at is null;
    delete from saferide.partner_case_notes note
    using saferide.partner_referrals referral
    where note.referral_id = referral.id and referral.consent_record_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists revoke_partner_referrals_on_withdrawal on saferide.consent_records;
create trigger revoke_partner_referrals_on_withdrawal
after update of status on saferide.consent_records
for each row when (new.purpose = 'partner_follow_up')
execute function saferide.revoke_partner_referrals_on_withdrawal();

create or replace function saferide.remove_partner_callback_on_revocation()
returns trigger language plpgsql as $$
begin
  if new.access_revoked_at is not null and old.access_revoked_at is null then
    delete from saferide.partner_referral_callbacks where referral_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists remove_partner_callback_on_revocation on saferide.partner_referrals;
create trigger remove_partner_callback_on_revocation
after update of access_revoked_at on saferide.partner_referrals
for each row execute function saferide.remove_partner_callback_on_revocation();

create or replace function saferide.reject_partner_append_only_update()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

drop trigger if exists partner_case_notes_append_only on saferide.partner_case_notes;
create trigger partner_case_notes_append_only
before update on saferide.partner_case_notes
for each row execute function saferide.reject_partner_append_only_update();

drop trigger if exists partner_access_audit_append_only on saferide.partner_access_audit;
create trigger partner_access_audit_append_only
before update on saferide.partner_access_audit
for each row execute function saferide.reject_partner_append_only_update();

drop trigger if exists touch_partner_operators_updated_at on saferide.partner_operators;
create trigger touch_partner_operators_updated_at before update on saferide.partner_operators
for each row execute function saferide.touch_updated_at();

drop trigger if exists touch_partner_organizations_updated_at on saferide.partner_organizations;
create trigger touch_partner_organizations_updated_at before update on saferide.partner_organizations
for each row execute function saferide.touch_updated_at();

drop trigger if exists touch_partner_users_updated_at on saferide.partner_users;
create trigger touch_partner_users_updated_at before update on saferide.partner_users
for each row execute function saferide.touch_updated_at();

drop trigger if exists touch_partner_referrals_updated_at on saferide.partner_referrals;
create trigger touch_partner_referrals_updated_at before update on saferide.partner_referrals
for each row execute function saferide.touch_updated_at();

create index if not exists idx_partner_users_org on saferide.partner_users(org_id, status);
create index if not exists idx_partner_sessions_user_active
  on saferide.partner_sessions(user_id) where revoked_at is null;
create index if not exists idx_partner_sessions_expiry on saferide.partner_sessions(absolute_expires_at);
create index if not exists idx_partner_referrals_org_queue
  on saferide.partner_referrals(org_id, status, created_at desc);
create index if not exists idx_partner_referrals_owner on saferide.partner_referrals(owner_id);
create index if not exists idx_partner_case_notes_referral
  on saferide.partner_case_notes(referral_id, created_at);
create index if not exists idx_partner_referral_callbacks_consent
  on saferide.partner_referral_callbacks(consent_record_id);
create index if not exists idx_partner_access_audit_org_created
  on saferide.partner_access_audit(org_id, created_at desc);

-- On an existing database the owner's default privileges already granted the
-- runtime role full DML on these new tables. Keep the audit append-only and
-- notes uneditable for it; runtime-role.sql repeats this for new volumes.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'saferide_api') then
    revoke update, delete on saferide.partner_access_audit from saferide_api;
    revoke update on saferide.partner_case_notes from saferide_api;
  end if;
end;
$$;

insert into saferide.schema_migrations (version, name)
values ('007', 'partner_dashboard')
on conflict (version) do nothing;

commit;
