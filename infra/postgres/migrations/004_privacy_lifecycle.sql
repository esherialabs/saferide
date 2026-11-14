begin;

alter table saferide.audit_events
  add column if not exists outcome text,
  add column if not exists policy_version text;

update saferide.audit_events
set actor_id = null,
    resource_id = null,
    metadata = null,
    outcome = coalesce(outcome, 'success'),
    policy_version = coalesce(policy_version, 'legacy-pre-privacy-controls');

alter table saferide.audit_events
  alter column outcome set not null,
  alter column policy_version set not null;

alter table saferide.audit_events
  drop constraint if exists audit_events_outcome_check;
alter table saferide.audit_events
  add constraint audit_events_outcome_check
  check (outcome is null or outcome in ('success', 'denied', 'failed'));

alter table saferide.audit_events
  drop constraint if exists audit_events_minimized_fields_check;
alter table saferide.audit_events
  add constraint audit_events_minimized_fields_check
  check (actor_id is null and resource_id is null and metadata is null);

update saferide.case_events event
set payload = jsonb_build_object(
  'schemaVersion', 'legacy-minimized.1',
  'workflowType', coalesce(case_record.pathway, 'unknown'),
  'status', case when event.event_type = 'submission' then 'submitted' else 'recorded' end
)
from saferide.cases case_record
where event.case_id = case_record.id;

alter table saferide.attachments
  add column if not exists retention_policy_id text,
  add column if not exists quarantine_status text not null default 'quarantined',
  add column if not exists scan_evidence jsonb;

alter table saferide.attachments
  drop constraint if exists attachments_quarantine_status_check;
alter table saferide.attachments
  add constraint attachments_quarantine_status_check
  check (quarantine_status in ('quarantined', 'released', 'rejected'));
alter table saferide.attachments
  drop constraint if exists attachments_antivirus_status_check;
alter table saferide.attachments
  add constraint attachments_antivirus_status_check
  check (antivirus_status in ('not_scanned', 'pending', 'clean', 'rejected'));
alter table saferide.attachments
  drop constraint if exists attachments_release_attestation_check;
alter table saferide.attachments
  add constraint attachments_release_attestation_check check (
    quarantine_status <> 'released' or (
      status = 'uploaded'
      and antivirus_status = 'clean'
      and scan_evidence is not null
      and sha256 ~ '^[a-f0-9]{64}$'
      and expected_sha256 ~ '^[a-f0-9]{64}$'
      and lower(sha256) = lower(expected_sha256)
    )
  );

create table if not exists saferide.policy_documents (
  document_type text not null,
  version text not null,
  locale text not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  effective_date date,
  review_status text not null check (review_status in ('pending_legal', 'approved', 'retired')),
  acceptance_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (document_type, version, locale),
  unique (document_type, version, locale, content_sha256),
  constraint approved_policy_acceptance check (
    acceptance_enabled = false or (review_status = 'approved' and effective_date is not null)
  )
);

create table if not exists saferide.policy_acceptances (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  document_type text not null,
  document_version text not null,
  locale text not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  accepted_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawal_effect text,
  foreign key (document_type, document_version, locale, content_sha256)
    references saferide.policy_documents(document_type, version, locale, content_sha256),
  constraint acceptance_withdrawal_note check (
    withdrawn_at is null or withdrawal_effect is not null
  )
);

create or replace function saferide.enforce_approved_policy_acceptance()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1
    from saferide.policy_documents document
    where document.document_type = new.document_type
      and document.version = new.document_version
      and document.locale = new.locale
      and document.content_sha256 = new.content_sha256
      and document.review_status = 'approved'
      and document.acceptance_enabled = true
      and document.effective_date is not null
      and document.effective_date <= new.accepted_at::date
  ) then
    raise exception 'policy document is not approved for acceptance';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_approved_policy_acceptance on saferide.policy_acceptances;
create trigger enforce_approved_policy_acceptance
before insert or update on saferide.policy_acceptances
for each row execute function saferide.enforce_approved_policy_acceptance();

create table if not exists saferide.consent_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  purpose text not null check (purpose in (
    'pathway_submission', 'analytics', 'research', 'model_training', 'partner_follow_up'
  )),
  consent_version text not null,
  status text not null check (status in ('granted', 'withdrawn')),
  granted_at timestamptz not null,
  withdrawn_at timestamptz,
  external_sharing_warning_acknowledged boolean not null default false,
  created_at timestamptz not null default now(),
  constraint consent_withdrawal_time check (
    (status = 'granted' and withdrawn_at is null) or
    (status = 'withdrawn' and withdrawn_at is not null)
  )
);

create table if not exists saferide.retention_policies (
  policy_id text primary key,
  scope text not null check (scope in ('local', 'server')),
  duration_days integer check (duration_days is null or duration_days > 0),
  approval_status text not null check (approval_status in (
    'approved_engineering', 'approved_legal', 'pending_legal', 'retired'
  )),
  execution_enabled boolean not null default false,
  policy_version text not null,
  created_at timestamptz not null default now(),
  constraint approved_retention_execution check (
    execution_enabled = false or approval_status in ('approved_engineering', 'approved_legal')
  )
);

insert into saferide.policy_documents (
  document_type, version, locale, content_sha256, effective_date, review_status, acceptance_enabled
) values
  ('privacy-policy', '2026-07-draft.1', 'en', 'a963d39da588baa5f440804a40033fbf600ce0d9dbda3243bed89105f6c4f335', null, 'pending_legal', false),
  ('terms', '2026-07-draft.1', 'en', '337247e83deae0aeb47c888e72ffe59f126956e49492cb812b0af2a6dda6b1a4', null, 'pending_legal', false)
on conflict (document_type, version, locale) do update
set content_sha256 = excluded.content_sha256,
    effective_date = excluded.effective_date,
    review_status = excluded.review_status,
    acceptance_enabled = excluded.acceptance_enabled;

insert into saferide.retention_policies (
  policy_id, scope, duration_days, approval_status, execution_enabled, policy_version
) values
  ('local-manual-v1', 'local', null, 'approved_engineering', true, 'privacy-controls.2026-07-30.1'),
  ('local-30-days-v1', 'local', 30, 'pending_legal', false, 'privacy-controls.2026-07-30.1'),
  ('local-90-days-v1', 'local', 90, 'pending_legal', false, 'privacy-controls.2026-07-30.1'),
  ('submitted-case-pending-legal-v1', 'server', null, 'pending_legal', false, 'privacy-controls.2026-07-30.1')
on conflict (policy_id) do update
set scope = excluded.scope,
    duration_days = excluded.duration_days,
    approval_status = excluded.approval_status,
    execution_enabled = excluded.execution_enabled,
    policy_version = excluded.policy_version;

update saferide.attachments
set retention = '{}'::jsonb,
    retention_policy_id = coalesce(retention_policy_id, 'submitted-case-pending-legal-v1');

alter table saferide.attachments
  alter column retention_policy_id set not null;
alter table saferide.attachments
  drop constraint if exists attachments_retention_policy_fk;
alter table saferide.attachments
  add constraint attachments_retention_policy_fk
  foreign key (retention_policy_id) references saferide.retention_policies(policy_id);
alter table saferide.attachments
  drop constraint if exists attachments_no_arbitrary_retention_check;
alter table saferide.attachments
  add constraint attachments_no_arbitrary_retention_check check (retention = '{}'::jsonb);

create table if not exists saferide.dsar_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  request_type text not null check (request_type in (
    'access', 'export', 'correction', 'restriction', 'objection', 'deletion'
  )),
  status text not null check (status in (
    'requested', 'verified', 'executing', 'completed', 'partially_completed', 'failed', 'legal_hold'
  )),
  request_idempotency_key text not null,
  due_at timestamptz not null,
  sanitized_receipt jsonb,
  evidence_sha256 text check (evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, request_idempotency_key),
  constraint dsar_due_target check (
    due_at >= created_at and due_at <= created_at + interval '30 days'
  ),
  constraint completed_deletion_receipt check (
    request_type <> 'deletion' or status <> 'completed' or
    (sanitized_receipt is not null and evidence_sha256 is not null)
  )
);

create or replace function saferide.enforce_dsar_status_transition()
returns trigger language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if not (
    (old.status = 'requested' and new.status in ('verified', 'failed', 'legal_hold')) or
    (old.status = 'verified' and new.status in ('executing', 'failed', 'legal_hold')) or
    (old.status = 'executing' and new.status in ('completed', 'partially_completed', 'failed', 'legal_hold')) or
    (old.status = 'partially_completed' and new.status in ('executing', 'failed', 'legal_hold')) or
    (old.status = 'failed' and new.status in ('verified', 'legal_hold')) or
    (old.status = 'legal_hold' and new.status = 'verified')
  ) then
    raise exception 'invalid DSAR status transition: % -> %', old.status, new.status;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_dsar_status_transition on saferide.dsar_requests;
create trigger enforce_dsar_status_transition
before update of status on saferide.dsar_requests
for each row execute function saferide.enforce_dsar_status_transition();

create table if not exists saferide.deletion_targets (
  dsar_request_id uuid not null references saferide.dsar_requests on delete cascade,
  target_class text not null check (target_class in (
    'case_rows', 'attachments', 'object_storage', 'chat', 'indexes', 'caches',
    'derived_linkable_records', 'temporary_files', 'abandoned_uploads'
  )),
  status text not null check (status in ('pending', 'deleted', 'not_found', 'failed', 'legal_hold')),
  evidence_sha256 text check (evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz not null default now(),
  primary key (dsar_request_id, target_class)
);

create index if not exists idx_policy_acceptances_owner
  on saferide.policy_acceptances(owner_id, accepted_at desc);
create index if not exists idx_consent_records_owner_purpose
  on saferide.consent_records(owner_id, purpose, created_at desc);
create index if not exists idx_dsar_requests_owner
  on saferide.dsar_requests(owner_id, created_at desc);

drop trigger if exists touch_dsar_requests_updated_at on saferide.dsar_requests;
create trigger touch_dsar_requests_updated_at before update on saferide.dsar_requests
for each row execute function saferide.touch_updated_at();

insert into saferide.schema_migrations (version, name)
values ('004', 'privacy_lifecycle')
on conflict (version) do nothing;

commit;
