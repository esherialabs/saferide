-- Remove undelivered alerts in the same transaction that ends sharing or
-- acknowledges/closes the case. Already dispatched generic alerts cannot be recalled.
begin;
set local lock_timeout = '5s';
create or replace function saferide.clear_partner_push_jobs_on_referral_change()
returns trigger language plpgsql as $$
begin
  if new.access_revoked_at is not null or new.status <> 'new' then
    delete from saferide.partner_push_jobs where referral_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists clear_partner_push_jobs on saferide.partner_referrals;
create trigger clear_partner_push_jobs after update of access_revoked_at, status on saferide.partner_referrals
for each row execute function saferide.clear_partner_push_jobs_on_referral_change();
insert into saferide.schema_migrations(version,name) values ('019','partner_push_revocation_cleanup') on conflict(version) do nothing;
commit;
