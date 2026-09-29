// Who may read a submission — the rule, pinned.
//
// WHY THIS FILE EXISTS
//
//   This worker's authority rules have been wrong in production twice, and
//   both times nothing caught it but an operator hitting the failure:
//
//     2026-09-21  The view rule allowed only the CURRENT stage's approver, so
//                 ACTING ON A TICKET REVOKED THE ABILITY TO SEE IT. The write
//                 succeeded, the page refreshed, the caller was no longer the
//                 current approver, and the detail 404'd -- reporting failure
//                 on a successful action.
//
//     2026-09-29  handleGetSubmission scoped its read with a locations-only
//                 helper that ignored the caller's form-access tag. A tag-only
//                 caller has locations [], applyLocationScope maps empty to a
//                 match-nothing sentinel, and the named approver of a live CRD
//                 ticket got a 404. HOLDING THE CORRECT GRANT WAS WHAT BROKE
//                 IT: a caller with no grant at all fell through to the
//                 approver path and got in.
//
//   Both are the same shape: a scope that silently narrows to nothing rather
//   than erroring. Nothing throws, both lists look plausible, and the only
//   symptom is a person who cannot open their own work. That is precisely what
//   a test can hold still and a reviewer cannot.
//
// WHAT IS AND IS NOT COVERED HERE
//
//   Covered: the two pure functions that decide scope -- formScopeFor (does
//   this caller's grant reach this form, and with what location filter) and
//   applyLocationScope (what that filter becomes as a query).
//
//   Not yet covered: callerMayViewSubmission, which needs `authenticate` and
//   `resolveApproverEmails` stubbed, and the handler end-to-end. Those are the
//   next suite; see the note at the bottom of this file.

import { describe, expect, it } from "vitest";
import { formScopeFor } from "./submissions.js";
import { applyLocationScope } from "../db/admin-submissions.js";

const FORM = "13c8b3ca-1411-4d99-9e97-01397e3e3a12";
const OTHER_FORM = "00000000-0000-4000-8000-000000000000";

/** Reads a query's location filter back out, or null when none was applied. */
function locationFilter(scope: string[] | undefined): string | null {
  const url = new URL("https://example.test/rest/v1/form_submissions");
  applyLocationScope(url, scope);
  return url.searchParams.get("location_code");
}

describe("formScopeFor", () => {
  it("gives admin tier the whole table, unfiltered", () => {
    expect(formScopeFor("all", FORM)).toEqual({
      allow: true,
      locationScope: undefined
    });
  });

  // THE 2026-09-29 REGRESSION. The distinction this asserts is the entire bug:
  // `undefined` means "no location filter", `[]` means "match nothing". A
  // tag-only caller must get the former.
  it("gives a tagged caller the whole form, with NO location filter", () => {
    const scope = { forms: [FORM], locations: [] };
    const result = formScopeFor(scope, FORM);

    expect(result).toEqual({ allow: true, locationScope: undefined });
    // Said twice on purpose: an empty array here is what 404'd a real approver,
    // and `toEqual` above would still pass if someone "helpfully" returned [].
    expect((result as { locationScope?: string[] }).locationScope).toBeUndefined();
    expect((result as { locationScope?: string[] }).locationScope).not.toEqual([]);
  });

  it("falls back to a location filter when the tag does not reach the form", () => {
    const scope = { forms: [OTHER_FORM], locations: ["plattsburgh", "oswego"] };
    expect(formScopeFor(scope, FORM)).toEqual({
      allow: true,
      locationScope: ["plattsburgh", "oswego"]
    });
  });

  // The branch that makes the approver fallback reachable. If this ever
  // returned allow:true with an empty locationScope instead, the caller would
  // be silently scoped to nothing and 404'd before the fallback could run --
  // which is exactly how the 2026-09-29 bug worked.
  it("REFUSES rather than scoping to nothing when neither grant reaches", () => {
    expect(formScopeFor({ forms: [], locations: [] }, FORM)).toEqual({
      allow: false
    });
    expect(formScopeFor({ forms: [OTHER_FORM], locations: [] }, FORM)).toEqual({
      allow: false
    });
  });

  // The property behind all of the above, stated once over every shape: an
  // allowed caller is never handed the empty scope. A future branch that
  // violates this fails here even if nobody thinks to write its own case.
  it("NEVER returns an allowed-but-empty location scope, for any input", () => {
    const shapes = [
      "all" as const,
      { forms: [FORM], locations: [] },
      { forms: [FORM], locations: ["oswego"] },
      { forms: [], locations: ["oswego"] },
      { forms: [OTHER_FORM], locations: ["oswego"] },
      { forms: [], locations: [] },
      { forms: [OTHER_FORM], locations: [] }
    ];
    for (const scope of shapes) {
      const r = formScopeFor(scope, FORM);
      if (r.allow) {
        expect(r.locationScope).not.toEqual([]);
      }
    }
  });
});

describe("applyLocationScope", () => {
  // Not a bug -- this is the correct fail-closed choice, and pinning it is how
  // the next reader learns that passing [] is never what they want.
  it("maps an EMPTY scope to a match-nothing sentinel, not to unfiltered", () => {
    expect(locationFilter([])).toBe('in.("__no_location__")');
  });

  it("applies no filter at all for undefined", () => {
    expect(locationFilter(undefined)).toBeNull();
  });

  it("filters to the given codes", () => {
    expect(locationFilter(["plattsburgh", "oswego"])).toBe(
      'in.("plattsburgh","oswego")'
    );
  });

  it("quotes a code containing a quote rather than breaking the filter", () => {
    // A broken filter returns FEWER rows rather than erroring, which is the
    // failure direction this codebase keeps getting bitten by.
    expect(locationFilter(['we"ird'])).toBe('in.("we""ird")');
  });
});

// NEXT SUITE, deliberately not attempted here:
//
//   callerMayViewSubmission -- the three view paths (current approver /
//   workflow_history actor / submitter). Needs `authenticate` and
//   `resolveApproverEmails` stubbed, so it wants module mocking rather than the
//   plain imports above. Its 2026-09-21 regression (acting on a ticket revoking
//   the ability to see it) is the single most valuable thing left to pin.
//
//   handleGetSubmission end-to-end -- that a tag-only approver gets 200 and a
//   stranger gets the same refusal shape as a caller with no access at all.
