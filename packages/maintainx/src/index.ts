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
//
// There are TWO read surfaces here and picking the wrong one is the easy
// mistake to make:
//
//   - `fetchMaintainXWorkOrders` / `fetchMaintainXWorkRequests` are for
//     SERVING. They accumulate, self-cap, and truncate on purpose, because a
//     page render must be bounded.
//   - `fetchWorkOrderPage` / `fetchWorkRequestPage` / `fetchWorkOrderComments`
//     in `./sync.js` are for INGEST. One page per call, no ceiling, caller owns
//     the cursor. Use these when the goal is a complete corpus in Postgres.

export {
  ERROR_BODY_MAX_BYTES,
  MAX_PAGE_ITERATIONS
} from "./http.js";

export {
  type RawWorkOrder,
  type FetchInput,
  type FetchResult,
  ALL_WORK_ORDER_STATUSES,
  fetchMaintainXWorkOrder,
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

export {
  INGEST_PAGE_LIMIT,
  INGEST_EXPAND,
  LIVE_WORK_ORDER_STATUSES,
  CLOSED_WORK_ORDER_STATUSES,
  type WorkOrderSort,
  type RawWorkOrderComment,
  type RetryOptions,
  type FetchWorkOrderPageInput,
  type FetchWorkOrderPageResult,
  fetchWorkOrderPage,
  type FetchWorkOrderCommentsInput,
  type FetchWorkOrderCommentsResult,
  fetchWorkOrderComments,
  type FetchWorkRequestPageInput,
  type FetchWorkRequestPageResult,
  fetchWorkRequestPage
} from "./sync.js";
