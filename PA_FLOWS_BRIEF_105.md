# Power Automate flow build guide — Brief 105

One new flow alongside your existing 30-minute fleet ingest flow.
Triggers on every dashboard edit; finds the matching SharePoint
item by submission `id`; updates the changed fields.

| Flow | Secret to bind | Fires on |
|------|----------------|----------|
| Fleet Submission Update | `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` | Every dashboard PATCH (status, notes, or both) |

---

## Step 1. Trigger

- New flow → Automated cloud flow → Skip → "When a HTTP request is
  received" → Create.
- Method: POST.
- Request Body JSON Schema: click **Use sample payload to generate
  schema**, paste this sample (status + notes combined edit), click
  Done. The schema covers all three variants — status-only and
  notes-only payloads just have the unused fields render empty when
  referenced.

```json
{
  "id": "8c4f2b1a-d3e7-4a91-b652-2f9e7d1a8c3b",
  "change_type": "both",
  "changed_fields": ["status", "notes"],
  "actor": {
    "email": "noah@splashcarwashes.com"
  },
  "row": {
    "id": "8c4f2b1a-d3e7-4a91-b652-2f9e7d1a8c3b",
    "company_name": "Acme Trucking",
    "contact_name": "Jane Driver",
    "contact_email": "jane@acmetrucking.com",
    "contact_phone": "555-867-5309",
    "fleet_size": 24,
    "location_code": "milford",
    "location_pretty": "Milford",
    "package_code": "BASIC",
    "address": "123 Main St",
    "submitted_at": "2026-05-11T14:19:06.000Z",
    "created_at": "2026-05-11T14:19:06.000Z",
    "status": "contacted",
    "splash_notes": "Spoke with Jane on 5/11, will call back Friday.",
    "status_updated_at": "2026-05-11T15:42:00.000Z",
    "status_updated_by": "noah@splashcarwashes.com",
    "splash_notes_updated_at": "2026-05-11T15:42:00.000Z",
    "splash_notes_updated_by": "noah@splashcarwashes.com"
  }
}
```

Two variant samples (for reference — you don't need to add them to
PA, the above schema covers both):

**status-only edit:**

```json
{
  "id": "8c4f2b1a-d3e7-4a91-b652-2f9e7d1a8c3b",
  "change_type": "status",
  "changed_fields": ["status"],
  "actor": {"email": "noah@splashcarwashes.com"},
  "row": { "...full row with new status, status_updated_*, untouched splash_notes_*..." }
}
```

**notes-only edit:**

```json
{
  "id": "8c4f2b1a-d3e7-4a91-b652-2f9e7d1a8c3b",
  "change_type": "notes",
  "changed_fields": ["notes"],
  "actor": {"email": "noah@splashcarwashes.com"},
  "row": { "...full row with new splash_notes, splash_notes_updated_*, untouched status_*..." }
}
```

The exact shape of `row` matches the Supabase `fleet_submissions`
columns post-edit, returned directly from PostgREST's
`Prefer: return=representation` on the PATCH. If the table grows new
columns later, those will appear in `row` automatically — PA will
ignore unmapped fields.

---

## Step 2. Find the matching SharePoint item

This step depends on which SharePoint column you use to store the
Supabase submission UUID. Looking at your existing 30-minute ingest
flow will tell you — open it and find where it writes `id` (or
whatever column name you chose). Replace `[submission_id]` below
with that exact column's internal name.

- **Get items** (SharePoint connector):
  - Site Address: same site your ingest flow writes to
  - List Name: same list your ingest flow writes to
  - Filter Query: `[submission_id] eq '@{triggerBody()?['id']}'`
  - Top Count: `1`

This returns an array. If the dashboard edit fires within the 30
minutes BEFORE the ingest flow has inserted the new row, the array
will be empty — guard for that next.

---

## Step 3. Guard against the row not existing yet in SharePoint

- **Condition**:
  - Left: `length(body('Get_items')?['value'])`
  - Operator: is greater than
  - Right: `0`
- **If no** branch: add **Terminate** (Status: Succeeded). The
  ingest flow will catch up on its next 30-minute cycle and insert
  the row with the latest Supabase state — the dashboard edit
  isn't lost, just delayed by ≤30 minutes for first-time edits
  on brand-new submissions.

Everything below goes inside the **If yes** branch.

---

## Step 4. Update the matching SharePoint item

- **Update item** (SharePoint connector):
  - Site Address: same as Step 2
  - List Name: same as Step 2
  - Id: `first(body('Get_items')?['value'])?['ID']` (paste as an
    expression — this is the SharePoint internal numeric ID for the
    item that matched on submission UUID)
  - Status column: map to `triggerBody()?['row']?['status']`
  - Splash Notes column (or whatever you named it): map to
    `triggerBody()?['row']?['splash_notes']`
  - Optionally: map the four audit columns
    (`status_updated_at`, `status_updated_by`,
    `splash_notes_updated_at`, `splash_notes_updated_by`) to
    SharePoint columns if you want them visible there. If your
    SharePoint list doesn't track these, leave them out — PA ignores
    unmapped trigger fields.
  - Required SharePoint fields you don't want to overwrite: leave
    blank in the Update Item card, which preserves their existing
    values. PA's "Update item" is a partial update by default.

You only really need to map status and splash_notes in v1 — the
update is selective and won't disturb the other columns the ingest
flow already populated.

---

## Step 5. (Optional) Branch on `change_type` for nicer logs

Not required, but helpful when scanning run history later. Wrap the
Update item action in a Switch on `triggerBody()?['change_type']`:

- Case `status`: only set the status column (omit splash_notes
  mapping)
- Case `notes`: only set the splash_notes column (omit status
  mapping)
- Case `both`: set both
- Default: log + Terminate Succeeded (defensive — shouldn't happen)

The minimal version skips this entirely and always sends both
columns. SharePoint's Update Item handles "unchanged value" cleanly,
so the simpler topology works.

---

## Step 6. Save and grab the URL

Save the flow. The trigger card shows the HTTP POST URL — copy it.

Bind on damage-worker… wait, this is fleet:

```powershell
pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret put FLEET_SUBMISSION_UPDATE_WEBHOOK_URL
# paste the URL when prompted
```

Verify:

```powershell
pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret list
```

Should show `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` in the list.

---

## First-test checklist

1. Open `/admin/fleet/[id]` for any existing submission that's
   already been ingested by the 30-min flow (so the SharePoint row
   exists).
2. Change the status dropdown from `new` to `reviewed`. Save.
3. Watch the flow run history in Power Automate — you should see a
   trigger fire within a few seconds, Get items return one match,
   Update item succeed.
4. Refresh the SharePoint list view — status should reflect the
   new value.
5. Repeat with a splash_notes edit and with a combined edit; the
   flow's `change_type` should differ across runs and the Update
   item should land both fields when `change_type` is `both`.

If a run fails on Get items returning zero results, that means the
submission's row hasn't been ingested by the 30-min flow yet —
expected for very fresh submissions. The next ingest cycle inserts
with the latest Supabase state, so no data is lost.

If a run fails on Update item with a permissions error, double-check
the SharePoint connector's authenticated user has edit rights on the
list. (PA's connector auth is per-connector, not per-flow.)

---

## Watch-outs

- **Don't change the existing 30-minute ingest flow.** It still
  handles brand-new submission inserts + email notifications. The
  new flow is parallel to it.
- **Supabase is now authoritative.** Any edits made directly in
  SharePoint will be overwritten on the next dashboard PATCH for
  that row. If your team needs to edit in SharePoint going forward,
  let me know and we'll reconsider the sync direction.
- **No backfill.** Existing rows whose status / notes you might
  have edited in SharePoint won't get pulled back into Supabase —
  Path 1 is one-way Supabase → SharePoint. If you need a one-time
  reconciliation, that's a manual operator task or a one-off flow.
