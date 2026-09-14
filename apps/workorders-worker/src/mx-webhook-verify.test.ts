// Tests for the MaintainX webhook signature gate.
//
// This is the only thing standing between the public internet and a route that
// writes to Postgres, so the negative cases matter more than the positive one.
//
// The known-good vectors below were computed OUTSIDE this codebase, with
// Python's hmac/hashlib, and are pasted in as literals. That is deliberate: a
// test that signs with hmacSha256Hex and then verifies with the same function
// passes even if the encoding is wrong end to end, because the error cancels.
// A fixed external digest cannot cancel.
//
//   secret = "whsec_test_2f8c1a9b4e6d7f0a3c5b8e1d4a7f2c9b"
//   msg    = f"{ts}.{body}"
//   sig    = hmac.new(secret, msg, sha256).hexdigest()

import { describe, expect, it } from "vitest";
import {
  MX_TIMESTAMP_TOLERANCE_SECONDS,
  hmacSha256Hex,
  parseSecrets,
  parseSignatureHeader,
  timingSafeEqualHex,
  verifyMaintainXWebhook
} from "./mx-webhook-verify";

const SECRET = "whsec_test_2f8c1a9b4e6d7f0a3c5b8e1d4a7f2c9b";
const TS = "1757700000";
const BODY =
  '{"workRequestId":13868154,"orgId":152169,"occurredAt":"2026-09-12T18:00:00.000Z"}';
const SIG = "dd9668fb9da4cbbd8217bd75ff3c77e732e8d6edcc185a206c4e10889bba3ae8";
const EMPTY_BODY_SIG =
  "e53a382faf9ed4463a15ef456ce16401903ef8733ecef6bce9ef9b4ea1233649";

/** Just inside the window, so the fixed timestamp above never expires. */
const NOW = Number(TS) + 60;

function header(ts: string, sig: string): string {
  return `t=${ts},v1=${sig}`;
}

describe("hmacSha256Hex", () => {
  it("matches a digest computed outside this codebase", async () => {
    expect(await hmacSha256Hex(SECRET, `${TS}.${BODY}`)).toBe(SIG);
  });

  it("signs the literal dot-join, so an empty body is `<ts>.`", async () => {
    expect(await hmacSha256Hex(SECRET, `${TS}.`)).toBe(EMPTY_BODY_SIG);
  });
});

describe("parseSignatureHeader", () => {
  it("pulls out t and v1", () => {
    expect(parseSignatureHeader(header(TS, SIG))).toEqual({
      timestamp: TS,
      signatures: [SIG]
    });
  });

  it("tolerates whitespace and unknown keys", () => {
    expect(parseSignatureHeader(` t=${TS} , v2=future , v1=${SIG} `)).toEqual({
      timestamp: TS,
      signatures: [SIG]
    });
  });

  it("keeps every v1 so a secret rotation sending two does not lock us out", () => {
    const parsed = parseSignatureHeader(`t=${TS},v1=aaaa,v1=${SIG}`);
    expect(parsed?.signatures).toEqual(["aaaa", SIG]);
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["no t", `v1=${SIG}`],
    ["no v1", `t=${TS}`],
    ["two different timestamps", `t=${TS},t=1,v1=${SIG}`],
    ["not key=value", "garbage"],
    ["empty value", `t=${TS},v1=`]
  ])("rejects malformed header: %s", (_label, raw) => {
    expect(parseSignatureHeader(raw as string | null)).toBeNull();
  });
});

describe("timingSafeEqualHex", () => {
  it("accepts identical strings", () => {
    expect(timingSafeEqualHex(SIG, SIG)).toBe(true);
  });
  it("rejects a one-character difference", () => {
    expect(timingSafeEqualHex(SIG, SIG.slice(0, -1) + "0")).toBe(false);
  });
  it("rejects differing lengths without throwing", () => {
    expect(timingSafeEqualHex(SIG, SIG.slice(0, 10))).toBe(false);
  });
});

describe("verifyMaintainXWebhook", () => {
  const base = { rawBody: BODY, secret: SECRET, nowSeconds: NOW };

  it("accepts a correctly signed delivery", async () => {
    const r = await verifyMaintainXWebhook({
      ...base,
      signatureHeader: header(TS, SIG)
    });
    expect(r).toEqual({ ok: true, timestampSeconds: Number(TS) });
  });

  it("accepts an uppercase hex signature", async () => {
    const r = await verifyMaintainXWebhook({
      ...base,
      signatureHeader: header(TS, SIG.toUpperCase())
    });
    expect(r.ok).toBe(true);
  });

  // --- the cases that matter -------------------------------------------

  it("rejects the wrong secret", async () => {
    const r = await verifyMaintainXWebhook({
      ...base,
      secret: "whsec_not_the_right_one",
      signatureHeader: header(TS, SIG)
    });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a tampered body", async () => {
    // One digit changed in the entity id -- the exact attack the signature
    // exists to stop, since the id is what the receiver re-fetches.
    const r = await verifyMaintainXWebhook({
      ...base,
      rawBody: BODY.replace("13868154", "13868155"),
      signatureHeader: header(TS, SIG)
    });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a body that only differs by whitespace", async () => {
    // Proves the raw bytes are what is verified. A re-serialised body is
    // semantically identical and must still fail.
    const r = await verifyMaintainXWebhook({
      ...base,
      rawBody: JSON.stringify(JSON.parse(BODY), null, 2),
      signatureHeader: header(TS, SIG)
    });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects an expired timestamp", async () => {
    const r = await verifyMaintainXWebhook({
      ...base,
      nowSeconds: Number(TS) + MX_TIMESTAMP_TOLERANCE_SECONDS + 1,
      signatureHeader: header(TS, SIG)
    });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a timestamp exactly at the edge of the window", async () => {
    const r = await verifyMaintainXWebhook({
      ...base,
      nowSeconds: Number(TS) + MX_TIMESTAMP_TOLERANCE_SECONDS,
      signatureHeader: header(TS, SIG)
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a timestamp too far in the future", async () => {
    const r = await verifyMaintainXWebhook({
      ...base,
      nowSeconds: Number(TS) - MX_TIMESTAMP_TOLERANCE_SECONDS - 1,
      signatureHeader: header(TS, SIG)
    });
    expect(r).toEqual({ ok: false, reason: "future_skew" });
  });

  it("tolerates modest clock skew in the future", async () => {
    const r = await verifyMaintainXWebhook({
      ...base,
      nowSeconds: Number(TS) - 30,
      signatureHeader: header(TS, SIG)
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a replay whose timestamp was bumped", async () => {
    // Bumping t to defeat the window changes the signed message, so the
    // signature no longer matches -- the two checks are not independent.
    const bumped = String(Number(TS) + 1000);
    const r = await verifyMaintainXWebhook({
      ...base,
      nowSeconds: Number(bumped) + 60,
      signatureHeader: header(bumped, SIG)
    });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a missing header", async () => {
    const r = await verifyMaintainXWebhook({ ...base, signatureHeader: null });
    expect(r).toEqual({ ok: false, reason: "missing_header" });
  });

  it.each([
    ["garbage", "garbage"],
    ["signature only", SIG],
    ["no v1", `t=${TS}`],
    ["non-numeric t", `t=not-a-number,v1=${SIG}`]
  ])("rejects malformed header: %s", async (_label, raw) => {
    const r = await verifyMaintainXWebhook({ ...base, signatureHeader: raw });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(["malformed_header", "bad_timestamp"]).toContain(r.reason);
    }
  });

  it("refuses to verify when no secret is bound", async () => {
    // An unbound secret must never fall through to "accepted".
    const r = await verifyMaintainXWebhook({
      ...base,
      secret: undefined,
      signatureHeader: header(TS, SIG)
    });
    expect(r).toEqual({ ok: false, reason: "no_secret" });
  });

  it("accepts a millisecond timestamp, since the unit is undocumented", async () => {
    const ms = `${TS}000`;
    const sig = await hmacSha256Hex(SECRET, `${ms}.${BODY}`);
    const r = await verifyMaintainXWebhook({
      ...base,
      signatureHeader: header(ms, sig)
    });
    expect(r).toEqual({ ok: true, timestampSeconds: Number(TS) });
  });
});

// ---------------------------------------------------------------------------
// Multiple signing secrets.
//
// MEASURED 2026-09-14 against the live API: MaintainX issues one secret PER
// SUBSCRIPTION, not per endpoint URL. Seven subscriptions on one URL returned
// seven different secrets. One subscription is one event (the create body is a
// oneOf over single-value enums), so covering seven events means the receiver
// must hold seven keys.
// ---------------------------------------------------------------------------

describe("parseSecrets", () => {
  it.each([
    ["comma", "a,b,c"],
    ["space", "a b c"],
    // Built with String.fromCharCode(10) rather than an escape: this file
    // was generated through shell heredocs, which mangled the escape twice.
    ["newline", ["a", "b", "c"].join(String.fromCharCode(10))],
    ["mixed with padding", " a , b " + String.fromCharCode(10) + " c "]
  ])("splits on %s", (_label, raw) => {
    expect(parseSecrets(raw)).toEqual(["a", "b", "c"]);
  });

  it("treats a lone secret as a one-item list", () => {
    expect(parseSecrets(SECRET)).toEqual([SECRET]);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["separators only", " , , "]
  ])("yields nothing for %s", (_label, raw) => {
    expect(parseSecrets(raw as string | undefined)).toEqual([]);
  });
});

describe("verifyMaintainXWebhook with several secrets", () => {
  // The real shape: MaintainX secrets look like mx_<uuid>_<uuid>.
  const OTHERS = [
    "mx_4976147a-fdf5-47ce-a14c-9b0b74417cfd_27943b37-7a07-467b-a713-28b9e2f894a8",
    "mx_ee008fc0-0217-4c6e-9cff-300361c4e8ac_799350ac-cd11-4c72-ba4e-0eb21c24c0d7"
  ];
  const base = { rawBody: BODY, nowSeconds: NOW, signatureHeader: header(TS, SIG) };

  it("accepts when the matching secret is first", async () => {
    const r = await verifyMaintainXWebhook({ ...base, secret: `${SECRET},${OTHERS[0]}` });
    expect(r.ok).toBe(true);
  });

  it("accepts when the matching secret is last", async () => {
    const r = await verifyMaintainXWebhook({
      ...base,
      secret: `${OTHERS[0]},${OTHERS[1]},${SECRET}`
    });
    expect(r.ok).toBe(true);
  });

  it("accepts when the list is space separated", async () => {
    const r = await verifyMaintainXWebhook({ ...base, secret: `${OTHERS[0]} ${SECRET}` });
    expect(r.ok).toBe(true);
  });

  it("rejects when none of them match", async () => {
    const r = await verifyMaintainXWebhook({ ...base, secret: OTHERS.join(",") });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a separators-only value as no_secret, never as accepted", async () => {
    const r = await verifyMaintainXWebhook({ ...base, secret: " , , " });
    expect(r).toEqual({ ok: false, reason: "no_secret" });
  });

  it("still enforces the window when several secrets are configured", async () => {
    // A valid signature under a known key must not bypass the replay check.
    const r = await verifyMaintainXWebhook({
      ...base,
      secret: `${OTHERS[0]},${SECRET}`,
      nowSeconds: Number(TS) + MX_TIMESTAMP_TOLERANCE_SECONDS + 1
    });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });
});
