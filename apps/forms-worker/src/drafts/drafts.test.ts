import { describe, expect, it } from "vitest";
import { cleanDraftValues, isAllowedDraftEmail, maskEmail, renderDraftEmail } from "./index";

describe("save and continue later", () => {
  it("only sends resume links to Splash addresses", () => {
    expect(isAllowedDraftEmail("Pat.Smith@SplashCarWashes.com")).toBe(true);
    expect(isAllowedDraftEmail("pat@gmail.com")).toBe(false);
    expect(isAllowedDraftEmail("pat@splashcarwashes.com.evil.io")).toBe(false);
    expect(isAllowedDraftEmail("pat@sub.splashcarwashes.com")).toBe(false);
    expect(isAllowedDraftEmail("not an email")).toBe(false);
  });

  it("masks the address shown on a shared tablet", () => {
    expect(maskEmail("pat.smith@splashcarwashes.com")).toBe("p***@splashcarwashes.com");
  });

  it("never stores the draft token, pending id or Turnstile response", () => {
    const v = cleanDraftValues({
      employee: "Pat",
      reasons: ["fired"],
      _draft_token: "secret",
      pending_submission_id: "x",
      "cf-turnstile-response": "t",
      weird: { nested: 1 },
      n: 5
    });
    expect(v).toEqual({ employee: "Pat", reasons: ["fired"] });
  });

  it("refuses non-objects", () => {
    expect(cleanDraftValues(null)).toBeNull();
    expect(cleanDraftValues(["a"])).toBeNull();
    expect(cleanDraftValues("x")).toBeNull();
  });

  it("keeps anything typed into the form out of the email subject", () => {
    const m = renderDraftEmail({
      title: "Employee Termination Report",
      url: "https://splashcarwashes.info/forms/resume/abc",
      expiresAt: "2026-11-29T15:00:00Z"
    });
    expect(m.subject).toBe("Continue your form: Employee Termination Report");
    expect(m.text).toContain("https://splashcarwashes.info/forms/resume/abc");
    expect(m.html).toContain("forward this email");
  });
});
