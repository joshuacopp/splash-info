# Power Automate flow build guide — Brief 101 + Brief 102

Two new flows to build alongside the existing customer-claim flow.
Both are HTTP-trigger flows that loop over `recipients[]` and Send
Email V2. When you save each flow, PA generates the HTTP POST URL
you bind to the worker secret.

| Flow | Secret to bind | Fires on |
|------|----------------|----------|
| A — Claim Update | `CLAIM_UPDATE_WEBHOOK_URL` | Note added OR status change to a notify-eligible status |
| B — Internal New Claim | `INTERNAL_NEW_CLAIM_WEBHOOK_URL` | Every new customer claim submission |

Build order doesn't matter. Recommend building Flow A first because
it's simpler.

---

## Flow A — Claim Update

### Step 1. Trigger

- New flow → Automated cloud flow → Skip → search "When a HTTP
  request is received" → Create.
- Method: POST (PA defaults to "Any" — change to POST).
- Request Body JSON Schema: click **Use sample payload to generate
  schema**, paste this sample, click Done:

```json
{
  "change_type": "status",
  "claim_id": "OSW-20260510-141200-A1B2",
  "customer_name": "Jane Doe",
  "location_code": "oswego",
  "location_pretty": "Oswego",
  "admin_url": "https://splashcarwashes.info/admin/damage/OSW-20260510-141200-A1B2",
  "actor": {
    "email": "rm.east@splashcarwashes.com",
    "dc_role": "rm"
  },
  "from_status": "Approved — Pending Quotes",
  "to_status": "Pending RM Quote Approval",
  "note_text": "Quote submitted — please review.",
  "recipients": ["rm@example.com"],
  "candidates": {
    "rm_email": "rm@example.com",
    "site_email": "site@example.com"
  }
}
```

The above is a status-change sample. The schema PA generates covers
the note case too (note payloads omit `from_status`/`to_status` and
the dynamic-content tokens for those just render empty when missing).
If you'd rather have an explicit note sample to compare, here's one:

```json
{
  "change_type": "note",
  "claim_id": "OSW-20260510-141200-A1B2",
  "customer_name": "Jane Doe",
  "location_code": "oswego",
  "location_pretty": "Oswego",
  "admin_url": "https://splashcarwashes.info/admin/damage/OSW-20260510-141200-A1B2",
  "actor": {
    "email": "noah@splashcarwashes.com",
    "dc_role": "admin"
  },
  "note_text": "Spoke with customer, ordering parts tomorrow.",
  "recipients": ["rm@example.com", "site@example.com"],
  "candidates": {
    "rm_email": "rm@example.com",
    "site_email": "site@example.com"
  }
}
```

### Step 2. Guard against empty recipients

Add **Condition**:
- Left: `length(triggerBody()?['recipients'])`
- Operator: is greater than
- Right: 0

In the **If no** branch, add **Terminate** (Status: Succeeded). This
makes the flow a no-op when the worker fires but actor-exclusion
emptied the list — happens whenever the actor's own email was the
only candidate.

Everything below goes in the **If yes** branch.

### Step 3. Switch on change_type

Add **Switch**:
- On: `triggerBody()?['change_type']`

Two cases: `note` and `status`. (Default case: leave empty —
treat unknown change types as no-op.)

### Step 4a. Case "note" — Apply to each recipient → Send email

Inside the `note` case:

- **Apply to each**:
  - Select an output: `triggerBody()?['recipients']`
- Inside the loop:
  - **Send an email (V2)**:
    - To: `Current item` (the email string from the loop)
    - Subject: paste this, then replace `{customer_name}` and
      `{location_pretty}` with PA dynamic-content tokens:
      ```
      Note added: {customer_name}'s claim at {location_pretty}
      ```
    - Body: switch the editor to **HTML** view (Code view button,
      `</>`), paste this, then replace each `{token}` with the
      corresponding dynamic-content token:

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;color:#222;">
  <h2 style="color:#1e3a5f;margin:0 0 12px;">Note added to a damage claim</h2>
  <p style="margin:0 0 16px;">
    <strong>{actor_email}</strong> added a note to
    <strong>{customer_name}</strong>'s claim at
    <strong>{location_pretty}</strong>.
  </p>
  <blockquote style="border-left:4px solid #ccc;padding:8px 16px;margin:0 0 16px;color:#333;background:#fafafa;">
    {note_text}
  </blockquote>
  <p style="margin:24px 0;">
    <a href="{admin_url}" style="background:#1e3a5f;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;display:inline-block;font-weight:bold;">View claim</a>
  </p>
  <p style="color:#888;font-size:12px;margin-top:24px;">Claim ID: {claim_id}</p>
</div>
```

Token mapping for the body:
- `{actor_email}` → dynamic content `email` (under the `actor` object)
- `{customer_name}` → `customer_name`
- `{location_pretty}` → `location_pretty`
- `{note_text}` → `note_text`
- `{admin_url}` → `admin_url`
- `{claim_id}` → `claim_id`

### Step 4b. Case "status" — Apply to each recipient → Send email

Inside the `status` case:

- **Apply to each**:
  - Select an output: `triggerBody()?['recipients']`
- Inside the loop:
  - **Send an email (V2)**:
    - To: `Current item`
    - Subject:
      ```
      Status change: {customer_name}'s claim at {location_pretty} → {to_status}
      ```
    - Body (HTML view):

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;color:#222;">
  <h2 style="color:#1e3a5f;margin:0 0 12px;">Claim status updated — your attention may be required</h2>
  <p style="margin:0 0 8px;">
    <strong>{customer_name}</strong>'s claim at
    <strong>{location_pretty}</strong> has moved to:
  </p>
  <p style="background:#fff3cd;border-left:4px solid #f59e0b;padding:12px 16px;margin:0 0 16px;font-weight:bold;color:#92400e;">
    {to_status}
  </p>
  <p style="margin:0 0 16px;color:#555;">
    Changed by <strong>{actor_email}</strong> (was: {from_status})
  </p>
  <blockquote style="border-left:4px solid #ccc;padding:8px 16px;margin:0 0 16px;color:#333;background:#fafafa;">
    {note_text}
  </blockquote>
  <p style="margin:24px 0;">
    <a href="{admin_url}" style="background:#1e3a5f;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;display:inline-block;font-weight:bold;">View claim</a>
  </p>
  <p style="color:#888;font-size:12px;margin-top:24px;">Claim ID: {claim_id}</p>
</div>
```

Token mapping is the same as 4a, plus `{from_status}` → `from_status`
and `{to_status}` → `to_status`.

**Optional polish:** the `<blockquote>` for `{note_text}` will render
empty when the status change carried no accompanying note. If empty
blockquotes bother you, wrap it in a Condition (`length(triggerBody()?['note_text'])` > 0)
and only emit it in the If-yes branch. Most operators leave it —
empty blockquote is unobtrusive.

### Step 5. Save and grab the URL

Save the flow. The trigger card now shows the HTTP POST URL — click
the copy icon. Paste it into the wrangler bind command at the end
of this doc.

---

## Flow B — Internal New Claim

Similar shape to Flow A, more fields, and one extra moving part:
photos render as an HTML link list built via Append to string
variable (PA Select's Map field is strict about JSON and trips up
on raw HTML; this pattern sidesteps that entirely).

Top-to-bottom action order in the finished flow:
1. When a HTTP request is received (trigger)
2. Initialize variable — `photoListItems` (String, empty)
3. Apply to each photo → Append to string variable
4. Compose — `PhotoListHtml`
5. Compose — `DamageTypeLabel` (folds in `damage_other` when present)
6. Condition — recipients non-empty (guard; everything below sits in If-yes)
7. Apply to each recipient → Send email (V2)

The worker payload still ships `summary_pdf_url` and
`summary_pdf_base64`, but this flow doesn't reference either —
the customer-facing PDF intentionally omits internal context, so
attaching it to an internal email is no benefit. All the relevant
detail lives in the email body or behind the **View claim in
Splash admin** button.

### Step 1. Trigger

- New flow → Automated cloud flow → Skip → "When a HTTP request is
  received" → Create.
- Method: POST.
- Request Body JSON Schema: click **Use sample payload to generate
  schema**, paste this sample, click Done:

```json
{
  "claim_id": "OSW-20260511-091500-K8X2",
  "submitted_at": "2026-05-11T09:15:00.000Z",
  "location_code": "oswego",
  "location_pretty": "Oswego",
  "admin_url": "https://splashcarwashes.info/admin/damage/OSW-20260511-091500-K8X2",
  "customer_name": "Maria Rodriguez",
  "customer_email": "maria@example.com",
  "customer_phone": "555-123-4567",
  "vehicle": "2019 Toyota Camry - Silver",
  "damage_type": "Mirror",
  "damage_other": null,
  "issue_description": "Driver-side mirror was clipped during the dryer phase. Hanging by wires.",
  "recipients": [
    "rm@example.com",
    "site@example.com",
    "am@example.com",
    "incidents@splashcarwashes.com"
  ],
  "candidates": {
    "rm_email": "rm@example.com",
    "site_email": "site@example.com",
    "am_email": "am@example.com",
    "incidents_email": "incidents@splashcarwashes.com"
  },
  "summary_pdf_url": "https://splash-damage.workers.dev/claims-api/summary/OSW-20260511-091500-K8X2",
  "summary_pdf_base64": "JVBERi0xLjQKJeLjz9MK...truncated...",
  "photos": [
    {
      "url": "https://splash-damage.workers.dev/claims-api/photo/claims/OSW-20260511-091500-K8X2/photo-1.jpg",
      "mime": "image/jpeg",
      "original_filename": "mirror-1.jpg",
      "photo_type": "Damage",
      "uploaded_at": "2026-05-11T09:15:02.000Z"
    },
    {
      "url": "https://splash-damage.workers.dev/claims-api/photo/claims/OSW-20260511-091500-K8X2/photo-2.jpg",
      "mime": "image/jpeg",
      "original_filename": "mirror-2.jpg",
      "photo_type": "Damage",
      "uploaded_at": "2026-05-11T09:15:03.000Z"
    }
  ]
}
```

### Step 2. Initialize the photo-list string variable

- **Initialize variable**:
  - Name: `photoListItems`
  - Type: `String`
  - Value: leave the field blank (empty string)

This is the buffer that the next step appends each photo's `<li>`
into. Empty start makes the empty-photos case render as `<ul></ul>`
(or fall through to the "No photos uploaded" branch in Step 4 —
see below).

### Step 3. Append one `<li>` per photo

- **Apply to each**:
  - Select an output: `triggerBody()?['photos']` (pick the `photos`
    array from dynamic content)
- Inside the loop, **Append to string variable**:
  - Name: `photoListItems`
  - Value: paste the line below into the Value field as plain text,
    then replace the three placeholder tokens (`{url}`,
    `{original_filename}`, `{photo_type}`) by clicking the
    corresponding dynamic content entry under the "photos" header
    in the dynamic-content panel:
    ```
    <li><a href="{url}">{original_filename}</a> ({photo_type})</li>
    ```
  - If a photo has no `original_filename`, the link will render with
    an empty label. If that bothers you, swap the link text for the
    expression `@{coalesce(item()?['original_filename'], 'Photo')}`
    using the formula picker — but most operators leave it.

PA will name the Apply to each block automatically based on the
loop source ("Apply to each", "Apply to each 2", etc.). Renaming it
to `For_each_photo` makes the action history easier to read but
isn't required.

### Step 4. Wrap the items in `<ul>` (Compose)

**Placement: outside (after) the Apply to each from Step 3.** Click
the `+ New step` button at the bottom of the Apply to each card —
NOT the `+` inside the loop body. The Compose should appear as a
sibling action below the Apply to each block in the canvas, not as
a child action nested inside it. If you put it inside the loop, you
rebuild the wrapped HTML on every iteration and only the final
pass's output is available downstream — wrong shape.

- **Compose** action — rename to `PhotoListHtml`:
  - Inputs: click the `fx` icon to switch the Inputs field to formula
    mode and paste this expression in full:
    ```
    if(equals(length(triggerBody()?['photos']), 0), '<p style="color:#888;">No photos uploaded.</p>', concat('<ul>', variables('photoListItems'), '</ul>'))
    ```
  - Click OK. The Inputs field should now show the expression as a
    single pink token.

You'll reference **Outputs** of `PhotoListHtml` in the email body
below.

### Step 5. Fold `damage_other` into the damage label (Compose)

Sibling action below `PhotoListHtml`. The worker sends `damage_type`
(an enum-ish value like `"Mirror"` or `"Other"`) and a sibling
`damage_other` free-text field that's only populated when
`damage_type === "Other"`. We want the email to render
`"Mirror"` in the common case and `"Other — Driver-side antenna
snapped clean off"` when the customer picked Other and provided a
description.

- **Compose** action — rename to `DamageTypeLabel`:
  - Inputs (formula mode via the `fx` icon):
    ```
    if(empty(triggerBody()?['damage_other']), triggerBody()?['damage_type'], concat(triggerBody()?['damage_type'], ' — ', triggerBody()?['damage_other']))
    ```

You'll reference **Outputs** of `DamageTypeLabel` in the email
body's damage-type row.

### Step 6. Guard against empty recipients

Same pattern as Flow A Step 2:

- **Condition**:
  - Left: `length(triggerBody()?['recipients'])`
  - Operator: is greater than
  - Right: `0`
- **If no** branch: add **Terminate** (Status: Succeeded). No-op when
  there's nobody to email. In practice this should never trigger for
  Flow B (customer claim webhook always has at least the
  `INCIDENTS_EMAIL` recipient, assuming you bound the `[vars]`
  entry), but the guard is cheap insurance.

Everything below goes inside the **If yes** branch.

### Step 7. Apply to each recipient → Send email

Inside the If-yes branch:

- **Apply to each** — **rename this block to `For_each_recipient`**
  (three dots → Rename). The rename matters: there are now two
  Apply to each loops in this flow (the photo loop from Step 3 and
  this one), and PA's dynamic-content picker shows a "Current item"
  entry under each. Naming both loops makes the picker unambiguous
  — without the rename, clicking "Current item" can resolve to the
  wrong loop's `item()` and PA will reject the save with
  `InvalidTemplate: action 'For_each_photo' must be a parent
  'foreach' scope`.
  - Select an output: `triggerBody()?['recipients']`
- Inside the loop, **Send an email (V2)**:
  - To: pick **Current item** from under the `For_each_recipient`
    section of dynamic content (NOT the entry under
    `For_each_photo`).
  - Subject (paste as plain text, then replace tokens with dynamic
    content):
    ```
    New damage claim at {location_pretty}: {customer_name} ({vehicle})
    ```
  - Body: switch the editor to HTML view (the `</>` Code view icon
    on the body toolbar) and paste:

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;color:#222;">
  <h2 style="color:#1e3a5f;margin:0 0 8px;">New damage claim submitted</h2>
  <p style="margin:0 0 16px;">
    A customer at <strong>{location_pretty}</strong> just submitted a damage claim.
  </p>
  <table style="border-collapse:collapse;width:100%;margin:0 0 20px;">
    <tr><td style="padding:6px 12px;border-bottom:1px solid #eee;width:140px;"><strong>Customer</strong></td><td style="padding:6px 12px;border-bottom:1px solid #eee;">{customer_name}</td></tr>
    <tr><td style="padding:6px 12px;border-bottom:1px solid #eee;"><strong>Email</strong></td><td style="padding:6px 12px;border-bottom:1px solid #eee;"><a href="mailto:{customer_email}">{customer_email}</a></td></tr>
    <tr><td style="padding:6px 12px;border-bottom:1px solid #eee;"><strong>Phone</strong></td><td style="padding:6px 12px;border-bottom:1px solid #eee;">{customer_phone}</td></tr>
    <tr><td style="padding:6px 12px;border-bottom:1px solid #eee;"><strong>Vehicle</strong></td><td style="padding:6px 12px;border-bottom:1px solid #eee;">{vehicle}</td></tr>
    <tr><td style="padding:6px 12px;border-bottom:1px solid #eee;"><strong>Damage type</strong></td><td style="padding:6px 12px;border-bottom:1px solid #eee;">{damage_type_label}</td></tr>
  </table>
  <h3 style="color:#1e3a5f;margin:0 0 8px;">Customer's description</h3>
  <p style="background:#f8f9fa;padding:12px 16px;border-radius:4px;margin:0 0 20px;white-space:pre-wrap;">{issue_description}</p>
  <h3 style="color:#1e3a5f;margin:0 0 8px;">Photos uploaded</h3>
  {photo_list_html}
  <p style="margin:32px 0 8px;">
    <a href="{admin_url}" style="background:#1e3a5f;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;display:inline-block;font-weight:bold;">View claim in Splash admin</a>
  </p>
  <p style="color:#666;font-size:13px;margin:0 0 24px;">
    The admin page shows every field the customer submitted — mailing
    address, license plate, equipment involved, employee on duty,
    what was communicated to the customer, etc. — and is where you
    advance the claim through review and approval.
  </p>
  <p style="color:#888;font-size:12px;margin-top:24px;">Claim ID: {claim_id} • Submitted: {submitted_at}</p>
</div>
```

Token mapping (replace each `{token}` with the matching dynamic
content):
- Simple fields → same-named tokens (`customer_name`,
  `customer_email`, `customer_phone`, `vehicle`,
  `issue_description`, `claim_id`, `submitted_at`, `location_pretty`)
- `{damage_type_label}` → **Outputs** of the **DamageTypeLabel**
  compose from Step 5
- `{photo_list_html}` → **Outputs** of the **PhotoListHtml** compose
  from Step 4
- `{admin_url}` → `admin_url`

The `vehicle` token in the subject is the assembled
"year make model - color" string the worker builds — same field used
in the body table.

### Step 8. Save and grab the URL

Save the flow. The trigger card now shows the HTTP POST URL — click
the copy icon. Paste it into the wrangler bind command at the end
of this doc.

### Want more internal fields surfaced in the email?

The worker payload today carries: claim_id, submitted_at,
location_code/pretty, admin_url, customer name/email/phone,
vehicle, damage_type, damage_other, issue_description,
recipients[], candidates, summary_pdf_url, summary_pdf_base64,
photos[]. Everything in the body above pulls from that.

Fields that exist on the customer claim submission but are NOT
currently in the webhook payload (so can't be rendered in this
email until a follow-up brief widens the payload):

- mailing address
- license plate
- vehicle color separated out (it's folded into `vehicle` today)
- pre-existing damage flag
- equipment involved / equipment malfunction
- determination
- what was communicated to the customer
- customer demeanor
- employee name (the staff member who handled the customer)

All of these are visible behind the **View claim in Splash admin**
button. If you want any of them in the email body directly, that's
a Brief 103-style follow-up to extend `InternalNewClaimPayload` and
`fireInternalNewClaimNotification` in damage-worker; the PA flow
edit is then just adding rows to the body table.

---

## Binding the secrets after both flows exist

Open PowerShell in the splash-info repo root and run:

```powershell
pnpm --filter @splash/damage-worker exec wrangler secret put CLAIM_UPDATE_WEBHOOK_URL
# paste Flow A's URL when prompted

pnpm --filter @splash/damage-worker exec wrangler secret put INTERNAL_NEW_CLAIM_WEBHOOK_URL
# paste Flow B's URL when prompted
```

These take effect on the currently deployed version of damage-worker.
You don't need to redeploy the worker — wrangler secret put is a live
update.

Verify:

```powershell
pnpm --filter @splash/damage-worker exec wrangler secret list
```

Should show both names (values are hidden).

---

## First-test checklist

**Flow A — note:** From `/admin/damage/[id]`, add a note on any
claim that isn't at your own location (so actor-exclusion doesn't
empty recipients). Expect one email to the location's `site_email`
and one to its `rm_email`.

**Flow A — status:** Transition a claim to `Pending GM Review`
or `Pending RM Review` from an account that isn't on the target
contact column. Expect one email to the matching contact.

**Flow B — new claim:** Submit a test claim on workers.dev via
`/claims/oswego` (or any active slug). Expect four emails:
`rm_email`, `site_email`, `am_email`, and `INCIDENTS_EMAIL`. The
PDF should attach when it's small (most claims will be — the 3 MB
ceiling is generous for a ~5-page PDF with embedded photos).

If a flow misfires, the worker's CF Workers Logs will show the
outbound POST. Filter on `[claim-update]` or `[internal-new-claim]`
to find them.

---

## Customer-claim flow (Brief 32) — not changed

You already have this one built. The new flows are parallel to it,
not replacements. No changes needed to the existing flow or to
`CUSTOMER_CLAIM_WEBHOOK_URL`.
