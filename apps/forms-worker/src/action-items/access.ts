// Moved to ../site-access.ts when the SDS list needed the same answer to "who
// is responsible for this site". Re-exported under the original names so the
// action-items handlers read unchanged; there is one implementation, not two.

export {
  resolveSiteAccess as resolveActionItemAccess,
  siteNumberToPricingSite,
  canRead,
  canEdit,
  canVerify,
  type SiteAccess as ActionItemAccess,
  type SiteRole as ActionItemRole
} from "../site-access.js";
