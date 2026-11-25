-- Revert migration 008 (partner retention and deletion), from its header.
-- Manual and last-resort: prefer keeping 008 or restoring the pre-upgrade
-- backup. Refuses while any shared-evidence snapshot row exists (it would
-- destroy them). Run before revert-007.sql. Run as postgres, after a backup:
--   docker compose -p "$SAFERIDE_PROJECT" exec -T postgres \
--     psql -X -v ON_ERROR_STOP=1 -U postgres -d saferide < infra/postgres/revert/revert-008.sql
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regclass('saferide.partner_referral_evidence') is not null
     and exists (select 1 from saferide.partner_referral_evidence) then
    raise exception 'partner_referral_evidence has rows: restore the pre-deploy backup instead of dropping them';
  end if;
end;
$$;
drop table if exists saferide.partner_referral_evidence;
alter table saferide.partner_referrals drop constraint if exists partner_referral_closure_reason_code;
delete from saferide.retention_policies where policy_id in ('partner-access-after-close-v1', 'partner-audit-v1');
alter table saferide.deletion_targets drop constraint if exists deletion_targets_target_class_check;
alter table saferide.deletion_targets add constraint deletion_targets_target_class_check check (target_class in (
  'case_rows', 'attachments', 'object_storage', 'chat', 'indexes', 'caches',
  'derived_linkable_records', 'temporary_files', 'abandoned_uploads'));
delete from saferide.schema_migrations where version = '008';
commit;
