-- Owner-authorised pilot engineering retention, not legal-document approval.
begin;
set local lock_timeout = '5s';

create table if not exists saferide.privacy_legal_holds (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  case_id uuid,
  authority_ref text not null check (length(authority_ref) between 1 and 180),
  created_at timestamptz not null default now(),
  released_at timestamptz
);
create index if not exists privacy_holds_owner on saferide.privacy_legal_holds(owner_id) where released_at is null;

create table if not exists saferide.privacy_object_purges (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  case_id uuid,
  attachment_id uuid not null,
  bucket text not null,
  object_key text not null,
  object_kind text not null check (object_kind in ('original', 'derivative')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claim_token uuid,
  claim_until timestamptz,
  unique(bucket, object_key)
);
create index if not exists privacy_object_purges_due on saferide.privacy_object_purges(next_attempt_at) where completed_at is null;

create or replace function saferide.privacy_owner_held(who uuid)
returns boolean language sql stable as $$
  select exists(select 1 from saferide.privacy_legal_holds where owner_id = who and released_at is null)
    or exists(select 1 from saferide.dsar_requests where owner_id = who and status = 'legal_hold');
$$;

-- Guard all report-content deletion, including FK cascades. Conservatively
-- keep the owner's content when any case-specific hold is active.
create or replace function saferide.guard_privacy_held_delete()
returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(old.owner_id::text, 3878));
  if saferide.privacy_owner_held(old.owner_id) then raise exception 'privacy_legal_hold'; end if;
  return old;
end;
$$;
do $$ declare t text; begin
  foreach t in array array['cases','drafts','attachments','chat_sessions'] loop
    execute format('drop trigger if exists guard_privacy_held_delete on saferide.%I', t);
    execute format('create trigger guard_privacy_held_delete before delete on saferide.%I for each row execute function saferide.guard_privacy_held_delete()', t);
  end loop;
end $$;

create or replace function saferide.lock_privacy_hold_owner()
returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 3878));
  return new;
end;
$$;
drop trigger if exists lock_privacy_hold_owner on saferide.privacy_legal_holds;
create trigger lock_privacy_hold_owner before insert or update on saferide.privacy_legal_holds for each row execute function saferide.lock_privacy_hold_owner();
drop trigger if exists lock_privacy_dsar_owner on saferide.dsar_requests;
create trigger lock_privacy_dsar_owner before insert or update on saferide.dsar_requests for each row execute function saferide.lock_privacy_hold_owner();

create or replace function saferide.guard_privacy_deletion_write()
returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 3878));
  if exists(select 1 from saferide.dsar_requests where owner_id = new.owner_id and request_type = 'deletion' and status in ('executing','partially_completed')) then
    raise exception 'report_deletion_in_progress';
  end if;
  return new;
end;
$$;
do $$ declare t text; begin
  foreach t in array array['cases','drafts','attachments','chat_sessions','chat_messages','policy_acceptances','consent_records'] loop
    execute format('drop trigger if exists guard_privacy_deletion_write on saferide.%I', t);
    execute format('create trigger guard_privacy_deletion_write before insert or update on saferide.%I for each row execute function saferide.guard_privacy_deletion_write()', t);
  end loop;
end $$;

-- Capture original AND derivative keys before any row/cascade disappears.
-- A failed storage delete leaves a durable, retryable outbox entry.
create or replace function saferide.enqueue_privacy_object_purge()
returns trigger language plpgsql as $$
begin
  insert into saferide.privacy_object_purges(owner_id, case_id, attachment_id, bucket, object_key, object_kind)
    values(old.owner_id, old.case_id, old.id, old.bucket, old.bucket_path, 'original')
    on conflict(bucket, object_key) do update set completed_at = null, created_at = now(), next_attempt_at = now();
  insert into saferide.privacy_object_purges(owner_id, case_id, attachment_id, bucket, object_key, object_kind)
    select old.owner_id, old.case_id, old.id, d.bucket, d.object_key, 'derivative'
    from saferide.evidence_derivatives d where d.attachment_id = old.id
    on conflict(bucket, object_key) do update set completed_at = null, created_at = now(), next_attempt_at = now();
  return old;
end;
$$;
drop trigger if exists enqueue_privacy_object_purge on saferide.attachments;
create trigger enqueue_privacy_object_purge before delete on saferide.attachments for each row execute function saferide.enqueue_privacy_object_purge();

-- New deletions use the held, retryable outbox. Keep the legacy queue only
-- for unlinked pre-migration entries whose attachment no longer exists.
create or replace function saferide.queue_evidence_derivative_object_purge()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare parent_owner uuid; parent_case uuid;
begin
  if exists(select 1 from saferide.privacy_object_purges where bucket = old.bucket and object_key = old.object_key) then return old; end if;
  select owner_id, case_id into parent_owner, parent_case from saferide.attachments where id = old.attachment_id;
  if parent_owner is not null then
    perform pg_advisory_xact_lock(hashtextextended(parent_owner::text,3878));
    if saferide.privacy_owner_held(parent_owner) then raise exception 'privacy_legal_hold'; end if;
    insert into saferide.privacy_object_purges(owner_id,case_id,attachment_id,bucket,object_key,object_kind)
      values(parent_owner,parent_case,old.attachment_id,old.bucket,old.object_key,'derivative') on conflict(bucket,object_key) do nothing;
  else
    insert into saferide.evidence_derivative_object_purges(object_key,bucket) values(old.object_key,old.bucket) on conflict(object_key) do nothing;
  end if;
  return old;
end;
$$;

insert into saferide.retention_policies(policy_id, scope, duration_days, approval_status, execution_enabled, policy_version)
values
 ('submitted-case-pending-legal-v1','server',90,'approved_engineering',true,'privacy-controls.2026-10-22.pilot.1'),
 ('partner-access-after-close-v1','server',90,'approved_engineering',true,'privacy-controls.2026-10-22.pilot.1'),
 ('partner-audit-v1','server',730,'approved_engineering',true,'privacy-controls.2026-10-22.pilot.1')
on conflict(policy_id) do update set duration_days = excluded.duration_days, approval_status = excluded.approval_status,
 execution_enabled = excluded.execution_enabled, policy_version = excluded.policy_version;

-- Runtime cannot delete audit rows freely. This narrow owner function only
-- trims rows beyond the enabled recorded audit policy, in bounded batches.
create or replace function saferide.trim_expired_partner_audit(batch_size integer)
returns integer language plpgsql security definer set search_path = pg_catalog, saferide as $$
declare duration integer; removed integer;
begin
  select duration_days into duration from saferide.retention_policies
    where policy_id = 'partner-audit-v1' and execution_enabled and approval_status in ('approved_engineering','approved_legal');
  if duration is null or duration < 730 then raise exception 'audit_retention_not_approved'; end if;
  delete from saferide.partner_access_audit where id in (
    select audit.id from saferide.partner_access_audit audit where audit.created_at <= now() - make_interval(days => duration)
      and not exists(select 1 from saferide.partner_referrals r where r.id = audit.referral_id and saferide.privacy_owner_held(r.owner_id))
    order by created_at limit greatest(1, least(batch_size, 1000))
  );
  get diagnostics removed = row_count; return removed;
end;
$$;
revoke all on function saferide.trim_expired_partner_audit(integer) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname = 'saferide_api') then
    grant select, insert, update, delete on saferide.privacy_legal_holds, saferide.privacy_object_purges to saferide_api;
    grant execute on function saferide.trim_expired_partner_audit(integer) to saferide_api;
  end if;
end $$;
insert into saferide.schema_migrations(version,name) values('018','pilot_retention_execution') on conflict(version) do nothing;
commit;
