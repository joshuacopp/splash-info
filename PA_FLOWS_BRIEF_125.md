# Power Automate flow build guide — Brief 125

One new flow handles BOTH per-step assignment ("you have a new item to
review") AND per-outcome ("your submission was Approved/Denied") emails
for every form with a workflow. The forms-worker discriminates by a
top-level `type` field on the payload; the PA flow's first action is a
Condition control branching on `triggerBody()?.['type']`.

Adding a new form with a workflow requires zero PA work — the
notifications block on the new workflow opts in automatically.

| Flow | Secret to bind | Fires on |
|------|----------------|----------|
| Forms Outcome Notifications | `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` | (a) submission against a workflow seeds an assignment; (b) admin transitions a submission — one POST per recipient |

---

## Step 1. Trigger

- New flow → Automated cloud flow → Skip → "When a HTTP request is
  received" → Create.
- Method: POST.
- Request Body JSON Schema: click **Use sample payload to generate
  schema**, paste THIS sample (the union — both assignment + outcome
  fields present), click Done.

```json
{
  "type": "assignment",
  "submission_id": "abe1ebd9-1234-4567-8abc-9def01234567",
  "form_id": "9bf12345-abcd-4567-89ef-0123456789ab",
  "form_title": "Equipment Repair Request",
  "step_label": "RM Approval",
  "outcome_label": "Approved",
  "outcome_kind": "success",
  "recipient_email": "rm@splashcarwashes.com",
  "recipient_role": "submitter",
  "submitter_email": "gm@splashcarwashes.com",
  "submitted_at": "2026-05-14T11:00:00.000Z",
  "outcome_reached_at": "2026-05-14T15:30:00.000Z",
  "actor_history": [
    {
      "step_label": "RM Approval",
      "email": "rm@splashcarwashes.com",
      "action": "Approve",
      "at": "2026-05-14T15:30:00.000Z",
      "note": null,
      "typed_name": null,
      "signature_r2_key": null
    }
  ],
  "review_url": "https://splashcarwashes.info/admin/forms/9bf12345.../submissions/abe1ebd9..."
}
```

A real fire has EITHER assignment OR outcome fields filled, not both —
but PA's schema-generator wants everything optional. Mark the
unused fields nullable in PA (or just leave them; absent fields render
as empty strings in the rest of the flow).

---

## Step 2. Branch by `type`

Add a **Condition** action immediately after the trigger.

- **Left side**: `triggerBody()?['type']` (use the expression editor)
- **Operator**: is equal to
- **Right side**: `assignment`

The "Yes" branch handles assignment emails. The "No" branch handles
outcome emails.

---

## Step 3a. Assignment branch — "You have a new item to review"

Inside the **Yes** branch of the Condition, add an **Office 365 Outlook
— Send an email (V2)** action.

- **To**: `recipient_email` (dynamic content)
- **Subject**: `@{triggerBody()?['form_title']}: ready for your review`
- **Body** (rich text):

```html
<p>Hi,</p>

<p>You have a new <strong>@{triggerBody()?['form_title']}</strong>
submission waiting on you at the <em>@{triggerBody()?['step_label']}</em>
step.</p>

<p>Submitter:
@{coalesce(triggerBody()?['submitter_email'], '(anonymous)')}<br>
Submitted: @{formatDateTime(triggerBody()?['submitted_at'], 'g')}</p>

<p><a href="@{triggerBody()?['review_url']}">Open this submission to
review →</a></p>

<p>— Splash Tools</p>
```

---

## Step 3b. Outcome branch — "Your submission was Approved / Denied"

Inside the **No** branch of the Condition (i.e., `type === "outcome"`),
add another **Send an email (V2)**.

- **To**: `recipient_email` (dynamic content)
- **Subject**: switch on `outcome_kind` so the operator can pick subject
  language:
  - `@{triggerBody()?['form_title']}:
    @{triggerBody()?['outcome_label']}`
  - (Optional) prepend `[Approved] ` / `[Denied] ` based on
    `outcome_kind` if you want a visual flag in the inbox.
- **Body** (rich text):

```html
<p>Hi,</p>

<p>Your <strong>@{triggerBody()?['form_title']}</strong> submission has
reached <strong>@{triggerBody()?['outcome_label']}</strong>.</p>

<p>Submitted:
@{formatDateTime(triggerBody()?['submitted_at'], 'g')}<br>
Resolved: @{formatDateTime(triggerBody()?['outcome_reached_at'],
'g')}</p>

<h3>Approval history</h3>
<ul>
@{join(
  variables('HistoryLines'),
  '
'
)}
</ul>

<p><a href="@{triggerBody()?['review_url']}">Open this submission →</a></p>

<p>— Splash Tools</p>
```

Building the `HistoryLines` variable: before the Send email step,
inside the No branch, add an **Apply to each** loop over
`triggerBody()?['actor_history']`. Inside the loop, **Initialize
variable** (one-time before the loop, type Array, name `HistoryLines`,
value `[]`) and **Append to array variable**:

```
<li><strong>@{items('Apply_to_each')?['step_label']}</strong> —
@{items('Apply_to_each')?['action']} by
@{items('Apply_to_each')?['email']} on
@{formatDateTime(items('Apply_to_each')?['at'], 'g')}@{if(equals(items('Apply_to_each')?['note'], null), '', concat(': ', items('Apply_to_each')?['note']))}</li>
```

`recipient_role` is `"submitter"` or `"actor"` — switch on it in PA if
you want to send a different copy to the submitter vs. to approvers
who acted (e.g., the submitter sees "Your submission was approved";
the approver sees "The submission you approved has been finalized").

---

## Step 4. Save and copy the HTTP POST URL

Save the flow. Click the trigger card; copy the **HTTP POST URL**.
That's `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL`.

Bind it on the worker:

```powershell
pnpm --filter @splash/forms-worker exec wrangler secret put FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL
```

Until the secret is bound, the worker logs `[forms.notify.assignment]
webhook unbound — skipping` / `[forms.notify.outcome] webhook unbound
— skipping` and the transitions / submits still succeed. Operators
won't get notification emails until the bind happens.

---

## Smoke test

1. Submit a form with a workflow. The default-stage approver receives
   an assignment email.
2. Open the submission and Approve / Deny. The submitter receives an
   outcome email (when `notify_submitter_on_outcome` is on for that
   workflow).
3. If `notify_approvers_on_outcome` is on, the approver who acted
   also receives an outcome email tagged `recipient_role: actor`.

If no email arrives, check:
- The worker's logs for `[forms.notify.assignment]` /
  `[forms.notify.outcome]` lines. `non-2xx response` or `fire failed`
  means PA is reachable but rejecting; `webhook unbound` means the
  secret isn't set.
- Whether the form's workflow has the matching `notifications.*` flag
  enabled (Workflow tab → Notifications panel).

---

## Out of scope (v2 candidates)

- Per-form PDF attach (`attach_pdf_on_outcome`) — placeholder on the
  Notifications panel.
- Per-step / per-action subject overrides set in the Workflow tab.
- Per-recipient digest collapsing (multiple outcomes within a window
  → one email).
- Conditional notifications based on payload values.
