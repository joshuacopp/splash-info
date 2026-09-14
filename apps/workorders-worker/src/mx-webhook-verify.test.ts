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
