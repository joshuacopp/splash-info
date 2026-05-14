# Power Automate flow build guide — Brief 127

One flow drains the entire `outbound_emails` queue every five minutes,
regardless of how many workers or forms produce messages. Adding a new
workflow email step, a new form, or even a new worker that writes into
the queue requires zero PA work — the polling flow picks every new
row up automatically.

| Flow | Secret to bind | Trigger |
|------|----------------|---------|
| Splash Outbound Emails | `FORMS_EMAIL_QUEUE_TOKEN` (worker secret) + an Office 365 connector | Recurrence every 5 minutes |

---

## Architecture

```
   Worker  →  outbound_emails  ←  splash-forms claim/confirm  →  PA flow  →  Office 365
  (any one)      (table)            (HTTP endpoints)
```

Workers call `enqueueOutboundEmail(env, ...)` (from
`@splash/db-supabase`) to add a row. PA polls
`POST /forms/internal/api/email-queue/claim` every five minutes, sends
each returned item via the Office 365 Outlook connector, then POSTs the
per-item results back to
`POST /forms/internal/api/email-queue/confirm`.

The claim endpoint:
1. Generates a fresh `claim_id` (UUID).
2. Calls the Supabase function `claim_outbound_emails(claim_id, limit)`
   which uses `FOR UPDATE SKIP LOCKED` to atomically lock + return up
   to `limit` rows (default 50, max 200).
3. For each claimed row, inlines R2-backed attachments — fetches them
   from the appropriate bucket, base64-encodes, and substitutes
   `r2_key` for `base64` so the response is self-contained.
4. Returns `{claim_id, items: [...]}`.

The confirm endpoint:
1. Verifies the `claim_id` matches at least one row.
2. For each `{id, status}` result: `sent` stamps `sent_at = now()`;
   `failed` releases the claim, increments `send_attempts`, and stores
   `last_error`.
3. Returns `{confirmed_sent, confirmed_failed, skipped}`.

Stale claims (>10 min, never confirmed — e.g., PA flow died) automatically
become eligible for re-claim on the next call. `send_attempts >= 5`
rows drop out of the eligible pool naturally (no manual stuck-state
recovery at v1; the admin viewer in Brief 128 surfaces them).

---

## Step 1. Bind the worker secret

The shared-secret token PA uses to authenticate. Generate a fresh
random UUID-style value:

```powershell
pnpm --filter @splash/forms-worker exec wrangler secret put FORMS_EMAIL_QUEUE_TOKEN
```

When prompted, paste the token. Use any opaque random string; UUID v4
is fine. Store the value in PA's connection config (Step 3 below) so
both ends agree.

When the secret is **unbound** the claim/confirm endpoints return 503
and the queue idles safely — workers continue to enqueue rows. Once
the secret is bound and PA flow is running, the queue starts draining.

---

## Step 2. Trigger

- New flow → Scheduled cloud flow → Skip → "Recurrence".
- **Interval**: 5 minutes.
- **Start time**: whenever you build the flow.

---

## Step 3. Claim a batch

Add an action: **HTTP — Invoke an HTTP request**.

- **Method**: POST
- **URI**: `https://staging.splashcarwashes.info/forms/internal/api/email-queue/claim?limit=50`
  (Production cutover: change hostname to `https://splashcarwashes.info`.)
- **Headers**:
  ```
  X-Email-Queue-Token: {{your-token-from-step-1}}
  Content-Type:         application/json
  ```
- **Body**: leave empty (the endpoint reads `limit` from the query
  string; the body is ignored).

Right after this action, add a **Parse JSON** step. Use the following
schema (paste into "Use sample payload to generate schema" with the
sample response below):

```json
{
  "claim_id": "8c4f2b1a-d3e7-4a91-b652-2f9e7d1a8c3b",
  "items": [
    {
      "id": "9b3a8d4f-c2e1-4f87-9a52-1c8f6d2a9e4d",
      "source_worker": "forms",
      "source_kind": "workflow-email-step",
      "source_id": "9b3a8d4f-c2e1-4f87-9a52-1c8f6d2a9e4d:approval",
      "recipient": "rm@splashcarwashes.com",
      "cc": ["site@splashcarwashes.com"],
      "reply_to": null,
      "subject": "New PTO request submission",
      "body_html": null,
      "body_text": "Hi,\n\nA new PTO request submission was received.\n\nEmployee: John Doe\nDates: 2026-06-01 to 2026-06-05\n\nOpen in Splash: https://splashcarwashes.info/admin/forms/.../submissions/...\n\n— Splash team",
      "attachments": [
        {
          "filename": "signature.png",
          "mime": "image/png",
          "size_bytes": 12453,
          "base64": "iVBORw0KGgoAAAA..."
        }
      ],
      "scheduled_for": "2026-05-14T09:30:00.000Z",
      "send_attempts": 0
    }
  ]
}
```

Capture `body('Parse_JSON')?['claim_id']` for use in Step 5.

---

## Step 4. Loop over items and send each

Add a **For each** action looping over `body('Parse_JSON')?['items']`.

Inside the loop, add **Office 365 Outlook — Send an email (V2)**:

- **To**: `items('For_each')?['recipient']`
- **From** (Send as): your shared mailbox (set in connector config).
- **CC**: `join(items('For_each')?['cc'], ';')`
  - Or leave empty if no CC needed.
- **Reply To**: `items('For_each')?['reply_to']`
- **Subject**: `items('For_each')?['subject']`
- **Body**:
  - Prefer `items('For_each')?['body_html']` (set Is HTML to Yes); fall
    back to `items('For_each')?['body_text']` if `body_html` is null.
  - Expression for fallback:
    ```
    if(empty(items('For_each')?['body_html']),
       items('For_each')?['body_text'],
       items('For_each')?['body_html'])
    ```
- **Attachments**: loop over `items('For_each')?['attachments']` (use
  another For-each inside), set:
  - **Attachments Name**: `items('attachments')?['filename']`
  - **Attachments Content**: `dataUriToBinary(concat('data:',
    items('attachments')?['mime'], ';base64,',
    items('attachments')?['base64']))`

Configure the For-each step's "Configure run after" so the result
(success/failure) can be captured.

After each Send email, **Append to array variable** the per-item
result. Initialize the variable before the For-each:

- **Initialize variable** → Name `Results`, Type Array, Value `[]`.

After each Send email, append:

```json
{
  "id": "@{items('For_each')?['id']}",
  "status": "sent"
}
```

OR (on the failure branch via "Configure run after this step"):

```json
{
  "id": "@{items('For_each')?['id']}",
  "status": "failed",
  "error": "@{first(actions('Send_an_email_(V2)')?['outputs']?['body']?['error'])?['message']}"
}
```

(The actual expression for capturing the error depends on the Office
365 connector's failure shape; the gist is: pass back a useful string
the queue's `last_error` column can store.)

---

## Step 5. Confirm the batch

After the For-each completes, add another **HTTP — Invoke an HTTP
request** action:

- **Method**: POST
- **URI**: `https://staging.splashcarwashes.info/forms/internal/api/email-queue/confirm`
- **Headers**:
  ```
  X-Email-Queue-Token: {{your-token-from-step-1}}
  Content-Type:         application/json
  ```
- **Body**:
  ```json
  {
    "claim_id": "@{body('Parse_JSON')?['claim_id']}",
    "results": @{variables('Results')}
  }
  ```

The response contains `{confirmed_sent, confirmed_failed, skipped}` —
useful as an end-of-run telemetry datapoint, not load-bearing.

---

## Step 6. Production flip

Once smoke-tested on staging, duplicate the flow (or change the
hostnames inline) to point at production
`https://splashcarwashes.info/forms/internal/api/email-queue/*`.
The shared token is the same for staging + production unless the
operator rotates it.

---

## Failure modes

- **Claim endpoint returns 503** (`email_queue_token_unbound`). PA flow
  logs and exits cleanly. Workers keep enqueueing rows safely. Once the
  secret is bound, the next 5-minute tick starts draining.
- **Claim endpoint returns 401** (`bad_email_queue_token`). PA's
  connection config has the wrong token. Rotate via wrangler secret
  put and update PA.
- **Send email fails for one row**. PA appends `{status: "failed",
  error}` for that row; the confirm endpoint releases the claim,
  increments `send_attempts`, records `last_error`. The row gets
  re-attempted on the next tick. After 5 failed attempts it drops out
  of the eligible pool (admin viewer in Brief 128 surfaces it for
  manual intervention).
- **Confirm endpoint fails to reach the worker**. Rows stay
  stuck-claimed. The Supabase function's stale-claim recovery (10-
  minute window) automatically reclaims them on the next call — no
  manual intervention.
- **PA flow dies mid-batch**. Same as above: 10-minute stale-claim
  recovery picks up the orphaned rows.

---

## What's NOT in this brief

- Migration of existing per-worker webhook fires (damage Brief 32 /
  101 / 102, fleet Brief 105, workorders, signup, jotform) into the
  queue. Per operator: existing PA flows continue to work; not
  reworking past ones.
- Daily approval digest (Brief 121). That cron is per-recipient
  bulk-summary already; queue migration adds no value.
- Admin email-queue viewer (Brief 128 — drafted separately, queued
  after this brief).

---

## Operator post-deploy verification

1. Bind the worker secret per Step 1.
2. Build the PA flow per Steps 2–5 against staging.
3. From the admin builder, enable a workflow on a test form and add
   one email step pointing at your own email. Publish.
4. Submit the form.
5. In Supabase, `SELECT * FROM outbound_emails WHERE sent_at IS NULL
   ORDER BY created_at DESC LIMIT 5;` — see your row with `recipient`,
   `subject`, `body_text` populated.
6. Wait up to 5 minutes for the PA tick (or manually trigger the flow
   from PA's overview screen).
7. Check `outbound_emails` again — the row's `sent_at` is now
   populated.
8. Check the recipient inbox — the email arrived.
