# Power Automate flow build guide — Brief 121

One new flow for the entire forms feature regardless of how many forms
have workflows. The daily 12:00 UTC cron groups every pending approval
by approver email and fires one POST per recipient summarizing all
forms with pending items. PA receives the per-recipient payload and
sends one email per recipient with a deep link to `/admin/approvals`.

Adding a new form with a workflow later requires zero PA work — the
cron picks it up automatically because it queries on
`current_approver_emails`, not on per-form configuration.

| Flow | Secret to bind | Fires on |
|------|----------------|----------|
| Forms Approval Digest | `FORMS_APPROVAL_DIGEST_WEBHOOK_URL` | Daily at 12:00 UTC (7 AM EDT) — one POST per approver email |

---

## Step 1. Trigger

- New flow → Automated cloud flow → Skip → "When a HTTP request is
  received" → Create.
- Method: POST.
- Request Body JSON Schema: click **Use sample payload to generate
  schema**, paste this sample, click Done.

```json
{
  "recipient_email": "rm@splashcarwashes.com",
  "total_pending": 7,
  "by_form": [
    {
      "form_id": "8c4f2b1a-d3e7-4a91-b652-2f9e7d1a8c3b",
      "form_title": "Equipment Repair Request",
      "count": 4,
      "oldest_submitted_at": "2026-05-08T13:42:09.000Z"
    },
    {
      "form_id": "9b3a8d4f-c2e1-4f87-9a52-1c8f6d2a9e4d",
      "form_title": "PTO Request",
      "count": 3,
      "oldest_submitted_at": "2026-05-10T09:15:33.000Z"
    }
  ],
  "dashboard_url": "https://splashcarwashes.info/admin/approvals"
}
```

The `by_form` array is sorted by `count` desc, then alphabetical
`form_title`. Each entry's `oldest_submitted_at` is the earliest
`submitted_at` across all rows in that approver's bucket for that form.

`total_pending` is the sum of every `by_form[*].count` — pre-summed by
the cron so PA doesn't need to compute it.

`dashboard_url` is the production apps/web admin link. Same value
across every fire; the cron hardcodes
`https://splashcarwashes.info/admin/approvals`.

---

## Step 2. Send the email

- Add an action: **Office 365 Outlook — Send an email (V2)**.
- **To**: `recipient_email` (dynamic content).
- **Subject**: `You have @{triggerBody()?['total_pending']} pending
  approval(s) — Splash Forms`
  - Or: `@{triggerBody()?['total_pending']} pending approval(s) for
  you` (your call).
- **Body** (rich text): construct from the payload. Example HTML body:

```html
<p>Hi,</p>
<p>You have <strong>@{triggerBody()?['total_pending']}</strong>
pending approval(s) across @{length(triggerBody()?['by_form'])}
form(s):</p>

<ul>
@{join(
  variables('FormLines'),
  '
'
)}
</ul>

<p><a href="@{triggerBody()?['dashboard_url']}">Open Pending Approvals
dashboard →</a></p>

<p>— Splash Tools</p>
```

Building the `FormLines` variable: before the Send email step, add an
**Apply to each** loop over `triggerBody()?['by_form']`. Inside the
loop, **Initialize variable** (one-time before the loop, type Array,
name `FormLines`, value `[]`), and **Append to array variable**:

```
<li><strong>@{items('Apply_to_each')?['form_title']}</strong> —
@{items('Apply_to_each')?['count']} pending
(oldest from @{formatDateTime(items('Apply_to_each')?['oldest_submitted_at'], 'MMM d')})</li>
```

Alternatively use Power Automate's **Select** action to map the array
to lines and then `join()` — same result with fewer steps.

---

## Step 3. Test

- Save the flow.
- Copy the HTTP POST URL (Power Automate generates one).
- Bind it on the forms-worker:
  ```powershell
  pnpm --filter @splash/forms-worker exec wrangler secret put FORMS_APPROVAL_DIGEST_WEBHOOK_URL
  # Paste the URL when prompted, press Enter.
  ```
- Smoke test: in the Cloudflare dashboard, open `splash-forms` →
  Triggers → find the `0 12 * * *` cron entry → "Send test event"
  (or wait until 12:00 UTC). Verify in the worker logs:
  ```
  [forms.approval-digest] complete {
    rowsScanned: <N>,
    recipientsConsidered: <M>,
    recipientsFired: <M>,
    recipientsSkippedNoUrl: 0,
    recipientsFailed: 0,
    errorCount: 0
  }
  ```
  And in PA's run history, one run per recipient.

---

## Step 4. Empty-state behavior

If no rows in `form_submissions` have non-empty
`current_approver_emails`, the cron logs `rowsScanned: 0` and fires
zero POSTs. PA receives nothing on those days. This is the desired
behavior — no spam emails when nobody has pending approvals.

When a single recipient has zero pending items (impossible given the
worker-side filter, but defensive), the per-recipient POST is also
skipped. The cron's `recipientsConsidered` counter still increments
for every distinct approver email observed, so log volume is
predictable.

---

## Step 5. Future widenings (out of scope for v1)

- **Per-event "you have a new approval" emails** — would require a
  second PA flow + a new webhook on the transition endpoint (`Brief
  120`'s `handleTransition`). Brief 121 explicitly defers this to v2.
- **Snooze / mark-viewed** — would need a per-approver-per-submission
  state column. v2.
- **Per-form digest customization** (per-form subject lines, custom
  copy, etc.) — would require a per-form mapping table or
  configuration on `forms`. v2.
- **Cross-form bulk transitions** ("approve N items at once") —
  apps/web list page + worker batch endpoint. v2.

For any of these, the digest flow continues to fire daily; the new
flow plugs in alongside without conflict.

---

## Notes

- The cron fail-softs on a non-2xx response: a single 5xx from PA
  doesn't halt the rest of the per-recipient loop. The worker log
  line `[forms.approval-digest] POST non-2xx for {email}: status N`
  surfaces every failure.
- When `FORMS_APPROVAL_DIGEST_WEBHOOK_URL` is unbound, the cron still
  runs and logs `would-fire (no webhook bound) recipient=… total=… forms=…`
  per recipient — useful for verifying the data shape before binding
  the secret.
- Per-recipient timeout is 15s. The cron processes recipients
  sequentially; for very large approver populations a future
  enhancement could parallelize via `Promise.all`, but at the
  expected operator population (tens of approvers, not thousands)
  serial is sufficient.
