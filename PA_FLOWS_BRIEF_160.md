# Power Automate flow update guide — Brief 160

Brief 160 added optional `is_inline` + `content_id` fields to each
attachment in the `outbound_emails` queue. To make these take effect,
the existing "Splash Outbound Emails" drain flow (Brief 127) needs two
expression edits inside the per-attachment loop that maps queue rows
onto Send Email V2's `Attachments` array.

This is an **edit-in-place** to the Brief 127 flow. No new flow, no
new connector, no new secret. Five-minute job.

| What | Where |
|------|-------|
| Edit existing "Splash Outbound Emails" flow | PA portal → My flows |
| Add `IsInline` mapping | Inside the inner "For each attachment" loop |
| Add `ContentId` mapping | Same loop, same step |
| Smoke-test | Send a promo announcement with one inline image |

---

## Why this is needed

Today the promo-worker emits announcement emails with the body HTML
containing `<img src="cid:material-{uuid}" />` tags. Those references
resolve via the CID (Content-ID) header on the corresponding
attachment. The Office 365 connector's Send Email V2 action supports
this via two per-attachment fields:

- **`IsInline`** (boolean) — when true, the attachment is treated as
  an inline body resource rather than a tray attachment.
- **`ContentId`** (string) — the CID the body HTML references.

Without these mappings, Send Email V2 sends every attachment as a
regular tray attachment regardless of the `is_inline` field on the
queue row. The body HTML still ships, but the `<img src="cid:...">`
references can't resolve — Outlook shows a broken-image placeholder,
Gmail just hides the image. The email arrives; it just looks broken.

After the edit, inline-flagged attachments render embedded in the
body. The same image does NOT also appear in the tray (the Office 365
connector knows to suppress tray rendering for inline attachments).

---

## Step 1. Open the flow

1. Sign in to https://make.powerautomate.com.
2. Left nav → **My flows**.
3. Find **Splash Outbound Emails** (the Brief 127 flow). Click its
   name to open the run history.
4. Top-right → **Edit**.

You're now in the flow designer.

---

## Step 2. Locate the per-attachment loop

The flow's structure from Brief 127:

```
Recurrence (every 5 min)
  ├─ HTTP — Claim batch
  ├─ Parse JSON — Claim response
  ├─ Initialize variable — Results = []
  ├─ For each — items   ← the OUTER loop over queue rows
  │   ├─ Send an email (V2)
  │   │   └─ Attachments parameter
  │   │       └─ For each — attachments   ← the INNER loop you want
  │   ├─ Append to array — Results
  │   └─ (failure branch) Append to array — Results
  └─ HTTP — Confirm batch
```

The **inner** For-each (the one inside Send Email V2's Attachments
parameter) is where the per-attachment fields are mapped. That's the
step to edit.

If your flow was built using Send Email V2's static "Add new item"
attachment repeater instead of a dynamic mapping, see **Variant A**
at the bottom of this doc.

---

## Step 3. Reveal advanced attachment fields

Inside the inner attachment For-each, click into the Send Email V2
action and find the **Attachments** parameter block.

By default Send Email V2 shows three per-attachment fields:

- Attachments Name
- Attachments Content
- Attachments Content-Type

Click **Show advanced options** at the bottom of the Send Email V2
action. Two more attachment fields appear:

- **Attachments Inline** (boolean — this is `IsInline`)
- **Attachments Content-Id** (string — this is `ContentId`)

These didn't exist as widgets before Microsoft enabled them on V2;
they're the documented public surface for CID inline support.

---

## Step 4. Map the new fields

In the **Attachments Inline** field, paste this expression:

```
@{if(equals(item()?['is_inline'], true), true, false)}
```

> The wrapper around `equals(...)` is defensive — the JSONB column
> emits the value as either `true`, `false`, `null`, or absent. Coercing
> through `equals(...) → true/false` collapses every "not strictly true"
> case to `false` so Send Email V2 never sees `null`. Without the
> coerce, some connector versions throw `BadRequest:
> Attachments.IsInline must be a boolean`.

In the **Attachments Content-Id** field, paste this expression:

```
@{if(equals(item()?['is_inline'], true), item()?['content_id'], null)}
```

> The outer `if(...)` prevents Send Email V2 from registering a CID
> for non-inline attachments — those rows have `content_id: null` (or
> absent) but the connector treats a populated ContentId on a
> non-inline attachment as malformed in some cases. Gating on
> `is_inline` keeps the mapping clean.

---

## Step 5. Save + test

1. Top-right → **Save**.
2. **Test** → **Manually** → **Save and test** → **Run flow**.
3. The test runs against whatever's currently in the queue. If nothing
   is queued, the flow runs through cleanly with a `confirmed_sent:
   0` result — that's fine; the edit is saved.

Now exercise the real path:

1. From apps/web → `/admin/promotions/{some promo}` → click **Compose
   announcement**.
2. Add at least one image material to the promo first if there isn't
   one. Mark it `inline` in the materials checklist (default for
   image MIMEs).
3. Send to your own email address only.
4. Within 5 minutes, the inbox copy arrives.
5. Confirm:
   - The body HTML renders with the image embedded INLINE in the body.
   - No tray attachment shows for the same image.
   - Non-image materials (PDFs, copy docs) still show in the tray.

If the image renders inline → PA flow widening is complete.

If the image still renders in the tray with the body showing a broken
image marker → the connector isn't picking up `IsInline`. Check
**Variant B** below.

---

## Variant A — Static attachment repeater (legacy flow shape)

If your existing flow uses Send Email V2's "Add new item" attachment
repeater rather than a dynamic For-each, the per-attachment loop
won't exist as a discrete For-each step. Instead, each attachment is
represented as an individual item on Send Email V2 directly.

In that shape:

- The dynamic per-attachment mapping isn't possible without rebuilding
  the attachments block to use the dynamic-array form.
- Recommended remediation: rebuild the attachments parameter as a
  dynamic mapping. Delete the static repeater items, click **Add
  dynamic content** on the Attachments parameter, and select the
  `attachments` array from the queue item. PA will surface the same
  inner For-each + per-attachment field block described in Step 2,
  and you can apply Step 3-4 normally.
- This is a one-time rebuild — once the dynamic form is in place,
  future attachment-shape changes are additive again.

---

## Variant B — Connector version that doesn't show inline fields

A small number of older Send Email V2 connector versions don't surface
`Attachments Inline` / `Attachments Content-Id` even under Show
advanced options.

Options, in order of preference:

1. **Update the connector** — open the action's three-dot menu →
   "Update connector". Microsoft has shipped these fields on every
   public release since 2024; outdated connectors are rare.
2. **Add the parameter manually** — at the bottom of the Send Email
   V2 step there's a `+` "Add a parameter" button. Search for
   "inline" and "content id" to find them.
3. **Switch to raw HTTP** — fall back to the Microsoft Graph SendMail
   endpoint via the HTTP connector instead of the Outlook V2
   connector. This is heavier; only do this if 1 and 2 fail.

---

## Failure modes

- **Inline image renders fine in Outlook, missing in Gmail web.**
  Gmail's webmail aggressively rewrites inline images to its own CDN.
  This is a rendering behaviour, not a flow misconfiguration.
  Recipients receiving on Gmail web see the image inline via Gmail's
  proxy; the flow is fine.
- **`Attachments.IsInline must be a boolean` error.** The defensive
  `equals(...)` wrapper in Step 4 missed an edge case. Confirm the
  expression on Attachments Inline is the FULL string from Step 4
  (no truncation). Re-paste if in doubt.
- **All attachments suddenly send as inline.** The Attachments Inline
  expression is hardcoded to `true` instead of the conditional. Re-
  check Step 4.
- **PA flow throws on send and the queue row's `last_error` says
  "Attachments[0].ContentId required when IsInline is true".**
  Worker side bug — `content_id` was null on a row with `is_inline:
  true`. Shouldn't happen per the worker's `is_inline + content_id`
  pairing logic (Brief 160 Phase 4.1), but if it does, the queue
  row is the smoking gun — pull the row from Supabase, share the
  attachments JSONB, and file a bug.

---

## What's NOT in this guide

- New flow standup — this is an edit-in-place to the Brief 127 drain
  flow.
- Per-flow rebuild — Brief 127's drain flow is the SINGLE flow for
  every outbound_emails consumer. Adding promo announcements (or any
  future worker) inherits this widening automatically.
- Tracking pixels / open-rate analytics — out of scope at Brief 160.

---

## Operator post-edit verification

1. Edit the flow per Steps 1-4.
2. Save.
3. From `/admin/promotions/{id}`:
   - Upload an image material if the promo doesn't have one.
   - Compose announcement → send to yourself only.
4. Inbox check within 5 minutes:
   - Body renders with the image embedded inline.
   - No tray attachment for that image.
   - PTP renders as styled blocks below the body (if you opted in).
   - Splash navy header band + white logo + footer brand line are
     visible.
5. If anything renders incorrectly, the Preview button in the compose
   modal shows exactly what the recipient should see — divergence
   between the preview and the actual email is a PA flow bug; identity
   is a recipient-client rendering quirk.
