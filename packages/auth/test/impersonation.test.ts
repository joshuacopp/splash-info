// Run from the repo root:  pnpm exec vitest run packages/auth/test
//
// Covers decideImpersonation, the pure function that holds every rule. The
// I/O around it (grant read, target read, action insert) is thin and is the
// part a staging smoke test exercises.
import { describe, expect, it } from "vitest";
import type { Session } from "@splash/types/session";
import {
  decideImpersonation,
  isWriteRequest,
  sha256Hex,
  newImpersonationToken,
  type ImpersonationGrantRow
} from "../src/impersonation";

const NOW = new Date("2026-10-30T15:00:00Z");

function session(over: Partial<Session> = {}): Session {
  return {
    userId: "u-josh",
    email: "josh@example.com",
    role: "super_admin",
    mustChangePassword: false,
    tools: [],
    locations: [],
    dcRole: null,
    dcLocations: [],
    promoRole: null,
    ...over
  };
}
const josh = session();
const dan = session({
  userId: "u-dan",
  email: "dan@example.com",
  role: "location_admin",
  locations: ["binghamton"],
  mustChangePassword: true
});
function grant(over: Partial<ImpersonationGrantRow> = {}): ImpersonationGrantRow {
  return {
    id: "g1",
    actor_user_id: "u-josh",
    target_user_id: "u-dan",
    mode: "view",
    expires_at: "2026-10-30T15:30:00Z",
    ended_at: null,
    ...over
  };
}
const base = { own: josh, ownAal: "aal2", grant: grant(), target: dan, now: NOW, isWrite: false };

describe("decideImpersonation", () => {
  it("swaps to the target on a read with a good grant", () => {
    const d = decideImpersonation(base);
    expect(d.kind).toBe("impersonate");
    if (d.kind !== "impersonate") return;
    expect(d.session.userId).toBe("u-dan");
    expect(d.session.email).toBe("dan@example.com");
    expect(d.session.locations).toEqual(["binghamton"]);
    expect(d.session.impersonation).toMatchObject({
      grantId: "g1",
      actorUserId: "u-josh",
      actorEmail: "josh@example.com",
      mode: "view"
    });
    expect(d.logWrite).toBe(false);
  });

  it("never marches the operator through the target's forced reset or MFA enrollment", () => {
    const d = decideImpersonation(base);
    if (d.kind !== "impersonate") throw new Error("expected impersonate");
    expect(d.session.mustChangePassword).toBe(false);
    expect(d.session.mfaEnrollment).toBeUndefined();
  });

  it("refuses writes in view mode", () => {
    expect(decideImpersonation({ ...base, isWrite: true })).toEqual({
      kind: "refuse",
      reason: "impersonation_view_only"
    });
  });

  it("allows writes in act mode and asks for them to be logged", () => {
    const d = decideImpersonation({ ...base, grant: grant({ mode: "act" }), isWrite: true });
    expect(d.kind).toBe("impersonate");
    if (d.kind === "impersonate") expect(d.logWrite).toBe(true);
  });

  // Every way a grant goes bad: reads fall back to self, writes are REFUSED --
  // never silently performed as the operator.
  const bad: Array<[string, Partial<typeof base>]> = [
    ["no grant row", { grant: null }],
    ["ended", { grant: grant({ ended_at: "2026-10-30T14:59:00Z" }) }],
    ["expired", { grant: grant({ expires_at: "2026-10-30T14:59:59Z" }) }],
    ["expires exactly now", { grant: grant({ expires_at: NOW.toISOString() }) }],
    ["someone else's grant", { grant: grant({ actor_user_id: "u-noah" }) }],
    ["operator no longer super_admin", { own: session({ role: "location_admin" }) }],
    ["operator token only aal1", { ownAal: "aal1" }],
    ["operator token has no aal", { ownAal: null }],
    ["target has no auth_unified row", { target: null }],
    ["target is a super_admin", { target: session({ userId: "u-dan", role: "super_admin" }) }],
    ["target row does not match grant", { target: session({ userId: "u-other", role: "location_admin" }) }],
    [
      "grant points at the operator",
      { grant: grant({ target_user_id: "u-josh" }), target: session() }
    ]
  ];
  for (const [label, over] of bad) {
    it(`${label}: read continues as self`, () => {
      expect(decideImpersonation({ ...base, ...over })).toEqual({ kind: "own" });
    });
    it(`${label}: write is refused, not performed as self`, () => {
      expect(
        decideImpersonation({ ...base, ...over, grant: over.grant === undefined ? grant({ mode: "act" }) : over.grant, isWrite: true })
      ).toEqual({ kind: "refuse", reason: "impersonation_ended" });
    });
  }
});

describe("isWriteRequest", () => {
  it("treats safe methods as reads", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) expect(isWriteRequest(m, "/x")).toBe(false);
  });
  it("treats other methods as writes", () => {
    for (const m of ["POST", "PATCH", "PUT", "DELETE"]) expect(isWriteRequest(m, "/x")).toBe(true);
  });
  it("lets the listed read-only POSTs through", () => {
    expect(isWriteRequest("POST", "/promo/api/promos/abc/announce/preview")).toBe(false);
    expect(isWriteRequest("POST", "/forms/api/lookup/price-change")).toBe(false);
    expect(isWriteRequest("POST", "/forms/api/packages/price-change")).toBe(false);
  });
  it("is anchored: near-misses are still writes", () => {
    expect(isWriteRequest("POST", "/promo/api/promos/abc/announce")).toBe(true);
    expect(isWriteRequest("POST", "/promo/api/promos/abc/announce/preview/x")).toBe(true);
    expect(isWriteRequest("PATCH", "/forms/api/lookup/price-change")).toBe(true);
  });
});

describe("tokens", () => {
  it("are unique and URL-safe", () => {
    const a = newImpersonationToken();
    const b = newImpersonationToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("hash deterministically to hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
