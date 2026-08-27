// Public surface of @splash/maintainx — the shared MaintainX REST client.
//
// Caller pattern in workers:
//
//     import { createMaintainXWorkRequest } from "@splash/maintainx";
//     const r = await createMaintainXWorkRequest({
//       title, description, priority: "MEDIUM", locationId,
//       creatorContactInfo: email,
//       apiKey: env.MAINTAINX_API_KEY, baseUrl: env.MAINTAINX_BASE_URL
//     });
//     if (!r.ok) { /* r.error is `MX <status>: <body>` */ }
//
// Consumers:
//   - splash-workorders  read WOs + read/create/upload work requests
//   - splash-damage      create WO (via its own claim -> payload mapper)
//
// Two things every caller must know:
//
//   1. NOTHING HERE THROWS. Every helper returns a result object with `ok`
//      and an `error` string. A `catch` around these calls is dead code; an
//      unchecked `.ok` is a silently swallowed failure.
//   2. THERE IS NO IDEMPOTENCY KEY on any create. Two POSTs make two
//      records. Guarding double-submit is the caller's job.

export {
  ERROR_BODY_MAX_BYTES,
  MAX_PAGE_ITERATIONS
} from "./http.js";

export {
  type RawWorkOrder,
  type FetchInput,
  type FetchResult,
  fetchMaintainXWorkOrders,
  type MaintainXAssignee,
  type CreateWorkOrderInput,
  type CreateWorkOrderResult,
  createMaintainXWorkOrder
} from "./work-orders.js";

export {
  type RawWorkRequest,
  type FetchWorkRequestsInput,
  type FetchWorkRequestsResult,
  fetchMaintainXWorkRequests,
  type CreateWorkRequestInput,
  type CreateWorkRequestResult,
  createMaintainXWorkRequest,
  type UploadWorkRequestFileInput,
  type UploadWorkRequestFileResult,
  uploadMaintainXWorkRequestFile
} from "./work-requests.js";
