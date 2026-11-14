-- Partner dashboard: tell the survivor when a partner's access to their
-- report ends, whoever ended it, and keep org stable ids unambiguous.
--
-- 1. When a referral's access is revoked (the survivor withdrew
--    partner_follow_up, or an operator ran `partnerAdmin referral:revoke`),
--    one trigger now does what the operator command did in app code (010):
--    the survivor's case returns to `submitted` (a closed case stays closed)
--    and gets one status_change event in the existing shape plus
--    `partner_access: 'ended'`, so the app can say "No longer shared with
--    HURIA". actor is 'survivor' for a withdrawal and 'saferide' for an
--    operator revocation. The payload never carries a reason code, an
--    operator or a note. request_id is the transaction's
--    `saferide.request_id` setting when the caller sets one (the operator
--    CLI does), otherwise null; survivors never see it either way.
--    Before this, a withdrawal left the case status and timeline unchanged.
-- 2. Org stable ids can no longer look like a UUID, so `--org` (stable id
--    or id) in the operator CLI can never match two orgs. NOT VALID like
--    008's closure-reason check: new and changed rows are checked, while a
--    pre-existing UUID-shaped stable id cannot block the migration. Run
--    `alter table saferide.partner_organizations validate constraint
--    partner_org_stable_id_not_uuid;` to confirm there is none.
-- No grant changes: the runtime role already updates cases and inserts
-- case_events (partner status changes), and the trigger runs as the caller.
-- 009 stays reserved for the evidence-derivatives change; this file does
-- not depend on it.
--
-- Apply like 007 (backup first; one transaction with lock_timeout 5s;
-- re-applying is a no-op).
-- Rollback (survivor events already written stay; they are history):
--   begin;
--   drop trigger if exists record_partner_access_ended on saferide.partner_referrals;
--   drop function if exists saferide.record_partner_access_ended();
--   alter table saferide.partner_organizations drop constraint if exists partner_org_stable_id_not_uuid;
--   delete from saferide.schema_migrations where version = '011';
--   commit;
-- Rolling back the trigger while the 011 API runs would leave operator
-- revocations without a survivor event; roll the API back with it.
begin;
set local lock_timeout = '5s';

create or replace function saferide.record_partner_access_ended()
returns trigger language plpgsql as $$
declare
  survivor_status text;
  partner_stable_id text;
begin
  if new.access_revoked_at is not null and old.access_revoked_at is null then
    update saferide.cases
    set status = case when status = 'closed' then status else 'submitted'::saferide.case_status end
    where id = new.case_id and owner_id = new.owner_id
    returning status::text into survivor_status;
    if survivor_status is null then
      return new;
    end if;
    select org.stable_id into partner_stable_id
    from saferide.partner_organizations org where org.id = new.org_id;
    insert into saferide.case_events (case_id, owner_id, event_type, payload, request_id)
    values (
      new.case_id,
      new.owner_id,
      'status_change',
      jsonb_build_object(
        'schemaVersion', '1.0',
        'new_status', survivor_status,
        'actor', case when new.revoke_reason = 'operator' then 'saferide' else 'survivor' end,
        'partner', partner_stable_id,
        'partner_status', new.status,
        'partner_access', 'ended'
      ),
      nullif(current_setting('saferide.request_id', true), '')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists record_partner_access_ended on saferide.partner_referrals;
create trigger record_partner_access_ended
after update of access_revoked_at on saferide.partner_referrals
for each row execute function saferide.record_partner_access_ended();

alter table saferide.partner_organizations
  drop constraint if exists partner_org_stable_id_not_uuid;
alter table saferide.partner_organizations
  add constraint partner_org_stable_id_not_uuid check (
    stable_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) not valid;

insert into saferide.schema_migrations (version, name)
values ('011', 'partner_access_ended_event')
on conflict (version) do nothing;

commit;
