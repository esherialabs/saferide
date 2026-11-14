-- Evidence derivatives: one metadata-stripped copy per released attachment,
-- written by jobs/evidenceDerivativeJob.ts under its own key prefix
-- (evidence-derivatives/), so partners can be served a copy without EXIF
-- GPS, device make/model or serial numbers. The original is never changed.
--
-- A derivative records its object key, sha256, status, the stripping method
-- and the categories removed (names only, never values). Only `ready` rows
-- are shareable, and only while the attachment is still released with the
-- same sha256 (services/evidenceDerivatives.ts getShareableDerivative).
-- `unsupported` and `failed` are terminal for that file: fail closed.
--
-- Retention: a derivative carries its attachment's retention policy (a
-- composite foreign key that follows any change to it) and is deleted with
-- the attachment. Deleting a derivative row queues its object key in
-- evidence_derivative_object_purges, which the job drains, so the stored
-- copy never outlives the evidence it came from.
--
-- Numbering: 008 is the partner P3 migration (#294). This file does not
-- depend on 008 and applies before or after it.
--
-- New volumes apply this automatically (initdb), then runtime-role.sql.
-- On an EXISTING volume, take a backup first (`saferide.sh backup`), then:
--   docker compose -p "$SAFERIDE_PROJECT" exec -T postgres \
--     psql -X -v ON_ERROR_STOP=1 -U postgres -d saferide \
--     < infra/postgres/migrations/009_evidence_derivatives.sql
-- One transaction with lock_timeout 5s; re-applying is a no-op. It also
-- sets the runtime role's privileges, so runtime-role.sql need not re-run.
--
-- Rollback (derivative objects in storage are left behind; delete the
-- evidence-derivatives/ prefix separately if it must go):
--   begin;
--   drop table if exists saferide.evidence_derivatives, saferide.evidence_derivative_object_purges;
--   drop function if exists saferide.enforce_evidence_derivative_source(),
--     saferide.queue_evidence_derivative_object_purge();
--   drop index if exists saferide.attachments_id_retention_unique;
--   delete from saferide.schema_migrations where version = '009';
--   commit;
begin;
set local lock_timeout = '5s';

-- Lets a derivative prove it carries its attachment's retention policy.
create unique index if not exists attachments_id_retention_unique
  on saferide.attachments(id, retention_policy_id);

create table if not exists saferide.evidence_derivatives (
  id uuid primary key default gen_random_uuid(),
  attachment_id uuid not null unique,
  retention_policy_id text not null,
  bucket text not null check (length(bucket) between 1 and 255),
  -- Allocated when first claimed and kept for retries, so a retry overwrites
  -- the same object and deletion always knows the key.
  object_key text not null unique check (
    object_key ~ '^evidence-derivatives/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  -- The attachment sha256 the derivative was made from.
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('processing', 'ready', 'unsupported', 'failed')),
  source_format text check (source_format is null or source_format in (
    'jpeg', 'png', 'isobmff', 'mp3', 'wav', 'heif', 'pdf', 'gif', 'webp', 'unknown'
  )),
  method text check (method is null or method in (
    'jpeg-segment-allowlist.v1', 'png-chunk-allowlist.v1', 'isobmff-neutralize.v1',
    'mp3-frame-extract.v1', 'wav-chunk-allowlist.v1'
  )),
  mime_type text check (mime_type is null or mime_type in (
    'image/jpeg', 'image/png', 'video/mp4', 'video/quicktime', 'video/3gpp',
    'audio/mp4', 'audio/3gpp', 'audio/mpeg', 'audio/wav'
  )),
  derivative_sha256 text check (derivative_sha256 is null or derivative_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint check (size_bytes is null or size_bytes > 0),
  removed_categories text[] not null default '{}' check (removed_categories <@ array[
    'exif', 'gps_location', 'device_make_model', 'device_serial', 'capture_timestamps', 'software',
    'maker_notes', 'xmp', 'iptc', 'comments', 'text_metadata', 'icc_profile', 'thumbnails',
    'secondary_images', 'trailing_data', 'vendor_metadata', 'container_metadata',
    'timed_metadata_tracks', 'unreferenced_media_data', 'free_space', 'id3_tags', 'ape_tags',
    'riff_info', 'broadcast_wave'
  ]::text[]),
  outcome_reason text check (outcome_reason is null or outcome_reason in (
    'unsupported_format', 'unsupported_variant',
    'type_mismatch', 'parse_error', 'validation_failed',
    'source_unavailable', 'source_mismatch', 'too_large', 'storage_error', 'processing_timeout',
    'resource_limit'
  )),
  attempts integer not null default 1 check (attempts between 1 and 100),
  claim_token uuid,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (attachment_id, retention_policy_id)
    references saferide.attachments(id, retention_policy_id)
    on delete cascade on update cascade,
  constraint evidence_derivative_state check (
    (
      status = 'processing' and claim_token is not null and claimed_at is not null and
      derivative_sha256 is null and completed_at is null and outcome_reason is null
    ) or (
      status = 'ready' and claim_token is null and completed_at is not null and outcome_reason is null and
      derivative_sha256 is not null and size_bytes is not null and method is not null and
      mime_type is not null and source_format is not null
    ) or (
      status = 'unsupported' and claim_token is null and completed_at is not null and
      derivative_sha256 is null and method is null and
      outcome_reason in ('unsupported_format', 'unsupported_variant')
    ) or (
      status = 'failed' and claim_token is null and completed_at is not null and
      derivative_sha256 is null and
      outcome_reason in (
        'type_mismatch', 'parse_error', 'validation_failed',
        'source_unavailable', 'source_mismatch', 'too_large', 'storage_error', 'processing_timeout',
        'resource_limit'
      )
    )
  )
);

-- Derivatives come only from released evidence, and a row's identity never
-- moves. The release is re-checked whenever a row is created, becomes
-- ready, or is pointed at a different source hash; a cascaded retention
-- change alone does not re-check it.
create or replace function saferide.enforce_evidence_derivative_source()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (
    new.attachment_id <> old.attachment_id or new.object_key <> old.object_key or
    new.bucket <> old.bucket or new.created_at <> old.created_at
  ) then
    raise exception 'evidence derivative identity is immutable';
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status or
    new.source_sha256 is distinct from old.source_sha256 then
    if new.status in ('processing', 'ready') and not exists (
      select 1 from saferide.attachments attachment
      where attachment.id = new.attachment_id
        and attachment.status = 'uploaded'
        and attachment.antivirus_status = 'clean'
        and attachment.quarantine_status = 'released'
        and lower(attachment.sha256) = new.source_sha256
    ) then
      raise exception 'evidence derivative source is not released evidence';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_evidence_derivative_source on saferide.evidence_derivatives;
create trigger enforce_evidence_derivative_source
before insert or update on saferide.evidence_derivatives
for each row execute function saferide.enforce_evidence_derivative_source();

drop trigger if exists touch_evidence_derivatives_updated_at on saferide.evidence_derivatives;
create trigger touch_evidence_derivatives_updated_at before update on saferide.evidence_derivatives
for each row execute function saferide.touch_updated_at();

-- Object keys whose derivative row is gone (attachment deleted, case
-- deleted, retention). The job deletes each object, then the queue row.
create table if not exists saferide.evidence_derivative_object_purges (
  object_key text primary key check (object_key ~ '^evidence-derivatives/'),
  bucket text not null check (length(bucket) between 1 and 255),
  queued_at timestamptz not null default now()
);

-- SECURITY DEFINER so the queue row is written whoever deletes the
-- derivative (directly or through a cascade); the runtime role itself
-- cannot insert into the queue.
create or replace function saferide.queue_evidence_derivative_object_purge()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  insert into saferide.evidence_derivative_object_purges (object_key, bucket)
  values (old.object_key, old.bucket)
  on conflict (object_key) do nothing;
  return old;
end;
$$;

drop trigger if exists queue_evidence_derivative_object_purge on saferide.evidence_derivatives;
create trigger queue_evidence_derivative_object_purge
after delete on saferide.evidence_derivatives
for each row execute function saferide.queue_evidence_derivative_object_purge();

create index if not exists idx_evidence_derivatives_status
  on saferide.evidence_derivatives(status, claimed_at);

-- Runtime role: derivatives are created and updated by the job, never
-- deleted by it (they go with their attachment); the purge queue is only
-- read and drained. runtime-role.sql repeats this for new volumes.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'saferide_api') then
    grant select, insert, update on saferide.evidence_derivatives to saferide_api;
    revoke delete, truncate on saferide.evidence_derivatives from saferide_api;
    grant select, delete on saferide.evidence_derivative_object_purges to saferide_api;
    revoke insert, update, truncate on saferide.evidence_derivative_object_purges from saferide_api;
  end if;
end;
$$;

insert into saferide.schema_migrations (version, name)
values ('009', 'evidence_derivatives')
on conflict (version) do nothing;

commit;
