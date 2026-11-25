-- Partner sign-in: revocable known-device cookies.
--
-- The API marks a browser that completed a full partner sign-in with a
-- signed known-device cookie, used only for priority in the sign-in gate
-- (apps/api/src/services/partnerKnownDevice.ts). The cookie names the user
-- and this per-user epoch; the API honours it only while the epoch still
-- matches. `partnerAdmin user:disable`, `user:reset` and `sessions:revoke`
-- bump the epoch, which revokes every known-device cookie of that user (or
-- of every user in the org for `sessions:revoke --org`).
-- No grant changes: the runtime role already updates partner_users.
--
-- Apply like 007 (backup first; one transaction with lock_timeout 5s;
-- re-applying is a no-op). Adding a column with a constant default is a
-- metadata-only change in PostgreSQL 11+.
-- Rollback (roll the 012 API back with it; it reads the column):
--   begin;
--   alter table saferide.partner_users drop column if exists known_device_epoch;
--   delete from saferide.schema_migrations where version = '012';
--   commit;
begin;
set local lock_timeout = '5s';

alter table saferide.partner_users
  add column if not exists known_device_epoch integer not null default 0;

insert into saferide.schema_migrations (version, name)
values ('012', 'partner_known_device_epoch')
on conflict (version) do nothing;

commit;
