-- mx-webhook-subscription-01.sql
--
-- The one table the MaintainX webhook receiver needs that does not already
-- exist. The delivery log is `mx_webhook_event`, created by
-- maintainx-ingest-01-tables.sql section 11; this file deliberately does NOT
-- redefine it.
--
-- Why this table exists at all: MaintainX has no `GET /subscriptions`. The API
-- offers POST /subscriptions, GET/PATCH/DELETE /subscriptions/{id} and
-- GET /subscriptions/{id}/secret -- every one of which needs an id you already
-- know. Nothing can enumerate what we have registered. Without a local record,
-- a subscription created today is invisible infrastructure tomorrow: it keeps
-- delivering, nobody can list it, and the only way to find it is the MaintainX
-- web UI under Settings -> Integrations.
--
-- One row per subscription, and note that one subscription == one event type
-- plus one URL. The create body is a oneOf over 48 single-value event enums,
-- so subscribing to seven events means seven rows here, all sharing a
-- target_url.
--
-- Applied out-of-band (Supabase SQL editor / MCP apply_migration), matching
-- the convention of every other script in this directory.

begin;

create table if not exists mx_webhook_subscription (
  -- MaintainX's subscription id, from the POST /subscriptions 201 body.
  -- Text rather than bigint: the id is opaque and the spec does not promise
  -- it is numeric.
  id                text primary key,

  -- The event enum value, e.g. 'NEW_WORK_ORDER'. Not constrained to a check
  -- list on purpose -- MaintainX has 48 today and adds more; a stale CHECK
  -- would reject a legitimate new subscription at insert time.
  event_type        text not null,

  -- The URL we registered. Recorded because it is the only way to tell a
  -- staging subscription from a production one after the fact.
  target_url        text not null,

  -- `status` from the create response. Observed value: see the 201 schema
  -- ({id, status, secret}); stored verbatim rather than interpreted.
  status            text,

  created_at        timestamptz not null default now(),

  -- Stamped by the webhook route on each verified delivery. This is the
  -- health signal: a subscription whose last_delivery_at has gone quiet while
  -- the cron ingest is still finding changed rows is a subscription MaintainX
  -- has stopped delivering to -- which it does silently, by deleting endpoints
  -- that keep failing.
  last_delivery_at  timestamptz,

  -- Soft delete. DELETE /subscriptions/{id} removes it upstream; keeping the
  -- row preserves the record of what was once registered and why deliveries
  -- for that event stopped.
  archived_at       timestamptz,

  -- Free-text note, e.g. which cutover phase or brief created it.
  note              text
);

-- The receiver looks a subscription up by event type to stamp last_delivery_at.
-- Partial on archived_at is null: an archived row must never win that lookup.
create index if not exists mx_webhook_subscription_event_idx
  on mx_webhook_subscription (event_type)
  where archived_at is null;

-- Service-role only, matching every other mx_* table: RLS on with no policies,
-- so PostgREST refuses anon/authenticated entirely and the worker's
-- SUPABASE_SERVICE_KEY is the only way in.
alter table mx_webhook_subscription enable row level security;

commit;
