// handleGetSubmission — the authority wiring, end to end.
//
// WHY A HANDLER TEST AND NOT ONLY THE UNIT ONES NEXT DOOR
//
//   submission-scope.test.ts pins formScopeFor, and formScopeFor was never
//   wrong. The 2026-09-29 production bug was that THIS HANDLER CALLED THE OTHER
//   HELPER -- a locations-only one that ignored the caller's form-access tag.
//   Every unit test of the rule would have stayed green through it.
//
//   So the test that earns its place is the one that asks the question an
//   operator asks: this person clicked Review on a ticket assigned to them, did
//   they get the ticket? The first case below is that exact click.
//
// WHAT IS STUBBED, AND WHY THAT IS HONEST
//
//   `authenticate` is replaced (there is no real cookie to mint here) and
//   `fetch` is routed to canned PostgREST responses. Everything between -- the
//   gate, the tag resolution, the scope choice, the approver fallback and the
//   refusal shape -- is the real code. The stubs stand exactly where the
//   network is, which is the boundary this worker does not own.
//
//   MOCK SHAPE, learned the hard way. Two rules under
//   @cloudflare/vitest-pool-workers, both copied from
//   apps/workorders-worker/src/mx-timesweep.test.ts:
//
//     1. Mock a RELATIVE path. `vi.mock("@splash/auth", ...)` is accepted and
//        then silently does nothing -- the real function stays in place, so
//        every case fails on its assertion rather than on the mock, which
//        reads like a logic bug and is not one. Workspace packages resolve
//        differently in this pool.
//     2. The factory closes over a mutable local, and the module under test
//        is pulled in with `await import` AFTER it. A `vi.fn()` inside the
//        factory does not apply either.
//
//   So the seam here is `./auth.js` -- the worker's own gate module. What the
//   2026-09-29 bug got wrong was how this handler USES a gate result, not how
//   the gate computes one, so driving the gate directly is testing the thing
//   that actually broke.

import { afterEach, describe, expect, it, vi } from "vitest";

const FORM = "13c8b3ca-1411-4d99-9e97-01397e3e3a12";
const SUB = "6ecafdce-8a68-46fe-84ba-4409c84abf5b";
const APPROVER = "rosemarie.mantello@splashcarwashes.com";
const SUBMITTER = "plattsburghwash@splashcarwashes.com";
const STRANGER = "nobody@splashcarwashes.com";

/** Swapped per test. `submissionGate` hands exactly this back, so each case
 *  states the caller's grant as the gate would have resolved it. */
let gateResult: unknown = { ok: false, status: 401, body: '{"error":"unauthenticated"}' };

/** Who the caller is, for the approver / submitter / acted-on read paths.
 *  Reachable at all only because submissions.ts now takes `authenticate` from
 *  ./auth.js -- a relative specifier this pool can intercept. */
let authResult: unknown = { status: "unauthenticated" };

vi.mock("./auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth.js")>();
  return {
    ...actual,
    // requireServiceKey and adminGateResponse stay real: the first decides
    // whether the handler runs at all, and the second IS the refusal shape
    // these tests assert on.
    submissionGate: async () => gateResult,
    authenticate: async () => authResult
  };
});

const { handleGetSubmission } = await import("./submissions.js");

const ENV = {
  SUPABASE_URL: "https://sb.test",
  SUPABASE_SERVICE_KEY: "service-key"
} as never;

/** A real CRD ticket's shape: static_emails approver, stage `approval`, and
 *  crucially NO location_code -- which is what makes a location-only scope
 *  fatal rather than merely narrow. */
const SUBMISSION_ROW = {
  id: SUB,
  form_id: FORM,
  form_version_id: "v14",
  payload: { customer_name: "Emily Brown" },
  submitter_kind: "authenticated",
  submitter_user_id: null,
  submitter_email: SUBMITTER,
  submitter_ip: null,
  submitted_at: "2026-09-25T12:00:00Z",
  status: "new",
  status_updated_at: null,
  status_updated_by: null,
  splash_notes: null,
  splash_notes_updated_at: null,
  splash_notes_updated_by: null,
  workflow_stage: "approval",
  workflow_history: [],
  current_approver_emails: [APPROVER],
  version: {
    id: "v14",
    version_number: 14,
    published_at: "2026-09-01T00:00:00Z",
    published_by: null,
    schema: {
      fields: [],
      workflow: {
        default_stage: "approval",
        stages: [
          {
            id: "approval",
            label: "CRD action needed",
            kind: "step",
            approver_source: { type: "static_emails", emails: [APPROVER] },
            transitions: [{ to: "approved", label: "Approve" }]
          },
          { id: "approved", label: "Approved", kind: "outcome", transitions: [] }
        ]
      }
    }
  },
  files: []
};

const GATE_OK = (scope: unknown) => ({
  ok: true,
  session: { email: APPROVER, userId: "11111111-1111-4111-8111-111111111111" },
  scope
});
const GATE_403 = { ok: false, status: 403, body: '{"error":"forbidden"}' };
const GATE_401 = { ok: false, status: 401, body: '{"error":"unauthenticated"}' };

/** Only one read survives a mocked gate: the submission itself. */
function stubFetch(row: unknown = SUBMISSION_ROW) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname !== "/rest/v1/form_submissions") {
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }
    // A CRD ticket carries no location_code, so ANY location filter excludes
    // it -- including the in.("__no_location__") sentinel an empty scope
    // produces. Reproducing that is what makes the first test mean something:
    // pre-fix, the handler sent exactly that filter and got nothing back.
    const body = url.searchParams.get("location_code") ? [] : [row];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as never;
}

/** Signs someone in for the read-path checks. They hold no grant, so the gate
 *  refuses them and authority has to come from the submission itself. */
function signedInAs(email: string) {
  authResult = {
    status: "authenticated",
    session: {
      userId: "11111111-1111-4111-8111-111111111111",
      email,
      role: null,
      dcRole: null,
      promoRole: null,
      mustChangePassword: false,
      tools: [],
      locations: []
    }
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  gateResult = GATE_401;
  authResult = { status: "unauthenticated" };
});

const get = () =>
  handleGetSubmission(ENV, new Request("https://forms.test/"), FORM, SUB);

describe("handleGetSubmission authority", () => {
  // THE PRODUCTION FAILURE, 2026-09-29. A CRD approver holding the `crd` tag
  // and NO user_permissions row at all -- locations [] -- clicking Review on a
  // ticket that names her.
  //
  // Pre-fix the handler scoped this read by locations alone, sent
  // location_code=in.("__no_location__"), got zero rows and returned 404. This
  // case fails against that handler and passes against the current one, which
  // is the entire reason the file exists.
  it("serves a tag-only caller whose tag covers the form", async () => {
    gateResult = GATE_OK({ forms: [FORM], locations: [] });
    stubFetch();

    const res = await get();
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      submission: { id: string };
      can_edit: boolean;
    };
    expect(body.submission.id).toBe(SUB);
    // Her tag covers the form, so handlePatchSubmission would accept her too.
    expect(body.can_edit).toBe(true);
  });

  it("scopes a location-granted caller by their locations", async () => {
    gateResult = GATE_OK({ forms: [], locations: ["plattsburgh"] });
    stubFetch();

    // The ticket has no location_code, so a location-scoped caller does not
    // reach it -- and, not being the approver either, gets 404 rather than a
    // hint that it exists.
    expect((await get()).status).toBe(404);
  });

  // A caller who PASSES the gate but whose grant does not reach this form.
  // Before the fix this case could not be reached at all; it now falls through
  // to the approver check, and a non-approver must not learn the row exists.
  it("404s a gate-passing caller whose grant misses the form", async () => {
    gateResult = GATE_OK({ forms: ["00000000-0000-4000-8000-000000000000"], locations: [] });
    stubFetch();

    expect((await get()).status).toBe(404);
  });

  it("returns the gate's own refusal to a caller who failed it", async () => {
    gateResult = GATE_403;
    stubFetch();

    // 403, not 404: the ORIGINAL refusal, so "exists but not yours" cannot be
    // told apart from "no access to this surface".
    expect((await get()).status).toBe(403);
  });

  it("stays a 401 for an unauthenticated caller, never falling through", async () => {
    gateResult = GATE_401;
    stubFetch();

    // Widening 401 into the approver fallback would be a different and much
    // worse change than the one this handler needed.
    expect((await get()).status).toBe(401);
  });

  // ---------------------------------------------------------------------
  // The three READ paths of callerMayViewSubmission. Every caller below FAILS
  // the gate outright -- no tag, no locations -- so authority comes entirely
  // from the submission: who it names, who raised it, who has touched it.
  // ---------------------------------------------------------------------

  it("serves the named approver who holds no grant at all", async () => {
    gateResult = GATE_403;
    signedInAs(APPROVER);
    stubFetch();

    const res = await get();
    expect(res.status).toBe(200);

    // Read, but not edit: no grant reaches the form, so the PATCH would refuse
    // them and offering an editor would lose their typing at the Save button.
    expect(((await res.json()) as { can_edit: boolean }).can_edit).toBe(false);
  });

  // Brief 126's My Requests links submitters straight at this page, so without
  // this path they cannot open their own submission.
  it("serves the submitter their own ticket", async () => {
    gateResult = GATE_403;
    signedInAs(SUBMITTER);
    stubFetch();

    expect((await get()).status).toBe(200);
  });

  // THE 2026-09-21 REGRESSION. The ticket has moved to a terminal outcome, so
  // the caller is no longer its current approver -- they are only in
  // workflow_history, as the person who put it there.
  //
  // Under the original rule (current approver ONLY) this 404s, which meant
  // ACTING ON A TICKET REVOKED THE ABILITY TO SEE IT: the transition
  // succeeded, the page refreshed, and the UI reported failure on a write that
  // had worked, with a retry that did nothing because the stage had moved.
  it("serves someone who already acted, after the stage moves on", async () => {
    gateResult = GATE_403;
    signedInAs(APPROVER);
    stubFetch({
      ...SUBMISSION_ROW,
      workflow_stage: "approved",
      current_approver_emails: [],
      workflow_history: [
        {
          from: "approval",
          to: "approved",
          actor_email: APPROVER,
          at: "2026-09-26T15:00:00Z"
        }
      ]
    });

    expect((await get()).status).toBe(200);
  });

  // The mirror of the case above: a terminal stage carries no approver_source,
  // so nobody is its approver. Someone who never touched the ticket must not
  // inherit access just because it reached an outcome.
  it("still refuses a stranger once the ticket is closed out", async () => {
    gateResult = GATE_403;
    signedInAs(STRANGER);
    stubFetch({
      ...SUBMISSION_ROW,
      workflow_stage: "approved",
      current_approver_emails: [],
      workflow_history: [
        {
          from: "approval",
          to: "approved",
          actor_email: APPROVER,
          at: "2026-09-26T15:00:00Z"
        }
      ]
    });

    expect((await get()).status).toBe(403);
  });
});
