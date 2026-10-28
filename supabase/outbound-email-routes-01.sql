-- ============================================================================
-- outbound_email_routes -- choose, per source_kind, WHO delivers queued email.
--
-- APPLIED 2026-10-28 to rewokyofschtvqgxrxwl (operator; verified: new
-- 3-argument claim function, both columns, routes table empty). With the routes
-- table empty, every row still resolves to 'pa' and the Power Automate drain
-- claims exactly what it claims today.
--
-- WHY
--
-- Every email in the monorepo goes through outbound_emails, drained by ONE
-- Power Automate flow ("Splash.info - Forms Mailer"). To try Cloudflare Email
-- Service without moving everything at once, a source_kind can be routed to a
-- different sender. Routing lives in the DATABASE, not in each enqueuing
-- worker, so moving a kind over -- or back -- is one row and no deploy:
--
--   insert into outbound_email_routes (source_kind, transport, from_address)
--   values ('workorders-daily-digest', 'cloudflare', 'notifications@splashcarwashes.info');
--
--   -- roll back: delete the row. Unsent rows of that kind go back to PA on
--   -- its next poll.
--   delete from outbound_email_routes where source_kind = 'workorders-daily-digest';
--
-- The route is read at CLAIM time, not stamped at insert, which is what makes
-- rollback instant for rows already sitting in the queue. A row claimed by one
-- sender and then re-routed is picked up by the other once its 10-minute claim
-- goes stale -- same rule the queue has always used.
--
-- sent_via / provider_message_id record which sender actually delivered each
-- row, so the pilot can be compared against PA from the table itself. NULL
-- sent_via on a sent row means PA sent it before this file existed.
-- ============================================================================

begin;

create table if not exists public.outbound_email_routes (
  source_kind  text        primary key,
  transport    text        not null check (transport in ('pa', 'cloudflare')),
  -- Sender address for transports that need one. PA ignores it (it sends as
  -- whatever mailbox its connection is signed in as).
  from_address text,
  note         text,
  updated_at   timestamptz not null default now()
);

alter table public.outbound_email_routes enable row level security;
grant all privileges on public.outbound_email_routes to service_role;

comment on table public.outbound_email_routes is
  'Per-source_kind delivery choice for outbound_emails. No row = Power Automate. '
  'Read at claim time, so changing a row re-routes unsent mail immediately.';

alter table public.outbound_emails
  add column if not exists sent_via text,
  add column if not exists provider_message_id text;

comment on column public.outbound_emails.sent_via is
  'Who delivered it: pa | cloudflare. NULL on rows sent before 2026-10-28 (all PA).';

-- The old 2-argument function is replaced, not overloaded: two candidates
-- would make PostgREST's RPC resolution ambiguous for the existing PA call.
-- p_transport defaults to 'pa', so that call -- {p_claim_id, p_limit} -- is
-- unchanged.
drop function if exists public.claim_outbound_emails(uuid, integer);

create function public.claim_outbound_emails(
  p_claim_id  uuid,
  p_limit     integer,
  p_transport text default 'pa'
)
returns setof public.outbound_emails
language plpgsql
as $function$
begin
  return query
  update outbound_emails set
    claimed_at = now(),
    claim_id = p_claim_id
  where id in (
    select e.id from outbound_emails e
    left join outbound_email_routes r on r.source_kind = e.source_kind
    where e.sent_at is null
      and e.scheduled_for <= now()
      and e.send_attempts < 5
      and (e.claimed_at is null or e.claimed_at < now() - interval '10 minutes')
      and coalesce(r.transport, 'pa') = p_transport
    order by e.scheduled_for
    limit least(p_limit, 200)
    for update of e skip locked
  )
  returning outbound_emails.*;
end;
$function$;

grant execute on function public.claim_outbound_emails(uuid, integer, text) to service_role;

commit;

-- VERIFY
-- select count(*) from outbound_email_routes;                       -- 0
-- select pg_get_function_identity_arguments('public.claim_outbound_emails'::regproc);
--   -- p_claim_id uuid, p_limit integer, p_transport text
-- PA drain still works: its next run sends as before (watch /admin/email-queue).

-- ROLLBACK
-- begin;
-- drop function if exists public.claim_outbound_emails(uuid, integer, text);
-- create function public.claim_outbound_emails(p_claim_id uuid, p_limit integer)
--   returns setof public.outbound_emails language plpgsql as $f$
-- begin
--   return query update outbound_emails set claimed_at = now(), claim_id = p_claim_id
--   where id in (select id from outbound_emails where sent_at is null
--     and scheduled_for <= now() and send_attempts < 5
--     and (claimed_at is null or claimed_at < now() - interval '10 minutes')
--     order by scheduled_for limit least(p_limit, 200) for update skip locked)
--   returning outbound_emails.*;
-- end; $f$;
-- drop table if exists public.outbound_email_routes;
-- commit;
-- (sent_via / provider_message_id can stay; nothing reads them but the pilot.)
