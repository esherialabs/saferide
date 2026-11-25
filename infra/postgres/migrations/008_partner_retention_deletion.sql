-- Partner dashboard, P3: the evidence a survivor shared with a partner,
-- plus the retention policies and the deletion target class that 007
-- deferred. Per-report consent, revocation on withdrawal and the intake
-- check live in 007. Nothing here enables routing or executes retention.
-- Apply like 007 (backup first; one transaction; re-applying is a no-op).
-- Rollback: drop table saferide.partner_referral_evidence; delete the two
-- partner-* retention rows; restore the 004 deletion_targets check;
-- delete from saferide.schema_migrations where version = '008'.
begin;
set local lock_timeout = '5s';

-- The evidence the survivor shared, fixed at routing time from the
-- packet's evidence manifest: one row per manifest entry, with the file's
-- sha256 when the packet carries it (none/light redaction; heavy withholds
-- it). A partner is only ever shown an attachment whose verified sha256
-- matches one of these rows, so a file uploaded later, or a different
-- file, is never shared without a new consent. No device ids or names.
create table if not exists saferide.partner_referral_evidence (
  referral_id uuid not null,
  org_id uuid not null,
  manifest_index integer not null check (manifest_index between 0 and 49),
  media_type text not null check (media_type in ('photo', 'video', 'audio', 'document')),
  sha256 text check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key (referral_id, manifest_index),
  foreign key (referral_id, org_id) references saferide.partner_referrals(id, org_id) on delete cascade
);

create index if not exists idx_partner_referral_evidence_sha256
  on saferide.partner_referral_evidence(referral_id, sha256) where sha256 is not null;

drop trigger if exists partner_referral_evidence_immutable on saferide.partner_referral_evidence;
create trigger partner_referral_evidence_immutable
before update on saferide.partner_referral_evidence
for each row execute function saferide.reject_partner_append_only_update();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'saferide_api') then
    revoke update on saferide.partner_referral_evidence from saferide_api;
  end if;
end;
$$;

-- Closure reasons are codes, never free text (services/partnerReferralStatus.ts
-- PARTNER_CLOSURE_REASONS, matching the dashboard). NOT VALID: every new or
-- changed row is checked, while any pre-008 test row (partner intake has
-- never been on live) cannot block the migration. Run
-- `alter table saferide.partner_referrals validate constraint
-- partner_referral_closure_reason_code;` to confirm none exist.
alter table saferide.partner_referrals
  drop constraint if exists partner_referral_closure_reason_code;
alter table saferide.partner_referrals
  add constraint partner_referral_closure_reason_code check (closure_reason is null or closure_reason in (
    'support_provided', 'referred_elsewhere', 'survivor_did_not_make_contact',
    'outside_mandate', 'duplicate', 'other'
  )) not valid;

-- Proposed retention, mirrored in config/privacy/privacy-controls.v1.json.
-- Both wait for legal approval and do not execute.
insert into saferide.retention_policies (
  policy_id, scope, duration_days, approval_status, execution_enabled, policy_version
) values
  ('partner-access-after-close-v1', 'server', 90, 'pending_legal', false, 'privacy-controls.2026-07-30.2'),
  ('partner-audit-v1', 'server', 730, 'pending_legal', false, 'privacy-controls.2026-07-30.2')
on conflict (policy_id) do update
set scope = excluded.scope,
    duration_days = excluded.duration_days,
    approval_status = excluded.approval_status,
    execution_enabled = excluded.execution_enabled,
    policy_version = excluded.policy_version;

-- Deletion receipts must prove partner access was revoked.
alter table saferide.deletion_targets
  drop constraint if exists deletion_targets_target_class_check;
alter table saferide.deletion_targets
  add constraint deletion_targets_target_class_check check (target_class in (
    'case_rows', 'attachments', 'object_storage', 'chat', 'indexes', 'caches',
    'derived_linkable_records', 'temporary_files', 'abandoned_uploads', 'partner_access'
  ));

insert into saferide.schema_migrations (version, name)
values ('008', 'partner_retention_deletion')
on conflict (version) do nothing;

commit;
