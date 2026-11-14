-- Revert migration 007 (partner dashboard). Manual and last-resort: prefer
-- keeping 007 (older releases run with it) or restoring the pre-upgrade
-- backup. It drops every partner table, so it refuses while 008 or any
-- migration from 010 on is applied, while any partner referral exists, or while any partner_callback consent
-- exists. Rehearsed on 21 Oct 2026: the schema afterwards matched the
-- pre-007 schema dump. Run as postgres, after a backup:
--   docker compose -p "$SAFERIDE_PROJECT" exec -T postgres \
--     psql -X -v ON_ERROR_STOP=1 -U postgres -d saferide < infra/postgres/revert/revert-007.sql
begin;
set local lock_timeout = '5s';
do $$
begin
  if exists (select 1 from saferide.schema_migrations where version = '008') then
    raise exception 'migration 008 is applied: run revert-008.sql first';
  end if;
  if exists (select 1 from saferide.schema_migrations where version >= '010') then
    raise exception 'a later partner migration (010 onward) is applied: revert those first, newest first, by their headers';
  end if;
  if exists (select 1 from saferide.partner_referrals) then
    raise exception 'partner referrals exist: restore the pre-deploy backup instead of dropping them';
  end if;
  if exists (select 1 from saferide.consent_records where purpose = 'partner_callback') then
    raise exception 'partner_callback consents exist: restore the pre-deploy backup instead';
  end if;
end;
$$;
drop trigger if exists revoke_partner_referrals_on_withdrawal on saferide.consent_records;
drop trigger if exists remove_partner_callback_on_withdrawal on saferide.consent_records;
drop table if exists saferide.partner_referral_callbacks, saferide.partner_case_notes,
  saferide.partner_referrals, saferide.partner_sessions, saferide.partner_users,
  saferide.partner_organizations, saferide.partner_operators, saferide.partner_access_audit;
drop function if exists saferide.enforce_partner_referral_consent(),
  saferide.enforce_partner_referral_intake(), saferide.enforce_partner_referral_update(),
  saferide.enforce_partner_callback_consent(), saferide.remove_partner_callback_on_withdrawal(),
  saferide.revoke_partner_referrals_on_withdrawal(), saferide.remove_partner_callback_on_revocation(),
  saferide.reject_partner_append_only_update();
drop index if exists saferide.cases_id_owner_unique;
alter table saferide.consent_records drop constraint consent_records_purpose_check;
alter table saferide.consent_records add constraint consent_records_purpose_check check (purpose in (
  'pathway_submission', 'anonymous_aggregate', 'analytics', 'research', 'model_training', 'partner_follow_up'));
delete from saferide.schema_migrations where version = '007';
commit;
