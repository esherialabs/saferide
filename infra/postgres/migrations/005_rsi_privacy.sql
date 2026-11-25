begin;

alter table saferide.consent_records
  drop constraint if exists consent_records_purpose_check;
alter table saferide.consent_records
  add constraint consent_records_purpose_check check (purpose in (
    'pathway_submission', 'anonymous_aggregate', 'analytics', 'research',
    'model_training', 'partner_follow_up'
  ));

create table if not exists saferide.corridor_definitions (
  area_id text not null check (area_id ~ '^(cell-[0-9]+-[0-9]+|corridor-[a-z0-9-]+)$'),
  area_type text not null check (area_type in ('coarse_cell', 'corridor')),
  definition_version text not null check (
    length(definition_version) between 1 and 120 and definition_version ~ '^[A-Za-z0-9._:-]+$'
  ),
  definition_sha256 text not null check (definition_sha256 ~ '^[a-f0-9]{64}$'),
  approval_status text not null check (approval_status in ('pending', 'approved', 'expired', 'revoked')),
  triangulation_group text check (
    triangulation_group is null or (length(triangulation_group) between 1 and 120 and triangulation_group ~ '^[a-z0-9-]+$')
  ),
  approved_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (area_id, definition_version),
  constraint corridor_definition_type_matches_id check (
    (area_type = 'coarse_cell' and area_id ~ '^cell-[0-9]+-[0-9]+$') or
    (area_type = 'corridor' and area_id ~ '^corridor-[a-z0-9-]+$')
  ),
  constraint approved_area_window check (
    approval_status <> 'approved' or
    (approved_at is not null and expires_at is not null and expires_at > approved_at)
  )
);

create table if not exists saferide.anonymous_route_signals (
  id uuid primary key default gen_random_uuid(),
  area_id text not null,
  area_type text not null check (area_type in ('coarse_cell', 'corridor')),
  area_definition_version text not null,
  time_bucket timestamptz not null,
  time_bucket_minutes integer not null check (time_bucket_minutes between 30 and 1440),
  category text not null check (length(category) between 1 and 64 and category ~ '^[a-z0-9_]+$'),
  config_version text not null check (length(config_version) between 1 and 120 and config_version ~ '^[A-Za-z0-9._:-]+$'),
  policy_version text not null check (length(policy_version) between 1 and 120 and policy_version ~ '^[A-Za-z0-9._:-]+$'),
  consent_version text not null check (length(consent_version) between 1 and 120 and consent_version ~ '^[A-Za-z0-9._:-]+$'),
  received_at timestamptz not null default now(),
  expires_at timestamptz not null,
  foreign key (area_id, area_definition_version)
    references saferide.corridor_definitions(area_id, definition_version),
  constraint signal_area_type_matches_id check (
    (area_type = 'coarse_cell' and area_id ~ '^cell-[0-9]+-[0-9]+$') or
    (area_type = 'corridor' and area_id ~ '^corridor-[a-z0-9-]+$')
  ),
  constraint signal_fixed_time_bucket check (
    mod(1440, time_bucket_minutes) = 0 and
    mod(extract(epoch from time_bucket)::bigint, time_bucket_minutes::bigint * 60) = 0
  ),
  constraint signal_expiry_after_receipt check (expires_at > received_at)
);

create table if not exists saferide.aggregate_release_windows (
  id uuid primary key default gen_random_uuid(),
  view_id text not null check (view_id = 'rsi-fixed-grid-v1'),
  control_version text not null check (length(control_version) between 1 and 120 and control_version ~ '^[A-Za-z0-9._:-]+$'),
  approval_id text not null check (length(approval_id) between 1 and 180),
  area_definition_version text not null check (
    length(area_definition_version) between 1 and 120 and area_definition_version ~ '^[A-Za-z0-9._:-]+$'
  ),
  window_start timestamptz not null,
  window_end timestamptz not null,
  release_cadence_hours integer not null check (release_cadence_hours > 0),
  adjacent_window_status text not null check (adjacent_window_status in ('initial', 'continuous')),
  minimum_count integer not null check (minimum_count >= 2),
  dp_status text not null check (dp_status in ('not_approved', 'approved')),
  dp_parameters jsonb,
  status text not null check (status in ('draft', 'published', 'revoked')) default 'draft',
  immutable_revision_sha256 text check (immutable_revision_sha256 is null or immutable_revision_sha256 ~ '^[a-f0-9]{64}$'),
  published_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint fixed_release_window check (
    window_end > window_start and
    window_end - window_start = make_interval(hours => release_cadence_hours) and
    mod(extract(epoch from window_start)::bigint, release_cadence_hours::bigint * 3600) = 0
  ),
  constraint published_release_identity check (
    status <> 'published' or (published_at is not null and immutable_revision_sha256 is not null)
  ),
  constraint approved_dp_parameters check (
    (dp_status = 'not_approved' and dp_parameters is null) or
    (
      dp_status = 'approved' and
      jsonb_typeof(dp_parameters) = 'object' and
      (dp_parameters - array['epsilon', 'delta', 'sensitivity', 'clipping', 'composition', 'releaseCadenceHours']) = '{}'::jsonb and
      dp_parameters ?& array['epsilon', 'delta', 'sensitivity', 'clipping', 'composition', 'releaseCadenceHours']
    )
  ),
  unique (view_id, control_version, area_definition_version, window_start, window_end)
);

create table if not exists saferide.rsi_aggregate_cells (
  release_id uuid not null references saferide.aggregate_release_windows(id) on delete cascade,
  area_id text not null,
  time_bucket timestamptz not null,
  category text not null check (length(category) between 1 and 64 and category ~ '^[a-z0-9_]+$'),
  state text not null check (state in ('suppressed', 'released')),
  suppression_reasons text[] not null default '{}',
  raw_count integer not null check (raw_count >= 0),
  previous_raw_count integer check (previous_raw_count is null or previous_raw_count >= 0),
  released_value numeric,
  memoized_noise numeric,
  created_at timestamptz not null default now(),
  primary key (release_id, area_id, time_bucket, category),
  constraint suppressed_cells_have_no_value check (
    (state = 'suppressed' and released_value is null) or
    (
      state = 'released' and released_value is not null and released_value > 0 and
      released_value = trunc(released_value)
    )
  ),
  constraint suppression_reason_state_matches check (
    (state = 'suppressed' and cardinality(suppression_reasons) > 0) or
    (state = 'released' and cardinality(suppression_reasons) = 0)
  ),
  constraint memoized_noise_is_finite check (
    memoized_noise is null or memoized_noise <> 'NaN'::numeric
  )
);

create table if not exists saferide.suppression_decisions (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references saferide.aggregate_release_windows(id) on delete cascade,
  cell_key_sha256 text not null check (cell_key_sha256 ~ '^[a-f0-9]{64}$'),
  reason text not null check (reason in (
    'below_minimum_count', 'adjacent_window_differencing',
    'complementary_area_suppression', 'complementary_category_suppression',
    'complementary_time_suppression', 'corridor_triangulation_suppression'
  )),
  created_at timestamptz not null default now(),
  unique (release_id, cell_key_sha256, reason)
);

create table if not exists saferide.privacy_budget_ledger (
  release_id uuid primary key references saferide.aggregate_release_windows(id) on delete cascade,
  epsilon numeric not null check (epsilon > 0),
  delta numeric not null check (delta > 0 and delta < 1),
  sensitivity numeric not null check (sensitivity > 0),
  clipping numeric not null check (clipping > 0),
  composition text not null check (length(composition) between 1 and 120),
  release_cadence_hours integer not null check (release_cadence_hours > 0),
  noise_seed_commitment_sha256 text not null check (noise_seed_commitment_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);

create table if not exists saferide.operator_access_audit (
  id uuid primary key default gen_random_uuid(),
  actor_fingerprint text not null check (actor_fingerprint ~ '^[a-f0-9]{64}$'),
  request_id text not null check (length(request_id) between 1 and 180),
  action text not null check (action in ('rsi.release.read', 'rsi.release.export')),
  release_id uuid,
  outcome text not null check (outcome in ('success', 'denied', 'failed')),
  policy_version text not null check (length(policy_version) between 1 and 120 and policy_version ~ '^[A-Za-z0-9._:-]+$'),
  created_at timestamptz not null default now()
);

create or replace view saferide.rsi_public_release_cells as
select
  cell.release_id,
  release.view_id,
  release.dp_status,
  release.immutable_revision_sha256,
  cell.area_id,
  cell.time_bucket,
  cell.category,
  cell.state,
  cell.released_value
from saferide.rsi_aggregate_cells cell
join saferide.aggregate_release_windows release on release.id = cell.release_id
where release.status = 'published';

create or replace function saferide.protect_published_rsi_cells()
returns trigger language plpgsql as $$
declare
  release_status text;
  target_release_id uuid;
begin
  target_release_id := case when tg_op = 'DELETE' then old.release_id else new.release_id end;
  select status into release_status
  from saferide.aggregate_release_windows
  where id = target_release_id;
  if release_status in ('published', 'revoked') then
    raise exception 'published or revoked RSI release cells are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists protect_published_rsi_cells on saferide.rsi_aggregate_cells;
create trigger protect_published_rsi_cells
before insert or update or delete on saferide.rsi_aggregate_cells
for each row execute function saferide.protect_published_rsi_cells();

create or replace function saferide.protect_published_rsi_release()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('published', 'revoked') then
      raise exception 'published or revoked RSI releases are immutable';
    end if;
    return old;
  end if;
  if old.status = 'published' and new.status = 'revoked' then
    if new.revoked_at is null or
      (to_jsonb(new) - 'status' - 'revoked_at') <> (to_jsonb(old) - 'status' - 'revoked_at') then
      raise exception 'RSI revocation may change only status and revoked_at';
    end if;
    return new;
  end if;
  if old.status in ('published', 'revoked') then
    raise exception 'published or revoked RSI releases are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_published_rsi_release on saferide.aggregate_release_windows;
create trigger protect_published_rsi_release
before update or delete on saferide.aggregate_release_windows
for each row execute function saferide.protect_published_rsi_release();

create or replace function saferide.enforce_adjacent_rsi_release_window()
returns trigger language plpgsql as $$
begin
  if new.adjacent_window_status = 'initial' then
    if exists (
      select 1 from saferide.aggregate_release_windows prior
      where prior.view_id = new.view_id
        and prior.control_version = new.control_version
        and prior.area_definition_version = new.area_definition_version
    ) then
      raise exception 'initial RSI release must be the first immutable window';
    end if;
  elsif not exists (
    select 1 from saferide.aggregate_release_windows prior
    where prior.view_id = new.view_id
      and prior.control_version = new.control_version
      and prior.area_definition_version = new.area_definition_version
      and prior.window_end = new.window_start
      and prior.status in ('published', 'revoked')
  ) then
    raise exception 'continuous RSI release requires an adjacent immutable predecessor';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_adjacent_rsi_release_window on saferide.aggregate_release_windows;
create trigger enforce_adjacent_rsi_release_window
before insert on saferide.aggregate_release_windows
for each row execute function saferide.enforce_adjacent_rsi_release_window();

create unique index if not exists idx_rsi_single_initial_window
  on saferide.aggregate_release_windows(view_id, control_version, area_definition_version)
  where adjacent_window_status = 'initial';

create or replace function saferide.protect_published_rsi_internal_evidence()
returns trigger language plpgsql as $$
declare
  release_status text;
  target_release_id uuid;
begin
  target_release_id := case when tg_op = 'DELETE' then old.release_id else new.release_id end;
  select status into release_status from saferide.aggregate_release_windows where id = target_release_id;
  if release_status in ('published', 'revoked') then
    raise exception 'published or revoked RSI privacy evidence is immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists protect_published_rsi_suppression on saferide.suppression_decisions;
create trigger protect_published_rsi_suppression
before insert or update or delete on saferide.suppression_decisions
for each row execute function saferide.protect_published_rsi_internal_evidence();

drop trigger if exists protect_published_rsi_budget on saferide.privacy_budget_ledger;
create trigger protect_published_rsi_budget
before insert or update or delete on saferide.privacy_budget_ledger
for each row execute function saferide.protect_published_rsi_internal_evidence();

create or replace function saferide.protect_approved_corridor_definition()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.approval_status in ('approved', 'expired', 'revoked') then
    raise exception 'approved corridor definitions are immutable';
  end if;
  if tg_op = 'UPDATE' and old.approval_status = 'approved' then
    if new.approval_status not in ('expired', 'revoked') or
      (to_jsonb(new) - 'approval_status' - 'expires_at') <>
      (to_jsonb(old) - 'approval_status' - 'expires_at') then
      raise exception 'approved corridor definitions may only expire or be revoked';
    end if;
  elsif tg_op = 'UPDATE' and old.approval_status in ('expired', 'revoked') then
    raise exception 'expired or revoked corridor definitions are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists protect_approved_corridor_definition on saferide.corridor_definitions;
create trigger protect_approved_corridor_definition
before update or delete on saferide.corridor_definitions
for each row execute function saferide.protect_approved_corridor_definition();

create index if not exists idx_anonymous_route_signals_bucket
  on saferide.anonymous_route_signals(time_bucket, area_id, category);
create index if not exists idx_anonymous_route_signals_expiry
  on saferide.anonymous_route_signals(expires_at);
create index if not exists idx_operator_access_audit_created
  on saferide.operator_access_audit(created_at desc);

insert into saferide.schema_migrations (version, name)
values ('005', 'rsi_privacy')
on conflict (version) do nothing;

commit;
