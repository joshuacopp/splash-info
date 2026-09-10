// Brief 129 — footer on every page of the completed-form PDF.
//
// The implementation moved to @splash/pdf-report (the inventory report needs
// the same "Page N of M" stamp). Re-exported here so this directory's callers
// keep importing ./layout-footer.js unchanged.

export { drawFooters } from "@splash/pdf-report";
