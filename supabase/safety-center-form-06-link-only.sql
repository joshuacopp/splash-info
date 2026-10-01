-- Safety Center Compliance Checklist -- audience internal -> link-only.
--
-- Status: APPLIED to the live project (rewokyofschtvqgxrxwl) on 2026-10-01.
--
-- `audience` lives on `forms`, not in the version schema, and the render path
-- reads it per request. So this takes effect immediately: NO republish and NO
-- deploy.
--
-- WHAT CHANGES. internal 302s anyone without an `sb-access-token` cookie to
-- /login before the form renders. link-only treats the slug as the gate: anyone
-- holding the URL can fill it, signed in or not.
--
-- WHAT THAT COSTS, stated rather than discovered later. A submission from
-- somebody not signed in carries submitter_email NULL, so:
--   * it will not appear on that person's /admin/my-requests;
--   * the submitter branch of the detail-page view rule cannot match them, so
--     they cannot reopen their own submission -- approvers and admins still
--     can;
--   * nothing in the audit trail names them except what the form itself asks.
--
-- That last point is why this is survivable: `manager` is a required field and
-- the certification carries a signature, so WHO certified is captured in the
-- payload rather than inferred from a session. It is the same guarantee the
-- paper form had.
--
-- NOT CHANGED, deliberately:
--   * turnstile_required stays false. The link goes to named managers; a
--     captcha in front of them is friction without a threat model.
--   * scope_location_field_key stays `site_number`. Unlike the onboarding form,
--     every site filling this one already exists, so scoping is correct and
--     keeps each location's submissions visible to its own admins.
--
-- REVERSIBLE: set audience back to 'internal' and the gate returns on the next
-- render. Submissions already taken are unaffected either way.

update public.forms
   set audience = 'link-only', last_edited_at = now()
 where slug = 'safety-center';

select slug, audience, turnstile_required, scope_location_field_key, status
  from public.forms where slug = 'safety-center';
