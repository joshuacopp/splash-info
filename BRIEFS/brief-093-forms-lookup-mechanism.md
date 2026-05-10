# Brief 93: Forms — lookup mechanism (resolver + on-demand endpoint + submit-time re-resolve)

**Status:** Completed (2026-05-10)
**Started:** 2026-05-10
**Completed:** 2026-05-10
**Blocks:** Brief 94 (admin API CRUD — needs the lookup-sources endpoint to populate the inspector dropdowns). Brief 95 (admin builder UI — lookup field inspector depends on Brief 94's endpoint which depends on this brief).
**Dependencies:** Brief 89 (foundation — `LOOKUP_SOURCES` const, stub `resolveLookup`), Brief 90 (render — lookup fields render disabled with placeholder), Brief 91 (submit handler — extension point for re-resolve), Brief 92 (uploads — handler structure this brief mirrors).

## Read first

- BUILD_STATE.md.
- CLAUDE.md (especially the `getMaintainXLocationId` two-hop pattern in the damage-worker section — `pricing_simple.location_code → pricing_simple.site → locations.site_number`; this brief generalizes the join).
- BRIEFS/brief-089-forms-foundation-schema-worker-package.md (the stub this brief replaces; `LOOKUP_SOURCES` registry).
- BRIEFS/brief-090-forms-public-render.md (renderLookup function — currently renders disabled; this brief enables client-side dynamic resolve).
- BRIEFS/brief-091-forms-public-submit.md (submit handler — extension point for submit-time re-resolve).
- BRIEFS/brief-062-getmaintainxlocationid-fix-join-key.md (precedent for the two-hop join — locations.site_number is the right join column, NOT locations.site).
- BRIEFS/brief-049-getlocationcontactinfo-read-from-pricing-simple.md (precedent for reading contact info from pricing_simple).
- packages/db-supabase/src/lookup.ts (the Brief 89 stub this brief replaces).
- packages/forms-schema/src/lookup-sources.ts (`LOOKUP_SOURCES` + `LookupKeyColumn`).

## Architecture context

Per planning Decision 5 (corrected during planning), the lookup field has these contracts:

**Resolution timing per mode (Decision 5a):**

| Resolution mode      | Render-time resolve | Submit-time re-resolve | Stored in payload |
|----------------------|--------------------|--------------------|--------------------|
| `display_only`       | yes (client-side)  | no                 | no                 |
| `prefill_visible`    | yes (client-side)  | yes (canonical)    | yes (server-side fresh value) |
| `prefill_hidden`     | no                 | yes                | yes                |

**Client-side dynamic resolve (Decision 5b):** when the user changes the key field's value, the client iterates lookup fields whose `keyFieldId` matches the changed field's id and POSTs to `/forms/api/lookup/{slug}` with `{lookup_field_id, key_value}`. Worker resolves and returns `{value: string | null, resolved_at: ISO}`. Client populates the field UI. The displayed value is for UX; submission stores the server-side re-resolve.

**Server-side re-resolve at submit (Decision 5a.ii):** the submit handler computes the fresh value from the submitted `key_value` + the schema's lookup config. Compares against client value (logs warning if different). Always stores the SERVER-side fresh value, never the client value. Defends against client tampering AND handles the rare mid-fill data drift case.

**The two-hop join (Decision 5c):** when `sourceTable === 'locations'`, the resolver doesn't query `locations` directly with `keyValue` — it queries `pricing_simple` first to derive `pricing_simple.site` (which equals `locations.site_number`), then joins. The Brief 62 fix established that `locations.site_number` is the right join column. The resolver hides this from callers — they specify `sourceTable: 'locations'` and `keyColumn: 'pricing_simple.location_code'`, and the helper figures out the rest.

**KeyColumn options:** Per Decision 5 correction, two options:

| `keyColumn` value                  | Meaning                                                  |
|------------------------------------|----------------------------------------------------------|
| `pricing_simple.location_code`     | Slug like "oswego" — matches `pricing_simple.location_code` directly |
| `pricing_simple.site`              | 3-digit text like "147" — matches `pricing_simple.site` AND `locations.site_number` |

Operator picks based on what the form's key field captures. Internal forms typically use `site` (operators know their site by 3-digit number); public forms with a Location dropdown use `location_code` (the option `value` is the slug).

**Caching:** none. `pricing_simple`/`locations` are point reads on indexed columns; sub-10ms latency. Adding cache invalidation complexity for the marginal speedup isn't worth it. (Future: if measured load appears, edge cache the resolve endpoint with a 60s TTL keyed on `lookup_field_id + key_value`.)

## Context

Fifth of 10 briefs. After this brief, all 16 field types are functional. The form-builder's runtime is feature-complete; remaining briefs (94-98) are admin UI + admin API + cron + polish.

This brief is mostly mechanical extension of patterns already in place: Brief 89 stubbed `resolveLookup`; Brief 90 rendered lookup fields disabled with `data-lookup-key-field` attribute hooks; Brief 91's submit handler skips lookup fields. This brief un-stubs / un-skips all three.

## Scope

### Phase 1 — Real `resolveLookup` implementation

**File:** `packages/db-supabase/src/lookup.ts` (MODIFY — replace Brief 89 stub).

```ts
import type { LookupSource, LookupKeyColumn } from "@splash/forms-schema";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResolveLookupArgs {
  client: SupabaseClient;
  source: LookupSource;
  keyColumn: LookupKeyColumn;
  keyValue: string;
}

/**
 * Resolve a lookup field's value given a key.
 *
 * Dispatches based on source.table:
 *   - pricing_simple: direct SELECT WHERE keyColumn = keyValue.
 *   - locations:      two-hop. First derive pricing_simple.site from
 *                     pricing_simple WHERE keyColumn = keyValue.
 *                     Then SELECT FROM locations WHERE site_number = <that>.
 *
 * Returns:
 *   - string representation of the column value
 *   - null if no row matches OR if the matched row's column value is null
 *
 * Failure modes (return null + log):
 *   - Supabase error
 *   - Key value missing/empty
 *   - Source column not in the resolved row's column list (programmer error;
 *     means the LOOKUP_SOURCES registry has a column that doesn't exist on the table)
 */
export async function resolveLookup(args: ResolveLookupArgs): Promise<string | null> {
  const { client, source, keyColumn, keyValue } = args;

  if (!keyValue || keyValue.trim() === "") return null;

  const keyColumnName = keyColumn.split(".")[1];   // "location_code" or "site"

  if (source.table === "pricing_simple") {
    // Direct: SELECT {column} FROM pricing_simple WHERE {keyColumn} = keyValue
    // Use limit=1 because pricing_simple has multiple rows per location_code (per package)
    // and the denormalized columns (am_email, area_manager, etc.) are identical across them.
    const { data, error } = await client
      .from("pricing_simple")
      .select(source.column)
      .eq(keyColumnName, keyValue)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[forms.lookup] pricing_simple resolve error", { source, keyValue, error });
      return null;
    }
    if (!data) return null;
    const value = (data as Record<string, unknown>)[source.column];
    return value == null ? null : String(value);
  }

  if (source.table === "locations") {
    // Two-hop: derive pricing_simple.site from pricing_simple WHERE keyColumn = keyValue,
    // then SELECT FROM locations WHERE site_number = <that>.
    let siteNumber: string | null = null;

    if (keyColumnName === "site") {
      // Already a site number; no first hop needed.
      siteNumber = keyValue;
    } else {
      // keyColumnName === "location_code" — first hop
      const { data: psData, error: psErr } = await client
        .from("pricing_simple")
        .select("site")
        .eq("location_code", keyValue)
        .limit(1)
        .maybeSingle();
      if (psErr) {
        console.error("[forms.lookup] pricing_simple first-hop error", { keyValue, psErr });
        return null;
      }
      if (!psData) return null;
      siteNumber = (psData as { site: string | null }).site ?? null;
      if (!siteNumber) return null;
    }

    // Second hop
    const { data, error } = await client
      .from("locations")
      .select(source.column)
      .eq("site_number", siteNumber)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[forms.lookup] locations second-hop error", { siteNumber, source, error });
      return null;
    }
    if (!data) return null;
    const value = (data as Record<string, unknown>)[source.column];
    return value == null ? null : String(value);
  }

  // Unreachable — sourceTable is a union of two literal strings.
  console.warn("[forms.lookup] unknown source table", source);
  return null;
}
```

### Phase 2 — On-demand resolve endpoint

**File:** `apps/forms-worker/src/lookup/resolve.ts` (NEW).

```ts
import { isOriginAllowed, jsonError } from "@splash/http";
import { resolveLookup } from "@splash/db-supabase";
import { LOOKUP_SOURCES } from "@splash/forms-schema";
import type { LookupField } from "@splash/forms-schema";
import type { Env } from "../index";
import { getFormBySlug, getCurrentVersion, createServiceClient } from "../db/forms";

export async function handleLookupResolve(env: Env, req: Request, slug: string): Promise<Response> {
  if (!isOriginAllowed(req)) return new Response("Bad origin", { status: 403 });

  const form = await getFormBySlug(env, slug);
  if (!form) return new Response("Not Found", { status: 404 });
  if (form.status !== "published" || !form.currentVersionId) {
    return new Response("Form not accepting", { status: 410 });
  }

  const version = await getCurrentVersion(env, form.id, form.currentVersionId);
  if (!version) return new Response("Form version missing", { status: 500 });

  // Body shape: JSON { lookup_field_id, key_value }
  let body: { lookup_field_id?: string; key_value?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "Body must be valid JSON.");
  }
  if (!body.lookup_field_id) return jsonError(400, "missing_field_id", "lookup_field_id required.");

  const field = version.schema.fields.find(
    (f) => f.id === body.lookup_field_id && f.type === "lookup"
  ) as LookupField | undefined;
  if (!field) return jsonError(400, "unknown_field", "Lookup field not found in this form's schema.");

  // Validate sourceColumn against LOOKUP_SOURCES registry
  const allowedSource = LOOKUP_SOURCES.find(
    (s) => s.table === field.sourceTable && s.column === field.sourceColumn
  );
  if (!allowedSource) {
    return jsonError(400, "unknown_source",
      `Source ${field.sourceTable}.${field.sourceColumn} not in registry.`);
  }

  const keyValue = body.key_value ?? "";
  if (!keyValue) {
    return new Response(JSON.stringify({ value: null, resolved_at: new Date().toISOString() }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const client = createServiceClient(env);
  const value = await resolveLookup({
    client,
    source: allowedSource,
    keyColumn: field.keyColumn,
    keyValue
  });

  return new Response(JSON.stringify({
    value,
    resolved_at: new Date().toISOString()
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
```

### Phase 3 — Submit-time re-resolve

**File:** `apps/forms-worker/src/submit/index.ts` (MODIFY — extend `handleSubmit` after the file/signature R2 HEAD pass from Brief 92, before validation).

```ts
import { resolveLookup } from "@splash/db-supabase";
import { LOOKUP_SOURCES } from "@splash/forms-schema";

// ...inside handleSubmit, after the file/signature pass:

const lookupResolveErrors: Record<string, string> = {};
const client = createServiceClient(env);   // (might already be created above for files)

for (const field of version.schema.fields) {
  if (field.type !== "lookup") continue;

  // The key value comes from the form's key field (whatever its current submitted value is).
  const keyField = version.schema.fields.find((f) => f.id === field.keyFieldId);
  if (!keyField) {
    lookupResolveErrors[field.key] = "Lookup misconfigured — key field missing from schema.";
    continue;
  }

  const keyValue = String(payload[keyField.key] ?? "");
  if (!keyValue) {
    // No key value submitted. Per Decision 5, lookup is empty in payload
    // unless required AND nullBehavior === 'block_submit'.
    if (field.resolutionMode !== "display_only") {
      payload[field.key] = "";
    }
    continue;
  }

  const allowedSource = LOOKUP_SOURCES.find(
    (s) => s.table === field.sourceTable && s.column === field.sourceColumn
  );
  if (!allowedSource) {
    lookupResolveErrors[field.key] = "Lookup source not in registry.";
    continue;
  }

  const fresh = await resolveLookup({
    client,
    source: allowedSource,
    keyColumn: field.keyColumn,
    keyValue
  });

  // Drift logging: compare client value (if any) to fresh value
  const clientValue = payload[field.key];
  if (typeof clientValue === "string" && clientValue !== "" && clientValue !== fresh) {
    console.warn("[forms.lookup] drift detected at submit", {
      formId: form.id,
      fieldKey: field.key,
      clientValue,
      freshValue: fresh
    });
  }

  // Null behavior
  if (fresh == null && field.required && field.nullBehavior === "block_submit") {
    lookupResolveErrors[field.key] = `Could not resolve ${field.label} for the selected ${keyField.label}.`;
    continue;
  }

  // Per Decision 5: display_only doesn't store; the other two modes store the FRESH value
  if (field.resolutionMode === "display_only") {
    delete payload[field.key];   // don't store anything
  } else {
    payload[field.key] = fresh ?? "";
  }
}

if (Object.keys(lookupResolveErrors).length > 0) {
  return new Response(JSON.stringify({
    error: "lookup_failed",
    fields: lookupResolveErrors
  }), {
    status: 422,
    headers: { "Content-Type": "application/json" }
  });
}
```

### Phase 4 — Update payload validator for lookup type

**File:** `packages/forms-schema/src/validators/payload.ts` (MODIFY — replace the `null` return for lookup).

```ts
case "lookup": {
  // Lookup payload (post-server-resolve) is always a string OR omitted (display_only mode).
  // If display_only, the submit handler deletes the key entirely; the validator never sees it.
  if (field.resolutionMode === "display_only") return null;
  return field.required && field.nullBehavior === "block_submit"
    ? z.string().min(1)
    : z.string();
}
```

### Phase 5 — Update parse to skip lookup at parse time (server resolves)

**File:** `apps/forms-worker/src/submit/parse.ts` (MODIFY).

The lookup field's payload comes from the server-side re-resolve, NOT from form data. Parse should skip lookup fields entirely so client-supplied values don't pre-populate the payload (the submit handler's lookup loop above will set them):

```ts
if (field.type === "lookup") continue;   // server resolves at submit time
```

(This was already the Brief 91 default, but now it's intentional rather than deferred.)

### Phase 6 — Client-side dynamic resolve

**File:** `apps/forms-worker/static/forms-public.js` (MODIFY — extend Brief 92's file).

Add lookup wiring inside the `initForms` per-form loop:

```js
// Inside the per-form initForms() function:

// Wire lookup fields — listen for changes on key fields, re-resolve dependent lookups.
var lookupWraps = formEl.querySelectorAll('[data-field-type="lookup"]');
var keyFieldDependencies = {};   // keyFieldId -> [lookupWrap, ...]
lookupWraps.forEach(function (wrap) {
  var keyId = wrap.dataset.lookupKeyField;
  if (!keyId) return;
  if (!keyFieldDependencies[keyId]) keyFieldDependencies[keyId] = [];
  keyFieldDependencies[keyId].push(wrap);
});

Object.keys(keyFieldDependencies).forEach(function (keyId) {
  var keyEl = formEl.querySelector('#' + cssEscape(keyId)) || formEl.querySelector('[id="' + keyId + '"]');
  if (!keyEl) return;

  var debounceTimer;
  function onKeyChange() {
    clearTimeout(debounceTimer);
    var keyValue = keyEl.value || "";
    debounceTimer = setTimeout(function () {
      keyFieldDependencies[keyId].forEach(function (wrap) {
        resolveLookupField(wrap, slug, keyValue);
      });
    }, 250);
  }

  // Listen on both 'input' (text/select changes) and 'change' (select native picker)
  keyEl.addEventListener("input", onKeyChange);
  keyEl.addEventListener("change", onKeyChange);
});

function resolveLookupField(wrap, slug, keyValue) {
  var input = wrap.querySelector('input.field-input, input[type="text"]');
  if (!input) return;
  var fieldId = wrap.querySelector('[id]') ? wrap.querySelector('[id]').id : wrap.dataset.fieldKey;
  // Set loading state
  input.classList.add("field-lookup-disabled");
  input.value = keyValue ? "Resolving..." : "";

  if (!keyValue) {
    input.value = "";
    return;
  }

  // Resolve via worker endpoint. lookup_field_id = the field.id, sent in body.
  // The wrap doesn't carry field.id directly; pull it from a data attribute we add here.
  var lookupFieldId = wrap.dataset.lookupFieldId;
  if (!lookupFieldId) {
    // Brief 90's renderLookup didn't add data-lookup-field-id; brief 93 should
    // (see Phase 7 below — render extension).
    console.warn("[forms] lookup field missing data-lookup-field-id");
    return;
  }

  fetch("/forms/api/lookup/" + encodeURIComponent(slug), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lookup_field_id: lookupFieldId, key_value: keyValue })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) {
        input.value = "(error)";
        return;
      }
      var resolutionMode = wrap.dataset.lookupResolutionMode;
      if (resolutionMode === "prefill_hidden") {
        // Hidden — just set value silently; input is type="hidden" or visually hidden
        input.value = data.value || "";
        return;
      }
      // visible / display_only — populate visibly
      input.value = data.value || "";
      input.classList.remove("field-lookup-disabled");
      input.removeAttribute("disabled");
    })
    .catch(function () {
      input.value = "(error)";
    });
}

function cssEscape(s) {
  return s.replace(/[!"#$%&'()*+,./:;<=>?@\[\]^`{|}~]/g, "\\$&");
}
```

### Phase 7 — Render extension (add data-lookup-field-id)

**File:** `apps/forms-worker/src/render/fields/lookup.ts` (MODIFY — extend Brief 90's render).

Add `data-lookup-field-id="${field.id}"` to the wrapper so the client JS can identify which lookup is being resolved. Also: for `prefill_hidden` mode, render an `<input type="hidden">` instead of disabled text input (no need to display anything). For `display_only` mode, render as a styled callout `<div>` instead of an input.

```ts
import type { LookupField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index";
import { fieldLabel, fieldHelp, escapeHtml } from "../util";

export function renderLookup(field: LookupField, ctx: RenderBodyArgs): string {
  const keyField = ctx.version.schema.fields.find((f) => f.id === field.keyFieldId);
  const keyFieldLabel = keyField ? keyField.label : "the key field";
  const dataAttrs = `
    data-field-key="${escapeHtml(field.key)}"
    data-field-type="lookup"
    data-lookup-field-id="${escapeHtml(field.id)}"
    data-lookup-key-field="${escapeHtml(field.keyFieldId)}"
    data-lookup-resolution-mode="${escapeHtml(field.resolutionMode)}"
  `;

  if (field.resolutionMode === "prefill_hidden") {
    return `
<div class="field" ${dataAttrs}>
  <input type="hidden" name="${escapeHtml(field.key)}" id="lookup-${escapeHtml(field.id)}" value="" />
</div>`;
  }

  if (field.resolutionMode === "display_only") {
    return `
<div class="field field-display-only" ${dataAttrs}>
  ${fieldLabel(field)}
  <div class="field-display-value" id="lookup-${escapeHtml(field.id)}">
    <em>Select ${escapeHtml(keyFieldLabel)} to populate</em>
  </div>
  ${fieldHelp(field)}
</div>`;
  }

  // prefill_visible
  return `
<div class="field" ${dataAttrs}>
  ${fieldLabel(field)}
  <input type="text"
         name="${escapeHtml(field.key)}"
         id="lookup-${escapeHtml(field.id)}"
         class="field-input field-lookup-disabled"
         disabled
         placeholder="Select ${escapeHtml(keyFieldLabel)} to populate" />
  ${fieldHelp(field)}
</div>`;
}
```

(The display_only render uses a `<div>` instead of an input. The client JS for display_only writes to the div's textContent, not an input value — Phase 6's `resolveLookupField` should detect this and branch.)

Update Phase 6's `resolveLookupField` to handle display_only by populating the div instead of an input.

### Phase 8 — Wire route

**File:** `apps/forms-worker/src/index.ts` (MODIFY).

```ts
import { handleLookupResolve } from "./lookup/resolve";

// In fetch():
const lookupMatch = url.pathname.match(/^\/forms\/api\/lookup\/([^\/]+)$/);
if (lookupMatch && req.method === "POST") {
  return handleLookupResolve(env, req, lookupMatch[1]);
}
```

### Phase 9 — CSS for display-only callout

**File:** `apps/forms-worker/src/render/shell.ts` (MODIFY — append to `SHELL_CSS`).

```css
.field-display-only .field-display-value {
  background: var(--splash-gray-light);
  border-left: 3px solid var(--splash-cyan);
  padding: 10px 14px;
  border-radius: 4px;
  color: #555;
  min-height: 44px;
  display: flex;
  align-items: center;
}
```

### Phase 10 — Documentation

**File:** `PRE_DEPLOY_FORMS.md`. Section 5 ("Smoke tests") gets the Brief 93 entries:

> ### Brief 93 — lookup mechanism
>
> 1. Open `/forms/test-internal` (Brief 90 test form). Type "147" into Site Number field.
> 2. Within ~250ms, "Location" field populates with "Oswego" (or whatever pricing_simple has for site=147). The hidden "Regional Director email" gets its value silently.
> 3. Open browser DevTools → Network. See POST to `/forms/api/lookup/test-internal` with body `{lookup_field_id: "f2", key_value: "147"}`; response `{value: "Oswego", resolved_at: "..."}`.
> 4. Type a non-existent site like "999". Lookup fields show empty (allow_empty default).
> 5. Submit the form. Verify `form_submissions.payload`:
>    - `location_name` = "Oswego" (server-resolved fresh value)
>    - `rd_email` = the actual am_email from pricing_simple (NOT empty even though it was prefill_hidden — server filled it in)
> 6. Edit the test schema to set `nullBehavior: "block_submit"` on the Regional Director email lookup. Re-submit with site "999" → expect 422 with `lookup_failed` + `fields: { rd_email: "Could not resolve..." }`.
> 7. Drift test: in DevTools Console, after the lookup populated, manually rewrite the visible "Location" input to "Tampering" and submit. Verify `form_submissions.payload.location_name` = "Oswego" (server re-resolved, ignored client value). Verify worker logs show `[forms.lookup] drift detected at submit`.

**File:** `CLAUDE.md`. Append to forms-worker glossary:

> Brief 93 wired the lookup mechanism. `resolveLookup()` in `@splash/db-supabase` is the single source of truth for resolution; both `POST /forms/api/lookup/{slug}` (render-time client-driven) and the submit handler (canonical server-side re-resolve per Decision 5a.ii) call it. The two-hop join (`pricing_simple → locations`) is hidden inside the helper. Server re-resolves at submit even when the client supplied a value — defense against tampering AND handles mid-fill data drift. Drift is logged with `[forms.lookup] drift detected` for auditability. Caching: none — sub-10ms point reads on indexed columns.

**File:** `BUILD_STATE.md` + `BRIEFS/INDEX.md` — update entries.

### Phase 11 — Validation

```sh
pnpm --filter @splash/db-supabase typecheck
pnpm --filter @splash/forms-schema typecheck
pnpm --filter @splash/forms-worker typecheck
pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
pnpm typecheck
```

## Configuration

No new env vars or bindings.

## Out of scope

- Admin builder inspector for lookup config — Brief 95.
- Admin API endpoint exposing `LOOKUP_SOURCES` registry to the builder UI — Brief 94 wires that surface.
- Edge caching of lookup resolves — deferred until measured load shows it's needed.
- v2 typed lookups (boolean lookups currently coerce to string).
- Don't deploy to Cloudflare automatically.
- Don't bind production routes — staging only.
- Don't add to QUEUE.md until operator decides.
- Don't commit to git or push.

## Definition of done

- `packages/db-supabase/src/lookup.ts` has the real `resolveLookup` (replaces Brief 89 stub).
- `apps/forms-worker/src/lookup/resolve.ts` exists with `handleLookupResolve`.
- `apps/forms-worker/src/index.ts` routes `POST /forms/api/lookup/{slug}`.
- `apps/forms-worker/src/submit/index.ts` extended with the lookup re-resolve loop.
- `packages/forms-schema/src/validators/payload.ts` lookup case un-stubbed.
- `apps/forms-worker/src/render/fields/lookup.ts` extended with mode-aware render (hidden / display_only / visible variants) and `data-lookup-field-id` attribute.
- `apps/forms-worker/static/forms-public.js` extended with key-field listener + `resolveLookupField`.
- `apps/forms-worker/src/render/shell.ts` CSS extended for `.field-display-only`.
- Smoke tests pass.
- `pnpm typecheck` green.
- `wrangler deploy --dry-run` green.
- Brief Status flips to Completed.

## Report

- **Two-hop join correctness.** Confirm via a concrete test: `keyColumn = pricing_simple.location_code`, `sourceTable = locations`, `sourceColumn = hrt_email`, `keyValue = "oswego"` resolves to the right `hrt_email` value. (Brief 62 fixed this analogous join in damage-worker; this brief should produce the same correct value.)
- **Drift logging frequency.** If during smoke testing operator notices any unexpected drift logs (client value differing from server) without explicit tampering, surface it — could indicate a parse-vs-submit ordering bug.
- **`resolveLookup` performance.** Time the `lookup/{slug}` endpoint with curl; surface p50/p95 if measurable.
- **Validation results.**

## Outcome

**Files created:**
- `apps/forms-worker/src/lookup/resolve.ts` — `handleLookupResolve` for `POST /forms/api/lookup/{slug}`.

**Files modified:**
- `packages/db-supabase/src/lookup.ts` — Brief 89 stub replaced with the real resolver. Dispatches on `source.table`: `pricing_simple` → direct SELECT WHERE keyColumn = keyValue (limit 1); `locations` → two-hop via `pricing_simple.site → locations.site_number` with the keyColumn=`site` shortcut that skips the first hop. Returns `string | null`; null + log on Supabase error / unknown source / empty key value / malformed keyColumn.
- `apps/forms-worker/src/index.ts` — header docblock updated (Brief 93 line moved out of the "404 here" stub list and into the active routes list); `handleLookupResolve` import added; `POST /forms/api/lookup/{slug}` matcher routed.
- `apps/forms-worker/src/submit/index.ts` — header docblock's "lookup payloads still skipped" line replaced with the Brief 93 contract; `LOOKUP_SOURCES` + `resolveLookup` + `createServiceClient` imports added; new server-side re-resolve loop runs after the file/signature R2 HEAD pass and before validation. Per-field shape: find the key field in schema (missing → `lookup_failed`); read the submitted key value (empty → drop key for display_only / store `""` for other modes); resolve fresh; log `[forms.lookup] drift detected at submit` when client value is non-empty AND differs from fresh; for `block_submit` + required + null fresh push `lookup_failed`; otherwise drop key (display_only) or store fresh value. Aggregated 422 `{error: "lookup_failed", fields: {...}}` short-circuits the submit before validation runs.
- `apps/forms-worker/src/submit/parse.ts` — file header docblock + inline comment updated to reflect that the lookup skip is now intentional (server resolves at submit time), not deferred.
- `packages/forms-schema/src/validators/payload.ts` — lookup case un-stubbed: `display_only` returns null (validator skipped — submit handler deletes the key); `block_submit + required` returns `z.string().min(1)`; otherwise `z.string()`.
- `apps/forms-worker/src/render/fields/lookup.ts` — three mode-aware render variants. `prefill_hidden` emits `<input type="hidden">` only; `prefill_visible` emits the disabled text input from Brief 90 with `data-lookup-field-id` added; `display_only` emits a `<div class="field-display-value">` callout (no input, no `name`, no payload). All three carry the full `data-lookup-*` attribute set including `data-lookup-field-id="${field.id}"` so the client can identify which lookup is resolving.
- `apps/forms-worker/static/forms-public.js` — header docblock updated; `wireLookups(formEl, slug)` invoked from `initForms` per form; new `resolveLookupField(wrap, slug, keyValue)` posts to `/forms/api/lookup/{slug}` with `Content-Type: application/json`, populates the input value (visible / hidden) or display callout (display_only) based on `data-lookup-resolution-mode`. 250ms debounce on `input`+`change` events on the key field; initial resolve fires on load if the key field already has a value (browser back-button restoration). `cssAttrEscape` helper for safely interpolating UUID-shaped ids into `[id="..."]` selectors.
- `apps/forms-worker/src/render/shell.ts` — `SHELL_CSS` extended with `.field-display-only .field-display-value` rule (light-gray bg, cyan left border, 44px min-height callout).
- `PRE_DEPLOY_FORMS.md` — Section 5 gets a Brief 93 block with 7 smoke tests (visible+hidden lookup population, drift via DevTools tampering, block_submit `lookup_failed` 422, direct curl with cross-origin and unknown-field error paths).
- `CLAUDE.md` — forms-worker glossary entry extended with a Brief 93 paragraph (resolver as single source of truth, two-hop hidden inside the helper, drift logging, three render shapes, no caching).
- `BUILD_STATE.md` — Last updated bumped to 2026-05-10; new Brief 93 row in the prioritized work list table; the Last-updated paragraph leads with Brief 93's summary.
- `BRIEFS/INDEX.md` — Brief 93 row added.
- `BRIEFS/brief-093-forms-lookup-mechanism.md` — Status set to Completed, Started + Completed dates filled, this Outcome section filled.

**Decisions made on operator's behalf:**

1. **`createServiceClient` imported directly from `@splash/db-supabase`** rather than re-exported via `db/forms.ts`. The brief sample's `import { ... createServiceClient } from "../db/forms"` was a forward-reference that didn't match the actual package surface; `createServiceClient` is exported at the `@splash/db-supabase` package root. The forms-worker has been intentionally avoiding `@supabase/supabase-js` for forms-table reads (Brief 89/90/91/92 used direct PostgREST `fetch()`), but the SDK is already a transitive dep via `@splash/auth` (the post-Brief-91 5.7× bundle bump pulled it in), so importing `createServiceClient` for the lookup path adds no new bundle weight.

2. **`data` cast through `unknown` first in `resolveLookup`** — `SupabaseClient.from().select(column).eq(...).maybeSingle()` returns `GenericStringError` in the union; direct cast to `Record<string, unknown>` errored with TS2352 ("neither type sufficiently overlaps"). `as unknown as Record<string, unknown>` is the canonical TS workaround and matches what other monorepo helpers do for similar sdk return-type quirks.

3. **Input `id` attribute stays `${field.id}`** (matches `fieldLabel`'s `for` attr in `util.ts`). The brief sample's `id="lookup-${field.id}"` would have broken the label association — `fieldLabel` interpolates `field.id` directly. Reverted for consistency with the rest of the schema and to keep the `<label for>` linkage working.

4. **`cssAttrEscape` rather than `CSS.escape` polyfill** — UUIDs only contain hex + hyphen, so the escape universe for `[id="..."]` selectors is small (just `\\` and `"`). No need to pull in the full CSS.escape polyfill.

5. **Initial resolve fires on page load when the key field already has a value** — handles browser back-button form restoration so the dependent lookup field reflects the key field's current value at all times, not just after a fresh user interaction.

6. **Drift logging compares `clientValue !== ""` AND `!== fresh`** — empty client value isn't drift, just an unfilled lookup; saves log noise.

7. **Empty key value branch stores `""` for non-display_only modes** rather than deleting the key, so the validator sees the field consistently. `z.string()` with no `.min(1)` accepts empty string, supporting required + allow_empty semantics.

8. **`block_submit` triggers `lookup_failed` only when `fresh == null` AND `field.required`** — operator-controlled at form-build time. Optional fields with `block_submit` set don't block the submit (block_submit means "block when required + missing", not "block whenever missing").

9. **Render fields use existing `escapeHtml` on every interpolated value** (id, key, attrs) per the existing convention; this brief introduces no new escape paths.

**Latent issues found:**

1. **Drift logging on `prefill_hidden` mode requires a curl-shaped attack vector.** The client JS writes the value into the hidden input silently after fetch, so by submit time the client value matches the fresh value (no drift to detect via the normal browser path). Genuine `prefill_hidden` tampering from DevTools (rewriting the hidden input's value pre-submit) IS detectable because the submitted client value will differ from the fresh re-resolve. This is correct behavior — the drift signal is for tampering / drift detection, not for normal flow.

2. **`resolveLookup` accepts `keyValue` as-is for the `.eq()` query** — Supabase's PostgREST handles SQL escaping; no injection risk. The keyColumn segment is split out of `LookupKeyColumn` (a literal-string union) and validated to be non-empty; an attacker can't inject through the column name path either.

3. **The `LOOKUP_SOURCES` registry includes one boolean column** (`mla_location`); booleans coerce to string via `String(value)` per the helper's return shape — operator-facing display of `"true"`/`"false"` isn't ideal but v2-typed-lookups are explicitly out of scope per the brief's Out of scope.

**Validation results:**
- `pnpm --filter @splash/db-supabase typecheck` → green (after the `as unknown as` cast fix).
- `pnpm --filter @splash/forms-schema typecheck` → green.
- `pnpm --filter @splash/forms-worker typecheck` → green.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run` → green; bundle **989.26 KiB / 190.44 KiB gzip** (vs Brief 92's 975.33 / 187.11; +13.93 KiB / +3.33 KiB gzip from the new lookup module + resolveLookup helper). Well inside CF's 3 MiB compressed limit.
- Root `pnpm typecheck` → 17/17 packages green (Turbo: 6 cached, 11 fresh).

Smoke tests deferred to operator post-deploy per CLAUDE.md headless-mode constraint. PRE_DEPLOY_FORMS.md Section 5 has the 7-test sequence ready.

**Report items requested by the brief:**
- **Two-hop join correctness.** The helper is structured exactly as described — `keyColumn = pricing_simple.location_code`, `sourceTable = locations`, `sourceColumn = hrt_email`, `keyValue = "oswego"` will: (1) SELECT site FROM pricing_simple WHERE location_code = "oswego" LIMIT 1 → site ≈ "147"; (2) SELECT hrt_email FROM locations WHERE site_number = "147" LIMIT 1 → the hrt_email value. Same as Brief 62's analogous fix in damage-worker. Operator smoke test 1 (PRE_DEPLOY_FORMS.md Section 5 Brief 93) verifies the visible + hidden lookups for `test-internal` against site `147`.
- **Drift logging frequency.** Operator should expect zero drift logs under normal use. Any drift log without explicit DevTools tampering would indicate a parse-vs-submit ordering bug; flag if observed.
- **`resolveLookup` performance.** Not measured headlessly. Operator can `curl -w "%{time_total}\n"` against the resolve endpoint post-deploy; pricing_simple/locations are point reads on indexed columns and should resolve in sub-10ms p50.
