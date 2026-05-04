# @splash/signup-worker

Production-critical worker for the public MaxPass signup flow. This is the only one of the five Splash workers with real customer traffic — its cutover gets a dedicated planning conversation, not a routine deploy.

## Status

**Chunk 1 of an in-flight port** (Step 6, in progress). Router returns 404 for all paths today; legacy production worker continues to serve real traffic.

| Chunk | Scope |
|---|---|
| 1 (done) | Scaffolding + signature-mode dispatch surface + pricing resolver |
| 2 | Picker + form HTML render, pricing cache, `/signup/*` routes wired |
| 3 | `POST /api/submit-signup` — fraud detection + `maxpass_signups` insert |
| 4 | Admin pricing UI (if not moved to apps/web first) |
| 5 | CSRF retrofit |
| Cutover | Separate conversation: parallel deploy, shadow testing, traffic shift, rollback plan |

## Deploy (B2 strategy — workers.dev only)

```bash
pnpm --filter @splash/signup-worker deploy
```

This deploys to `splash-signup-next.<account>.workers.dev`. The legacy production worker (named `splash-signup` and bound to the production routes) is untouched. Production routes remain commented out in `wrangler.toml` until cutover.

To redeploy after edits:
```bash
pnpm --filter @splash/signup-worker deploy
```

To dev locally:
```bash
pnpm --filter @splash/signup-worker dev
```

## Required env vars / secrets

```bash
wrangler secret put SUPABASE_URL --name splash-signup-next
wrangler secret put SUPABASE_ANON_KEY --name splash-signup-next
wrangler secret put SUPABASE_SERVICE_KEY --name splash-signup-next
```

`SIGNATURE_MODE` is a plain var (set in `wrangler.toml` `[vars]` block). Default: `inline`.

## Signature mode — flippable switch

Two paths, both fully built and typechecked. One env var swaps between them.

### `inline` (default — production path)

Worker renders the signup form HTML directly, customer agrees to terms via a checkbox, form posts to `/api/submit-signup` which writes straight to `maxpass_signups`. Today's production behavior. **Implementation lands in Chunk 2 (HTML) + Chunk 3 (submission handler).**

### `jotform` (dormant — preserved for legally-binding signature scenarios)

Worker `302`s to a JotForm URL with prefilled fields. JotForm captures the signature and webhook-posts back. **Built-but-untested** — legacy never used JotForm in production at the time of port (the `FORM_ID` constant existed in legacy code but was never referenced). The implementation in `src/signature/jotform.ts` is built against the documented prefill contract:

- Form ID (most locations): `252697336786980`
- Family Plan forms: separate per-package — IDs **TBD** (placeholder constants in code; replace before flip)
- Prefill fields: `package49`, `todaysDate`, `todaysPayment`, `nextBilling`, `typeA19`
- Phone format in prefill: `(607)768-5674` (parens, no space after `)`)
- Date format: `MM-DD-YYYY`

To flip on:
1. Replace family-form-ID placeholders in `src/signature/jotform.ts` with real IDs.
2. Confirm the JotForm prefill field names still bind as documented.
3. Decide how submitted JotForm data lands back in `maxpass_signups` — JotForm doesn't insert directly; need either a JotForm "POST submission to URL" integration or a Power Automate flow.
4. Set `SIGNATURE_MODE = "jotform"` in `wrangler.toml`, redeploy.
5. Rollback is the same one-line var swap + redeploy.

The path is preserved deliberately so signatures can come back without a from-scratch rebuild. **Re-validate against JotForm's current behavior at flip time** — the contract above is documented, not legacy-tested.

## Layout

```
src/
├── index.ts                  # Worker entry, route dispatch (404s in Chunk 1)
├── env.ts                    # Env type, resolveSignatureMode helper
├── pricing/
│   └── resolver.ts           # resolveTodayPrice / resolveOngoingPrice with defensive 'full' fallback
├── signature/
│   ├── inline.ts             # Production path — HTML renderers (Chunk 2 fills bodies)
│   ├── jotform.ts            # Dormant path — URL builder + redirect helper (Chunk 1 complete)
│   └── terms.ts              # Legal copy + date helpers (mmddyyyy, addMonthsClamp)
└── routes/                   # Empty placeholder; populated in Chunks 2-4
```

## Pricing modes

Five modes: `full`, `same`, `flash5`, `flash2`, `special`. Defensive default: any unrecognized mode (including legacy `penny` rows that may exist) falls back to `full` with a `console.warn`. This guarantees the worker never returns NaN or breaks customer signups for an unexpected DB state. See `src/pricing/resolver.ts`.

## Cutover (separate conversation, NOT this work)

Out of scope here. When its turn comes, the cutover plan covers parallel deployment, shadow testing, traffic shifting, and rollback. Until then this worker is reachable only at its workers.dev URL.
