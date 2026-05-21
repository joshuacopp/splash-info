# Power Automate flow build guide — Brief 140

The Brief 140 D1-failure alert reuses the **existing**
`INTERNAL_NEW_CLAIM_WEBHOOK_URL` Power Automate flow (built per
Brief 102 / `PA_FLOWS_BRIEF_101_102.md`). No new HTTP trigger, no new
secret, no new URL. The flow branches on a new top-level
discriminator field `alert_type` to decide which email template
to render.

| `alert_type` value | Source                            | Audience |
|--------------------|-----------------------------------|----------|
| absent / missing   | Brief 102 internal new-claim fire | RM + Site + AM + INCIDENTS |
| `"d1_failed"`      | Brief 140 D1-failure alert        | INCIDENTS only |

This consolidation keeps the HTTP trigger URL stable and avoids
spawning a one-off webhook secret for a low-frequency alert. PA's
existing recipient-loop already covers the per-recipient email
send; the branch just swaps the template.

---

## Step 1. Update the trigger schema

Re-open the Brief 102 flow. Under the HTTP trigger, click **Use
sample payload to generate schema** and paste the union of the
two payloads below so PA's dynamic-content picker knows about
the new fields. The existing schema is preserved as the
`absent alert_type` shape; the new `d1_failed` shape is additive.

```json
{
  "alert_type": "d1_failed",
  "claim_id": "BIN-20260521-170744-B0NP",
  "location_code": "binghamton",
  "customer_name": "Jane Doe",
  "customer_email": "jane@example.com",
  "r2_submission_url": "submissions/BIN-20260521-170744-B0NP.json",
  "summary_pdf_url": "https://splash-damage.workers.dev/claims-api/summary/BIN-20260521-170744-B0NP",
  "error_message": "no such column: idempotency_key",
  "recipients": ["incidents@splashcarwashes.com"]
}
```

The Brief 102 sample (full new-claim shape) remains valid — PA's
schema union accepts either. Fields absent in the d1_failed
payload (`submitted_at`, `location_pretty`, `customer_phone`,
`vehicle`, `damage_type`, `damage_other`, `issue_description`,
`candidates`, `summary_pdf_base64`, `photos`) render as empty
in the existing template's dynamic-content tokens — which is
fine because the d1_failed branch uses a different template.

---

## Step 2. Add a top-level branch on `alert_type`

Immediately after the trigger, before the existing "Apply to
each recipient" loop, add a **Switch** action:

- On: `triggerBody()?['alert_type']`

### Case: `d1_failed`

Add inside this case:

1. **Apply to each** — `triggerBody()?['recipients']` (this will
   be a single-element array of `INCIDENTS_EMAIL`, but the loop
   shape stays consistent with Brief 101/102).

2. Inside the loop, **Send an email (V2)**:

   - **To**: `items('Apply_to_each_d1_failed')` (the loop's
     current item — the recipient email).
   - **Subject**: `[ACTION REQUIRED] Damage claim not persisted to admin storage — @{triggerBody()?['claim_id']}`
   - **Body** (toggle HTML on):

   ```html
   <p>A customer claim was submitted but failed to write to the admin storage (D1) database. The claim's photos, summary PDF, and SharePoint record were persisted normally, but the admin UI at <code>/admin/damage</code> will NOT show this claim until manual backfill.</p>

   <h3>Claim details</h3>
   <ul>
     <li><strong>Claim ID:</strong> @{triggerBody()?['claim_id']}</li>
     <li><strong>Location:</strong> @{triggerBody()?['location_code']}</li>
     <li><strong>Customer:</strong> @{triggerBody()?['customer_name']} (@{triggerBody()?['customer_email']})</li>
     <li><strong>D1 error:</strong> <code>@{triggerBody()?['error_message']}</code></li>
   </ul>

   <h3>Recovery</h3>
   <p>The canonical submission JSON is in R2 at this key:</p>
   <p><code>@{triggerBody()?['r2_submission_url']}</code></p>
   <p>To backfill: open the <code>damagedocs</code> R2 bucket in Cloudflare's dashboard, paste the key above into the object browser, download the JSON, and use the field values to insert a row into D1's <code>claims</code> table (mirror the writeClaimBatch shape).</p>

   <p>Customer-facing PDF copy of the claim:<br>
   <a href="@{triggerBody()?['summary_pdf_url']}">@{triggerBody()?['summary_pdf_url']}</a></p>
   ```

   - **Importance**: High.

### Case (default): existing Brief 102 path

Move the existing "Apply to each recipient" + Send Email V2
actions into the **Default** branch of the Switch. No content
changes — the new-claim template stays as it was.

---

## Step 3. Save + test

- Save the flow. PA does NOT regenerate the HTTP trigger URL
  when the schema changes — your bound
  `INTERNAL_NEW_CLAIM_WEBHOOK_URL` secret stays valid.
- To smoke: temporarily DROP the `idempotency_key` column on a
  non-prod D1, submit a claim, confirm the INCIDENTS inbox
  receives one email with the recovery template. Restore the
  column afterward.

---

## Why one flow, two templates

The alternative — second HTTP trigger + second secret — would
have meant:

- Adding a `D1_FAILURE_ALERT_WEBHOOK_URL` env var to wrangler.toml.
- A second flow URL to manage in PA.
- Risk of drift between the two flows' "actually email this"
  step (PA's per-flow Send Email connection is duplicate-prone).

The `alert_type` discriminator is the same pattern the forms
worker uses (Brief 127's `source_kind` on `outbound_emails`) and
keeps PA's per-flow surface minimal. Future alert types
(`pa_failed`, `r2_failed`, etc.) extend by adding a new Switch
case without touching the worker contract.
