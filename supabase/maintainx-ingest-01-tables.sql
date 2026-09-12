-- maintainx-ingest-01-tables.sql
--
-- Local mirror of MaintainX work orders, work requests and comments, so that
-- splashcarwashes.info serves from Postgres instead of hitting the MaintainX
-- API on every page view.
--
-- Design notes
--   * ONE row per work order, updated in place (mx_work_order). Repeating
--     structures (comments, parts, expenditures, time, attachments, procedure
--     fields) live in child tables so a new comment never rewrites the work
--     order row and never duplicates the work order snapshot.
--   * All money is stored in CENTS as integers, matching the MaintainX API
--     (unitCost 12300 == $123.00, costPerUnit 350 == $3.50).
--   * All durations are stored in SECONDS as integers.
--   * Attachment signed URLs are NEVER persisted -- they expire after 60
--     minutes and MaintainX exposes no fetch-by-attachment-id endpoint. We
--     keep durable metadata plus an optional R2 mirror key.
--   * `raw` jsonb holds the untouched API payload on the parent records so a
--     schema gap never means data loss; re-parsing can backfill new columns.
--
-- Applied out-of-band (Supabase SQL editor / MCP apply_migration), matching
-- the convention of the other scripts in this directory.

begin;

-- ---------------------------------------------------------------------------
-- 1. Work orders: current state, one row each
-- ---------------------------------------------------------------------------

create table if not exists mx_work_order (
  id                        bigint primary key,              -- MaintainX work order id
  sequential_id             bigint,
  organization_id           bigint,

  title                     text,
  description               text,
  work_order_summary        text,

  status                    text,                            -- OPEN | IN_PROGRESS | ON_HOLD | DONE | CANCELED | SKIPPED
  part_status               text,                            -- e.g. ISSUED
  priority                  text,                            -- NONE | LOW | MEDIUM | HIGH
  type                      text,                            -- REACTIVE | PREVENTIVE | ...

  -- Location: mx_location_id is authoritative; the other two are resolved at
  -- sync time for reporting joins and may be null when the mapping is missing.
  mx_location_id            bigint,
  location_id               bigint references locations (id),
  site_number               integer,

  asset_id                  bigint,
  parent_id                 bigint,
  next_id                   bigint,
  previous_id               bigint,
  is_parent                 boolean not null default false,

  creator_id                bigint,
  completer_id              bigint,
  requester_id              bigint,                          -- non-null => originated from a work request
  customer_id               bigint,

  assignee_ids              bigint[] not null default '{}',
  team_ids                  bigint[] not null default '{}',
  vendor_ids                bigint[] not null default '{}',
  categories                jsonb    not null default '[]'::jsonb,

  estimated_time_seconds    integer,
  due_date                  timestamptz,
  due_date_is_full_day      boolean,
  start_date                timestamptz,
  completed_at              timestamptz,

  mx_created_at             timestamptz,
  mx_updated_at             timestamptz,                     -- NOTE: MaintainX excludes comment activity from this
  deleted_at                timestamptz,
  last_message_sent_at      timestamptz,                     -- comment watermark; updatedAt does NOT move on comments

  procedure_id              bigint,
  procedure_title           text,
  thumbnail_attachment_id   bigint,

  progress                  jsonb,
  extra_fields              jsonb not null default '{}'::jsonb,
  external_data             jsonb not null default '{}'::jsonb,

  -- Rollups recomputed on each sync so list views never aggregate children.
  part_cost_cents           bigint  not null default 0,
  expenditure_cents         bigint  not null default 0,
  labor_seconds             bigint  not null default 0,
  labor_cost_cents          bigint  not null default 0,
  total_cost_cents          bigint  not null default 0,
  comment_count             integer not null default 0,
  attachment_count          integer not null default 0,

  raw                       jsonb,
  first_seen_at             timestamptz not null default now(),
  synced_at                 timestamptz not null default now()
);

create index if not exists mx_work_order_status_idx        on mx_work_order (status);
create index if not exists mx_work_order_location_idx      on mx_work_order (mx_location_id);
create index if not exists mx_work_order_site_idx          on mx_work_order (site_number);
create index if not exists mx_work_order_updated_idx       on mx_work_order (mx_updated_at desc);
create index if not exists mx_work_order_completed_idx     on mx_work_order (completed_at desc);
create index if not exists mx_work_order_requester_idx     on mx_work_order (requester_id) where requester_id is not null;
create index if not exists mx_work_order_type_idx          on mx_work_order (type);
create index if not exists mx_work_order_last_message_idx  on mx_work_order (last_message_sent_at desc nulls last);
create index if not exists mx_work_order_live_idx          on mx_work_order (mx_location_id, status) where deleted_at is null;

comment on column mx_work_order.mx_updated_at is
  'MaintainX updatedAt. Does NOT advance when a comment is added -- use last_message_sent_at for comment sync.';
comment on column mx_work_order.requester_id is
  'Set when the work order came from a work request. Join mx_work_request on work_order_id for the requester contact info.';


-- ---------------------------------------------------------------------------
-- 2. Comments: immutable, stable ids, one row each
-- ---------------------------------------------------------------------------

create table if not exists mx_work_order_comment (
  id              bigint primary key,                        -- MaintainX comment id
  work_order_id   bigint not null references mx_work_order (id) on delete cascade,
  author_id       bigint,
  content         text,
  mx_created_at   timestamptz,
  synced_at       timestamptz not null default now()
);

create index if not exists mx_work_order_comment_wo_idx
  on mx_work_order_comment (work_order_id, mx_created_at);
create index if not exists mx_work_order_comment_author_idx
  on mx_work_order_comment (author_id, mx_created_at desc);

comment on table mx_work_order_comment is
  'MaintainX comments carry id/authorId/content/createdAt only -- there is no updatedAt and no attachments. Upsert on id is idempotent.';


-- ---------------------------------------------------------------------------
-- 3. Parts consumed on a work order
-- ---------------------------------------------------------------------------

create table if not exists mx_work_order_part (
  work_order_id       bigint  not null references mx_work_order (id) on delete cascade,
  part_id             bigint  not null,
  ordinal             integer not null,

  name                text,
  description         text,
  area                text,
  barcode             text,
  copy_on_recurring   text,

  quantity_used       numeric(14, 4) not null default 0,
  unit_cost_cents     bigint         not null default 0,
  line_total_cents    bigint generated always as
                        ((round(quantity_used * unit_cost_cents))::bigint) stored,

  available_quantity  numeric(14, 4),
  minimum_quantity    numeric(14, 4),
  part_location_id    bigint,
  part_extra_fields   jsonb not null default '{}'::jsonb,

  synced_at           timestamptz not null default now(),
  primary key (work_order_id, part_id)
);

create index if not exists mx_work_order_part_part_idx on mx_work_order_part (part_id);


-- ---------------------------------------------------------------------------
-- 4. Expenditures
--
-- MaintainX returns expenditures with NO id, so these are written
-- delete-and-replace per work order. `ordinal` keys the mirror; `dedupe_key`
-- is what the expense-posting flow keys on, because ordinals shift when
-- somebody deletes an earlier line. dedupe_key is stable across reordering
-- and distinguishes genuinely duplicated identical lines via `occurrence`.
-- ---------------------------------------------------------------------------

create table if not exists mx_work_order_expenditure (
  work_order_id       bigint  not null references mx_work_order (id) on delete cascade,
  ordinal             integer not null,

  dedupe_key          text    not null,
  occurrence          integer not null default 0,            -- nth identical line within this work order

  type                text,                                  -- EXPENSE | ...
  description         text,
  user_id             bigint,
  quantity            numeric(14, 4) not null default 1,
  cost_per_unit_cents bigint         not null default 0,
  row_total_cents     bigint         not null default 0,

  -- MaintainX stamps no date on an expenditure, so the business date for
  -- expense posting is the date the line first appeared on the work order.
  first_seen_at       timestamptz not null default now(),
  synced_at           timestamptz not null default now(),
  primary key (work_order_id, ordinal)
);

create unique index if not exists mx_work_order_expenditure_dedupe_idx
  on mx_work_order_expenditure (work_order_id, dedupe_key);

comment on column mx_work_order_expenditure.dedupe_key is
  'Stable hash of (type, description, user_id, quantity, cost_per_unit_cents, row_total_cents, occurrence). Survives reordering; used as the idempotency key when posting to expense_entry.';


-- ---------------------------------------------------------------------------
-- 5. Time items (also no id from the API -- same delete-and-replace pattern)
-- ---------------------------------------------------------------------------

create table if not exists mx_work_order_time_item (
  work_order_id           bigint  not null references mx_work_order (id) on delete cascade,
  ordinal                 integer not null,

  type                    text,                              -- TIME | ...
  user_id                 bigint,
  quantity_hours          numeric(14, 4) not null default 0,
  duration_total_seconds  bigint         not null default 0,

  first_seen_at           timestamptz not null default now(),
  synced_at               timestamptz not null default now(),
  primary key (work_order_id, ordinal)
);

create index if not exists mx_work_order_time_item_user_idx
  on mx_work_order_time_item (user_id);

comment on table mx_work_order_time_item is
  'Sourced from the timeItems expand. The times expand appears to return the same array -- verify against production before dropping one.';


-- ---------------------------------------------------------------------------
-- 6. Attachments
--
-- Signed S3 URLs live 60 minutes and there is no GET-attachment-by-id route,
-- so URLs are deliberately absent here. Either re-fetch GET /workorders/{id}
-- for a fresh URL, or serve from the R2 mirror.
-- ---------------------------------------------------------------------------

create table if not exists mx_work_order_attachment (
  id             bigint primary key,                         -- MaintainX attachment id
  work_order_id  bigint not null references mx_work_order (id) on delete cascade,

  file_name      text,
  mime_type      text,
  width          integer,
  height         integer,
  is_thumbnail   boolean not null default false,
  mx_created_at  timestamptz,

  r2_key         text,
  r2_bytes       bigint,
  mirrored_at    timestamptz,
  mirror_error   text,
  mirror_attempts integer not null default 0,

  synced_at      timestamptz not null default now()
);

create index if not exists mx_work_order_attachment_wo_idx
  on mx_work_order_attachment (work_order_id);
create index if not exists mx_work_order_attachment_pending_idx
  on mx_work_order_attachment (mirror_attempts, mx_created_at)
  where r2_key is null;


-- ---------------------------------------------------------------------------
-- 7. Procedure fields (checklist answers) -- queryable rather than buried jsonb
-- ---------------------------------------------------------------------------

create table if not exists mx_work_order_procedure_field (
  id                          bigint primary key,            -- MaintainX field instance id
  work_order_id               bigint not null references mx_work_order (id) on delete cascade,
  procedure_id                bigint,
  parent_field_id             bigint,
  procedure_template_id       bigint,
  procedure_template_field_id bigint,

  ordinal                     integer,
  required                    boolean not null default false,
  type                        text,                          -- CHECKLIST | TEXT | FILE | UNSUPPORTED | ...
  label                       text,
  description                 text,
  value_text                  text,
  has_attachments             boolean not null default false,
  value                       jsonb,

  synced_at                   timestamptz not null default now()
);

create index if not exists mx_work_order_procedure_field_wo_idx
  on mx_work_order_procedure_field (work_order_id, ordinal);
create index if not exists mx_work_order_procedure_field_template_idx
  on mx_work_order_procedure_field (procedure_template_field_id);


-- ---------------------------------------------------------------------------
-- 8. Work requests
--
-- Separate resource with its own lifecycle. GET /workrequests has NO
-- updatedAt filter and no sort, so this table is refreshed by full re-page
-- plus webhook-driven single fetches.
-- ---------------------------------------------------------------------------

create table if not exists mx_work_request (
  id                     bigint primary key,
  work_order_id          bigint references mx_work_order (id) on delete set null,

  request_status         text,                               -- PENDING | REJECTED | APPROVED | DONE
  title                  text,
  description            text,
  priority               text,

  mx_location_id         bigint,
  location_id            bigint references locations (id),
  site_number            integer,
  asset_id               bigint,

  creator_id             bigint,
  creator_contact_type   text,                               -- PHONE | EMAIL | OTHER
  creator_contact_value  text,
  requester_email        text,                               -- normalised lower(creator_contact_value) when type = EMAIL
  approver_team_id       bigint,

  mx_created_at          timestamptz,
  mx_updated_at          timestamptz,

  extra_fields           jsonb not null default '{}'::jsonb,
  raw                    jsonb,
  first_seen_at          timestamptz not null default now(),
  synced_at              timestamptz not null default now()
);

create index if not exists mx_work_request_wo_idx        on mx_work_request (work_order_id);
create index if not exists mx_work_request_status_idx    on mx_work_request (request_status);
create index if not exists mx_work_request_email_idx     on mx_work_request (requester_email);
create index if not exists mx_work_request_location_idx  on mx_work_request (mx_location_id);


-- ---------------------------------------------------------------------------
-- 9. Event log (append-only). Records changes OBSERVED after ingest begins --
--    there is no retroactive history available from the API.
-- ---------------------------------------------------------------------------

create table if not exists mx_work_order_event (
  id             bigserial primary key,
  work_order_id  bigint not null,
  event_type     text   not null,                            -- CREATED | STATUS_CHANGE | COST_CHANGE | ASSIGNEE_CHANGE | COMMENT | DELETED
  source         text   not null default 'SWEEP',            -- WEBHOOK | SWEEP | BACKFILL
  occurred_at    timestamptz,                                -- webhook occurredAt when known
  observed_at    timestamptz not null default now(),
  old_value      jsonb,
  new_value      jsonb
);

create index if not exists mx_work_order_event_wo_idx
  on mx_work_order_event (work_order_id, observed_at desc);
create index if not exists mx_work_order_event_type_idx
  on mx_work_order_event (event_type, observed_at desc);


-- ---------------------------------------------------------------------------
-- 10. Sync state: watermarks and cursors, one row per sync stream
-- ---------------------------------------------------------------------------

create table if not exists mx_sync_state (
  key             text primary key,                          -- work_orders_updated_at | work_orders_comments | work_requests_full | users_full | ...
  watermark       timestamptz,
  cursor          text,                                      -- set mid-run when a backfill is chunked across invocations
  last_run_at     timestamptz,
  last_success_at timestamptz,
  last_status     text,                                      -- OK | PARTIAL | ERROR
  last_error      text,
  stats           jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- 11. Inbound webhook log
--
-- The webhook route must ack within MaintainX's 10 second timeout, so it
-- verifies the HMAC signature, writes the row, and returns 200. Processing
-- (re-fetch the entity, upsert) happens on the cron drain. This table is also
-- the replay log when a processing bug needs re-running.
-- ---------------------------------------------------------------------------

create table if not exists mx_webhook_event (
  id                  uuid primary key default gen_random_uuid(),
  event_type          text not null,
  entity_kind         text,                                  -- WORK_ORDER | WORK_REQUEST | COMMENT | OTHER
  entity_id           bigint,
  occurred_at         timestamptz,
  received_at         timestamptz not null default now(),
  signature_verified  boolean not null default false,
  payload             jsonb not null,
  processed_at        timestamptz,
  process_error       text,
  attempts            integer not null default 0
);

create index if not exists mx_webhook_event_pending_idx
  on mx_webhook_event (received_at)
  where processed_at is null;
create index if not exists mx_webhook_event_entity_idx
  on mx_webhook_event (entity_kind, entity_id, received_at desc);


-- ---------------------------------------------------------------------------
-- 12. Expense posting queue
--
-- One row per MaintainX expenditure that is a candidate for expense_entry.
-- Starts life as PENDING for human review; flipping to auto-post later is a
-- behaviour change in the worker, not a schema change.
--
-- expense_entry rows are only ever created through insert_expense_entry(),
-- because the PO number is minted inside that transaction by next_expense_po().
-- ---------------------------------------------------------------------------

create table if not exists mx_expense_posting (
  id                     uuid primary key default gen_random_uuid(),
  work_order_id          bigint not null references mx_work_order (id) on delete cascade,
  expenditure_dedupe_key text   not null,

  status                 text   not null default 'PENDING',  -- PENDING | POSTED | SKIPPED | FAILED

  proposed_site_number   integer,
  proposed_location_code text,
  proposed_business_date date,
  proposed_category_key  text,
  proposed_amount_cents  bigint,
  proposed_description   text,

  expense_entry_id       uuid references expense_entry (id),
  posted_at              timestamptz,
  post_error             text,

  reviewed_at            timestamptz,
  reviewed_by            uuid,
  reviewed_by_email      text,
  skip_reason            text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  unique (work_order_id, expenditure_dedupe_key)
);

create index if not exists mx_expense_posting_status_idx
  on mx_expense_posting (status, created_at);
create index if not exists mx_expense_posting_entry_idx
  on mx_expense_posting (expense_entry_id)
  where expense_entry_id is not null;


-- ---------------------------------------------------------------------------
-- 13. Cost email log
--
-- The email itself rides the existing outbound_emails queue via
-- enqueueOutboundEmail (dedupes on source_id). This table records what the
-- cost WAS at send time, so a later cost change is visibly a change.
-- ---------------------------------------------------------------------------

create table if not exists mx_cost_email (
  id                 uuid primary key default gen_random_uuid(),
  work_order_id      bigint not null references mx_work_order (id) on delete cascade,
  recipient          text   not null,
  outbound_email_id  uuid,
  total_cost_cents   bigint not null default 0,
  part_cost_cents    bigint not null default 0,
  expenditure_cents  bigint not null default 0,
  labor_cost_cents   bigint not null default 0,
  sent_at            timestamptz not null default now(),
  sent_by            uuid,
  sent_by_email      text,
  trigger            text not null default 'MANUAL'          -- MANUAL | AUTO_ON_COMPLETE | DIGEST
);

create index if not exists mx_cost_email_wo_idx
  on mx_cost_email (work_order_id, sent_at desc);
create index if not exists mx_cost_email_recipient_idx
  on mx_cost_email (recipient, sent_at desc);


-- ---------------------------------------------------------------------------
-- RLS: enabled with no policies. The service role bypasses RLS; the anon key
-- gets nothing. All access goes through workers holding SUPABASE_SERVICE_KEY,
-- matching how the rest of this schema is reached.
-- ---------------------------------------------------------------------------

alter table mx_work_order                 enable row level security;
alter table mx_work_order_comment         enable row level security;
alter table mx_work_order_part            enable row level security;
alter table mx_work_order_expenditure     enable row level security;
alter table mx_work_order_time_item       enable row level security;
alter table mx_work_order_attachment      enable row level security;
alter table mx_work_order_procedure_field enable row level security;
alter table mx_work_request               enable row level security;
alter table mx_work_order_event           enable row level security;
alter table mx_sync_state                 enable row level security;
alter table mx_webhook_event              enable row level security;
alter table mx_expense_posting            enable row level security;
alter table mx_cost_email                 enable row level security;

commit;
