-- Partner dashboard: an operator-issued password option, MFA per org.
--
-- Owner decision (October 2026): HURIA staff get accounts that SafeRide
-- creates, with a strong password handed over in person; an authenticator
-- app is not required for now. MFA stays the default and can be switched
-- back on per org at any time.
--
-- 1. partner_organizations.mfa_required (default TRUE, so every existing
--    and new org keeps requiring TOTP). `partnerAdmin org:mfa --state off`
--    lets a correct password start a full session directly. Such a session
--    is recorded honestly: mfa_verified stays false and the new
--    partner_sessions.mfa_waived is true. It counts as a full session only
--    while its org still has MFA off; turning MFA back on ends it at once
--    (the API also revokes them, reason 'mfa_policy').
-- 2. partner_users.must_change_password: set by `partnerAdmin
--    user:set-password`; while set, a session can only read /me, change
--    the password and sign out.
-- 3. An active user no longer needs a TOTP: a user created by
--    user:set-password in an org with MFA off has none. When MFA is
--    required, such a user enrols an authenticator at their next sign-in
--    (totp_secret_enc pending, totp_enrolled_at null until the first code).
-- 4. New audit actions (operator.org.mfa, operator.user.set_password,
--    auth.totp.setup, auth.password.change) and session revoke reasons
--    (password_change, mfa_policy).
-- No grant changes: the runtime role already updates these tables. Adding
-- columns with constant defaults is metadata-only in PostgreSQL 11+.
--
-- Apply like 007 (backup first; one transaction with lock_timeout 5s;
-- re-applying is a no-op).
-- Rollback (roll the 013 API back with it; it reads the new columns). Only
-- once no active user lacks a TOTP and no audit row uses a new action:
--   begin;
--   update saferide.partner_sessions set revoked_at = now(), revoke_reason = 'operator'
--     where mfa_waived and revoked_at is null;
--   alter table saferide.partner_sessions drop constraint if exists partner_session_mfa_waiver;
--   alter table saferide.partner_sessions drop constraint if exists partner_session_pre_mfa_lifetime;
--   alter table saferide.partner_sessions add constraint partner_session_pre_mfa_lifetime check (
--     mfa_verified or absolute_expires_at <= created_at + interval '5 minutes');
--   alter table saferide.partner_sessions drop column if exists mfa_waived;
--   alter table saferide.partner_users drop constraint if exists partner_user_totp_pair;
--   alter table saferide.partner_users drop constraint if exists partner_user_active_credentials;
--   alter table saferide.partner_users add constraint partner_user_active_credentials check (
--     status <> 'active' or (password_hash is not null and totp_secret_enc is not null and totp_enrolled_at is not null));
--   alter table saferide.partner_users drop column if exists must_change_password;
--   alter table saferide.partner_organizations drop column if exists mfa_required;
--   -- then restore 010's partner_access_audit_action_check and 007's revoke_reason check
--   delete from saferide.schema_migrations where version = '013';
--   commit;
begin;
set local lock_timeout = '5s';

alter table saferide.partner_organizations
  add column if not exists mfa_required boolean not null default true;

alter table saferide.partner_users
  add column if not exists must_change_password boolean not null default false;

alter table saferide.partner_users
  drop constraint if exists partner_user_active_credentials;
alter table saferide.partner_users
  add constraint partner_user_active_credentials check (status <> 'active' or password_hash is not null);
alter table saferide.partner_users
  drop constraint if exists partner_user_totp_pair;
alter table saferide.partner_users
  add constraint partner_user_totp_pair check (totp_enrolled_at is null or totp_secret_enc is not null);

alter table saferide.partner_sessions
  add column if not exists mfa_waived boolean not null default false;
alter table saferide.partner_sessions
  drop constraint if exists partner_session_mfa_waiver;
alter table saferide.partner_sessions
  add constraint partner_session_mfa_waiver check (not (mfa_verified and mfa_waived));
alter table saferide.partner_sessions
  drop constraint if exists partner_session_pre_mfa_lifetime;
alter table saferide.partner_sessions
  add constraint partner_session_pre_mfa_lifetime check (
    mfa_verified or mfa_waived or absolute_expires_at <= created_at + interval '5 minutes'
  );
alter table saferide.partner_sessions
  drop constraint if exists partner_sessions_revoke_reason_check;
alter table saferide.partner_sessions
  add constraint partner_sessions_revoke_reason_check check (revoke_reason is null or revoke_reason in (
    'logout', 'mfa_upgrade', 'operator', 'user_disabled', 'credential_reset', 'org_suspended',
    'password_change', 'mfa_policy'
  ));

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
    'partner.org.users.list', 'partner.org.user.disable', 'partner.org.audit.read'
  ));

insert into saferide.schema_migrations (version, name)
values ('013', 'partner_password_only_option')
on conflict (version) do nothing;

commit;
