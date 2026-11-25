-- Partner dashboard: the operator's referral commands in
-- jobs/partnerAdmin.ts. `referral:list` shows one org's referrals as
-- metadata only; `referral:revoke` is a safeguarding kill switch for one
-- referral (misrouted case, safeguarding concern, compromised partner).
-- There is deliberately no operator command that shares a case with an
-- org: sharing stays survivor-initiated and consented.
--
-- Revocation reuses 007's path: partner_referrals.access_revoked_at with
-- revoke_reason 'operator' (allowed since 007). The partner then gets the
-- same tombstone and 410s as after the survivor withdraws, and 007's
-- remove_partner_callback_on_revocation trigger deletes the callback. This
-- migration:
--   1. allows the operator.referral.list and operator.referral.revoke audit
--      actions;
--   2. adds partner_access_audit.reason_code: a closed set of codes, never
--      free text, recorded only on operator.referral.revoke rows;
--   3. deletes the referral's partner notes on ANY revocation, as the
--      consent-withdrawal trigger already does, so an operator revocation
--      leaves exactly what a withdrawal leaves.
-- No grant changes: the runtime role already updates partner_referrals,
-- deletes notes and callbacks (withdrawal) and appends to the audit, which
-- stays append-only (007 and runtime-role.sql). 009 is reserved for the
-- evidence-derivatives change; this file does not depend on it.
--
-- Apply like 007 (backup first; one transaction with lock_timeout 5s;
-- re-applying is a no-op).
-- Rollback (only once no audit row carries a reason code or a new action):
--   begin;
--   drop trigger if exists remove_partner_notes_on_revocation on saferide.partner_referrals;
--   drop function if exists saferide.remove_partner_notes_on_revocation();
--   alter table saferide.partner_access_audit drop constraint if exists partner_audit_reason_code;
--   alter table saferide.partner_access_audit drop column if exists reason_code;
--   -- then restore 007's partner_access_audit_action_check without the two operator.referral.* actions
--   delete from saferide.schema_migrations where version = '010';
--   commit;
begin;
set local lock_timeout = '5s';

alter table saferide.partner_access_audit
  drop constraint if exists partner_access_audit_action_check;
alter table saferide.partner_access_audit
  add constraint partner_access_audit_action_check check (action in (
    'operator.operator.add', 'operator.operator.disable',
    'operator.org.create', 'operator.org.set_agreement', 'operator.org.intake',
    'operator.user.invite', 'operator.user.disable', 'operator.user.reset',
    'operator.sessions.revoke', 'operator.audit.export', 'operator.seed.synthetic',
    'operator.referral.list', 'operator.referral.revoke',
    'auth.enroll.start', 'auth.enroll.complete', 'auth.login', 'auth.totp', 'auth.logout',
    'auth.lockout',
    'partner.me.read', 'partner.referral.list', 'partner.referral.read',
    'partner.referral.status', 'partner.referral.note', 'partner.referral.callback.read',
    'partner.evidence.url',
    'partner.org.users.list', 'partner.org.user.disable', 'partner.org.audit.read'
  ));

-- Why an operator revoked a referral: a code from
-- PARTNER_OPERATOR_REVOKE_REASONS (repositories/partnerRepository.ts).
alter table saferide.partner_access_audit
  add column if not exists reason_code text;
alter table saferide.partner_access_audit
  drop constraint if exists partner_audit_reason_code;
alter table saferide.partner_access_audit
  add constraint partner_audit_reason_code check (
    reason_code is null or (
      action = 'operator.referral.revoke' and reason_code in (
        'misrouted', 'safeguarding_concern', 'partner_compromise', 'survivor_request_offline', 'other'
      )
    )
  );

-- Every revocation drops the partner's internal notes with the access, not
-- only a consent withdrawal (007 deletes them in its withdrawal trigger,
-- which keeps doing so; the second delete then finds nothing).
create or replace function saferide.remove_partner_notes_on_revocation()
returns trigger language plpgsql as $$
begin
  if new.access_revoked_at is not null and old.access_revoked_at is null then
    delete from saferide.partner_case_notes where referral_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists remove_partner_notes_on_revocation on saferide.partner_referrals;
create trigger remove_partner_notes_on_revocation
after update of access_revoked_at on saferide.partner_referrals
for each row execute function saferide.remove_partner_notes_on_revocation();

insert into saferide.schema_migrations (version, name)
values ('010', 'partner_operator_referral_revoke')
on conflict (version) do nothing;

commit;
