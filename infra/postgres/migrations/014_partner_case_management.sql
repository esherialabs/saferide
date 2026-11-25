-- Partner dashboard: case management inside the partner's own team.
--
-- 1. partner_referrals.assignee_user_id: who in the partner organisation is
--    in charge of a referral. Only an active user of the same organisation
--    can be assigned (foreign key plus trigger). Revoking the referral's
--    access (survivor withdrawal or operator revocation) clears it, and a
--    revoked referral's assignment is frozen like the rest of the tombstone.
--    Disabling or resetting a user (partnerAdmin user:disable, user:reset)
--    releases their referrals, and the API treats an assignee who is no
--    longer active as nobody.
-- 2. partner_onward_referrals: where the partner sent the survivor next
--    (police, medical, psychosocial, legal aid, shelter, child protection,
--    other), with short partner-typed text (organisation, contact role, an
--    external reference such as an OB number, a note) and a status:
--    planned -> made | cancelled; made -> accepted | declined;
--    accepted -> completed. declined, completed and cancelled are final.
--    Only the status moves; every other column is fixed once written.
-- 3. partner_case_activity: an append-only, content-free log of who
--    acknowledged, assigned, unassigned, created or moved an onward
--    referral. It holds ids, codes and timestamps only, never free text.
--    actor_type 'saferide' (no user) records SafeRide releasing a user's
--    referrals when an operator disables or resets that user.
-- 4. The audit actions partner.referral.assign, partner.onward.create,
--    partner.onward.status, partner.summary.read and partner.staff.list.
--    The action list also keeps 013's actions (operator.org.mfa,
--    operator.user.set_password, auth.totp.setup, auth.password.change) so
--    applying 014 after 013 never drops them. 013, if applied, must be
--    applied BEFORE 014: 013 rewrites the same check without 014's actions.
--
-- Privacy. Everything here is partner-internal, like partner_case_notes:
-- none of it is written to case_events, so the survivor's timeline is
-- unchanged. The text is what the partner types about its own work; the API
-- never copies survivor packet text into these tables, so the partner
-- location scrubber does not run on it. On any revocation of the referral's
-- access (007's withdrawal trigger and 010's revocation trigger, both
-- extended below) the onward referrals and the activity are deleted with the
-- notes, and the assignment is cleared. Deleting the case deletes them by
-- cascade. Retention and deletion follow the existing partner_access
-- deletion target class and the partner-access-after-close-v1 retention
-- policy (008; apps/api/src/services/privacyLifecycle.ts lists the tables).
--
-- Runtime role. partner_case_activity is append-only (UPDATE revoked, and a
-- trigger rejects updates). partner_onward_referrals can only have its
-- status (and the user who moved it) updated: table-level UPDATE is revoked
-- and column UPDATE granted on those two columns, and a trigger enforces the
-- allowed moves. Rows of both tables can be deleted only once the
-- referral's access has been revoked or with the referral itself (a
-- trigger refuses any other delete). runtime-role.sql repeats the grants
-- for new volumes.
--
-- Apply like 007 (backup first; one transaction with lock_timeout 5s;
-- re-applying is a no-op).
-- Rollback (roll the 014 API back with it; it reads the new column and
-- tables). This destroys assignments, onward referrals and the activity:
--   begin;
--   drop table if exists saferide.partner_case_activity, saferide.partner_onward_referrals;
--   drop trigger if exists enforce_partner_referral_assignment on saferide.partner_referrals;
--   alter table saferide.partner_referrals drop column if exists assignee_user_id;
--   drop function if exists saferide.enforce_partner_referral_assignment(),
--     saferide.enforce_partner_onward_insert(), saferide.enforce_partner_onward_update(),
--     saferide.enforce_partner_case_record_active(), saferide.guard_partner_case_record_delete();
--   -- restore 007's revoke_partner_referrals_on_withdrawal and 010's
--   -- remove_partner_notes_on_revocation bodies (notes only), and the
--   -- previous partner_access_audit_action_check (only once no audit row
--   -- uses a 014 action)
--   delete from saferide.schema_migrations where version = '014';
--   commit;
begin;
set local lock_timeout = '5s';

-- 1. Assignment -------------------------------------------------------------

alter table saferide.partner_referrals
  add column if not exists assignee_user_id uuid;

alter table saferide.partner_referrals
  drop constraint if exists partner_referral_assignee_fk;
alter table saferide.partner_referrals
  add constraint partner_referral_assignee_fk
  foreign key (assignee_user_id, org_id) references saferide.partner_users(id, org_id);

create or replace function saferide.enforce_partner_referral_assignment()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if old.access_revoked_at is not null then
      if new.assignee_user_id is distinct from old.assignee_user_id then
        raise exception 'revoked partner referrals are frozen';
      end if;
      return new;
    end if;
  end if;
  if new.access_revoked_at is not null then
    -- Ending the access drops the assignment with it.
    new.assignee_user_id := null;
    return new;
  end if;
  if new.assignee_user_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.assignee_user_id is not distinct from old.assignee_user_id then
      return new;
    end if;
  end if;
  if not exists (
    select 1 from saferide.partner_users assignee
    where assignee.id = new.assignee_user_id
      and assignee.org_id = new.org_id
      and assignee.status = 'active'
  ) then
    raise exception 'partner referral assignee must be an active user of its organisation';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_partner_referral_assignment on saferide.partner_referrals;
create trigger enforce_partner_referral_assignment
before insert or update on saferide.partner_referrals
for each row execute function saferide.enforce_partner_referral_assignment();

create index if not exists idx_partner_referrals_org_assignee
  on saferide.partner_referrals(org_id, assignee_user_id) where assignee_user_id is not null;

-- 2. Onward referrals ------------------------------------------------------

create table if not exists saferide.partner_onward_referrals (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null,
  org_id uuid not null,
  type text not null check (type in (
    'police', 'medical', 'psychosocial', 'legal_aid', 'shelter', 'child_protection', 'other'
  )),
  organisation text check (
    organisation is null or (length(organisation) between 1 and 120 and btrim(organisation) <> '')
  ),
  contact_role text check (
    contact_role is null or (length(contact_role) between 1 and 120 and btrim(contact_role) <> '')
  ),
  external_reference text check (
    external_reference is null or (length(external_reference) between 1 and 80 and btrim(external_reference) <> '')
  ),
  note text check (note is null or (length(note) between 1 and 1000 and btrim(note) <> '')),
  status text not null check (status in ('planned', 'made', 'accepted', 'declined', 'completed', 'cancelled')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  status_changed_by uuid not null,
  unique (id, org_id),
  unique (id, referral_id, org_id),
  foreign key (referral_id, org_id) references saferide.partner_referrals(id, org_id) on delete cascade,
  foreign key (created_by, org_id) references saferide.partner_users(id, org_id),
  foreign key (status_changed_by, org_id) references saferide.partner_users(id, org_id)
);

create index if not exists idx_partner_onward_referrals_referral
  on saferide.partner_onward_referrals(referral_id, created_at);

-- 3. Activity --------------------------------------------------------------

create table if not exists saferide.partner_case_activity (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null,
  org_id uuid not null,
  actor_type text not null default 'partner_user' check (actor_type in ('partner_user', 'saferide')),
  actor_user_id uuid,
  kind text not null check (kind in ('acknowledged', 'assigned', 'unassigned', 'onward_created', 'onward_status')),
  assignee_user_id uuid,
  onward_id uuid,
  onward_type text check (onward_type is null or onward_type in (
    'police', 'medical', 'psychosocial', 'legal_aid', 'shelter', 'child_protection', 'other'
  )),
  onward_status text check (onward_status is null or onward_status in (
    'planned', 'made', 'accepted', 'declined', 'completed', 'cancelled'
  )),
  created_at timestamptz not null default now(),
  foreign key (referral_id, org_id) references saferide.partner_referrals(id, org_id) on delete cascade,
  foreign key (actor_user_id, org_id) references saferide.partner_users(id, org_id),
  foreign key (assignee_user_id, org_id) references saferide.partner_users(id, org_id),
  foreign key (onward_id, referral_id, org_id)
    references saferide.partner_onward_referrals(id, referral_id, org_id) on delete cascade,
  constraint partner_case_activity_actor check (
    (actor_type = 'partner_user' and actor_user_id is not null) or
    (actor_type = 'saferide' and actor_user_id is null and kind = 'unassigned')
  ),
  constraint partner_case_activity_shape check (
    (kind = 'assigned' and assignee_user_id is not null
      and onward_id is null and onward_type is null and onward_status is null) or
    (kind in ('acknowledged', 'unassigned') and assignee_user_id is null
      and onward_id is null and onward_type is null and onward_status is null) or
    (kind in ('onward_created', 'onward_status') and assignee_user_id is null
      and onward_id is not null and onward_type is not null and onward_status is not null)
  )
);

-- A database that applied an earlier draft of 014 gets the actor columns too.
alter table saferide.partner_case_activity
  add column if not exists actor_type text not null default 'partner_user';
alter table saferide.partner_case_activity alter column actor_user_id drop not null;
alter table saferide.partner_case_activity drop constraint if exists partner_case_activity_actor_type_check;
alter table saferide.partner_case_activity
  add constraint partner_case_activity_actor_type_check check (actor_type in ('partner_user', 'saferide'));
alter table saferide.partner_case_activity drop constraint if exists partner_case_activity_actor;
alter table saferide.partner_case_activity
  add constraint partner_case_activity_actor check (
    (actor_type = 'partner_user' and actor_user_id is not null) or
    (actor_type = 'saferide' and actor_user_id is null and kind = 'unassigned')
  );

create index if not exists idx_partner_case_activity_referral
  on saferide.partner_case_activity(referral_id, created_at);

-- Guards ---------------------------------------------------------------

-- New onward referrals and activity only while the referral's access holds.
create or replace function saferide.enforce_partner_case_record_active()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from saferide.partner_referrals referral
    where referral.id = new.referral_id and referral.org_id = new.org_id
      and referral.access_revoked_at is null
  ) then
    raise exception '% rows can only be added to an active referral', tg_table_name;
  end if;
  return new;
end;
$$;

-- Removed only with the referral (cascade) or once its access has ended.
create or replace function saferide.guard_partner_case_record_delete()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from saferide.partner_referrals referral
    where referral.id = old.referral_id and referral.access_revoked_at is null
  ) then
    raise exception '% rows are removed only when the referral access ends', tg_table_name;
  end if;
  return old;
end;
$$;

create or replace function saferide.enforce_partner_onward_insert()
returns trigger language plpgsql as $$
begin
  if new.status not in ('planned', 'made') then
    raise exception 'a new onward referral starts as planned or made';
  end if;
  new.status_changed_by := new.created_by;
  new.status_changed_at := new.created_at;
  return new;
end;
$$;

create or replace function saferide.enforce_partner_onward_update()
returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.referral_id <> old.referral_id or new.org_id <> old.org_id or
    new.type <> old.type or new.organisation is distinct from old.organisation or
    new.contact_role is distinct from old.contact_role or
    new.external_reference is distinct from old.external_reference or
    new.note is distinct from old.note or new.created_by <> old.created_by or
    new.created_at <> old.created_at then
    raise exception 'onward referral details are fixed once written';
  end if;
  if new.status = old.status then
    raise exception 'an onward referral update must change its status';
  end if;
  if not (
    (old.status = 'planned' and new.status in ('made', 'cancelled')) or
    (old.status = 'made' and new.status in ('accepted', 'declined')) or
    (old.status = 'accepted' and new.status = 'completed')
  ) then
    raise exception 'invalid onward referral status transition: % -> %', old.status, new.status;
  end if;
  if exists (
    select 1 from saferide.partner_referrals referral
    where referral.id = new.referral_id and referral.access_revoked_at is not null
  ) then
    raise exception 'revoked partner referrals are frozen';
  end if;
  new.status_changed_at := now();
  return new;
end;
$$;

drop trigger if exists enforce_partner_onward_active on saferide.partner_onward_referrals;
create trigger enforce_partner_onward_active
before insert on saferide.partner_onward_referrals
for each row execute function saferide.enforce_partner_case_record_active();

drop trigger if exists enforce_partner_onward_insert on saferide.partner_onward_referrals;
create trigger enforce_partner_onward_insert
before insert on saferide.partner_onward_referrals
for each row execute function saferide.enforce_partner_onward_insert();

drop trigger if exists enforce_partner_onward_update on saferide.partner_onward_referrals;
create trigger enforce_partner_onward_update
before update on saferide.partner_onward_referrals
for each row execute function saferide.enforce_partner_onward_update();

drop trigger if exists guard_partner_onward_delete on saferide.partner_onward_referrals;
create trigger guard_partner_onward_delete
before delete on saferide.partner_onward_referrals
for each row execute function saferide.guard_partner_case_record_delete();

drop trigger if exists enforce_partner_activity_active on saferide.partner_case_activity;
create trigger enforce_partner_activity_active
before insert on saferide.partner_case_activity
for each row execute function saferide.enforce_partner_case_record_active();

drop trigger if exists partner_case_activity_append_only on saferide.partner_case_activity;
create trigger partner_case_activity_append_only
before update on saferide.partner_case_activity
for each row execute function saferide.reject_partner_append_only_update();

drop trigger if exists guard_partner_activity_delete on saferide.partner_case_activity;
create trigger guard_partner_activity_delete
before delete on saferide.partner_case_activity
for each row execute function saferide.guard_partner_case_record_delete();

-- Ending access deletes the partner's case-management records ------------

-- 007's withdrawal trigger: the referral is revoked first, then its
-- partner-internal records go (notes as before, plus the new tables).
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
    delete from saferide.partner_case_activity activity
    using saferide.partner_referrals referral
    where activity.referral_id = referral.id and referral.consent_record_id = new.id;
    delete from saferide.partner_onward_referrals onward
    using saferide.partner_referrals referral
    where onward.referral_id = referral.id and referral.consent_record_id = new.id;
  end if;
  return new;
end;
$$;

-- 010's revocation trigger (any revocation, withdrawal or operator).
create or replace function saferide.remove_partner_notes_on_revocation()
returns trigger language plpgsql as $$
begin
  if new.access_revoked_at is not null and old.access_revoked_at is null then
    delete from saferide.partner_case_notes where referral_id = new.id;
    delete from saferide.partner_case_activity where referral_id = new.id;
    delete from saferide.partner_onward_referrals where referral_id = new.id;
  end if;
  return new;
end;
$$;

-- 4. Audit actions (a superset of 010's and 013's lists) -------------------

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
    'partner.summary.read', 'partner.staff.list'
  ));

-- Runtime role (existing databases; runtime-role.sql repeats this) ---------

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'saferide_api') then
    revoke update on saferide.partner_case_activity from saferide_api;
    revoke update on saferide.partner_onward_referrals from saferide_api;
    grant update (status, status_changed_by) on saferide.partner_onward_referrals to saferide_api;
  end if;
end;
$$;

insert into saferide.schema_migrations (version, name)
values ('014', 'partner_case_management')
on conflict (version) do nothing;

commit;
