// Brief 97 — daily R2 orphan cleanup cron.
//
// Three passes, all fail-soft:
//   1. Orphan submission files: list R2 under `form-submission-files/`,
//      group by `pending_submission_id` (extracted from the path), query
//      Supabase for matching `form_submissions.id` rows, delete R2 objects
//      whose id has no matching row AND whose age > 24h. The 24h grace
//      window covers the gap between out-of-band file uploads (Brief 92)
//      and the eventual submit POST that materializes the row.
//   2. Orphan form assets: list R2 under `form-assets/`, query Supabase
//      for matching `form_assets.r2_key` rows, delete R2 objects with no
//      matching row. Conservative 1h grace window guards against the
//      narrow race where an asset was just uploaded by Brief 94's admin
//      endpoint but the row insert hasn't landed yet (would not happen
//      with the current sequential code path, but defense-in-depth).
//   3. (Brief 129) Orphan submission PDFs: list R2 under
//      `form-submission-pdfs/`, query Supabase for matching
//      `form_submissions.id` rows, delete R2 objects with no matching
//      row. PDFs follow the path `{form_id}/{submission_id}.pdf` so the
//      submission_id is the basename minus extension. When a submission
//      gets deleted via Supabase SQL editor, its PDF follows on the
//      next cron run. PDFs for ACTIVE submissions are never deleted
//      (referenced indefinitely by re-send / re-attach paths).
//
// 11:00 UTC slot picked to avoid colliding with damage-worker's daily
// summary at 13:00 UTC (Brief 65) and workorders-worker's MaintainX
// sync at 11:30 UTC (Brief 71). The triggers definition lives in
// `apps/forms-worker/wrangler.toml`.
//
// Hard pagination caps prevent runaway in pathological cases:
//   - 50 pages × 1000 objects = 50K submission files per run.
//   - 20 pages × 1000 objects = 20K assets per run.
//   - 20 pages × 1000 objects = 20K PDFs per run.
// If the cap is hit, surviving orphans get swept on the next day's run.

import { createServiceClient } from "@splash/db-supabase";
import type { Env } from "../index.js";

const ORPHAN_TTL_HOURS = 24;
const ASSET_GRACE_MS = 60 * 60 * 1000;        // 1h
const PDF_GRACE_MS = 60 * 60 * 1000;          // 1h — match the asset window
const SUBMISSION_HARD_PAGE_CAP = 50;
const ASSET_HARD_PAGE_CAP = 20;
const PDF_HARD_PAGE_CAP = 20;

export interface CleanupResult {
  submissionFilesDeleted: number;
  assetsDeleted: number;
  pdfsDeleted: number;
  submissionPagesScanned: number;
  assetPagesScanned: number;
  pdfPagesScanned: number;
  errors: string[];
}

export async function runDailyCleanup(env: Env): Promise<CleanupResult> {
  const errors: string[] = [];
  const cutoff = new Date(Date.now() - ORPHAN_TTL_HOURS * 60 * 60 * 1000);

  let submissionFilesDeleted = 0;
  let assetsDeleted = 0;
  let pdfsDeleted = 0;
  let submissionPagesScanned = 0;
  let assetPagesScanned = 0;
  let pdfPagesScanned = 0;

  // PASS 1 — orphan submission files
  try {
    const client = createServiceClient(env);
    let cursor: string | undefined;

    do {
      const list = await env.FORMS_FILES.list({
        prefix: "form-submission-files/",
        cursor,
        limit: 1000
      });
      submissionPagesScanned++;

      // Group objects by pending_submission_id (extracted from path).
      // Path shape (Brief 92):
      //   form-submission-files/{form_id}/{pending_submission_id}/{field_key}/{filename}
      // index 0  1                         2                         3            4
      const idToObjects: Map<string, Array<{ key: string }>> = new Map();
      for (const obj of list.objects) {
        if (obj.uploaded > cutoff) continue;          // too recent to be orphan
        const parts = obj.key.split("/");
        if (parts.length < 3 || !parts[2]) continue;  // malformed path
        const pendingId = parts[2];
        let bucket = idToObjects.get(pendingId);
        if (!bucket) {
          bucket = [];
          idToObjects.set(pendingId, bucket);
        }
        bucket.push({ key: obj.key });
      }

      if (idToObjects.size > 0) {
        const ids = Array.from(idToObjects.keys());
        const { data, error } = await client
          .from("form_submissions")
          .select("id")
          .in("id", ids);
        if (error) {
          errors.push(`Supabase form_submissions query failed: ${error.message}`);
          break;
        }
        const knownIds = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));

        for (const [pendingId, objects] of idToObjects.entries()) {
          if (knownIds.has(pendingId)) continue;
          for (const obj of objects) {
            try {
              await env.FORMS_FILES.delete(obj.key);
              submissionFilesDeleted++;
            } catch (e) {
              errors.push(`R2 delete ${obj.key} failed: ${String(e)}`);
            }
          }
        }
      }

      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor && submissionPagesScanned < SUBMISSION_HARD_PAGE_CAP);

    if (submissionPagesScanned >= SUBMISSION_HARD_PAGE_CAP && cursor) {
      errors.push(
        `Submission-files pagination cap hit (${SUBMISSION_HARD_PAGE_CAP} pages); some orphans may remain. Cron will catch them next run.`
      );
    }
  } catch (e) {
    errors.push(`Pass 1 (submission files) crashed: ${String(e)}`);
  }

  // PASS 2 — orphan form assets
  try {
    const client = createServiceClient(env);
    let cursor: string | undefined;

    do {
      const list = await env.FORMS_FILES.list({
        prefix: "form-assets/",
        cursor,
        limit: 1000
      });
      assetPagesScanned++;

      if (list.objects.length > 0) {
        const r2Keys = list.objects.map((o) => o.key);
        const { data, error } = await client
          .from("form_assets")
          .select("r2_key")
          .in("r2_key", r2Keys);
        if (error) {
          errors.push(`Supabase form_assets query failed: ${error.message}`);
          break;
        }
        const knownKeys = new Set(
          ((data ?? []) as Array<{ r2_key: string }>).map((r) => r.r2_key)
        );

        for (const obj of list.objects) {
          if (knownKeys.has(obj.key)) continue;
          // Conservative grace window — avoid racing a freshly uploaded
          // asset whose row insert hasn't landed yet.
          if (Date.now() - obj.uploaded.getTime() < ASSET_GRACE_MS) continue;
          try {
            await env.FORMS_FILES.delete(obj.key);
            assetsDeleted++;
          } catch (e) {
            errors.push(`R2 delete asset ${obj.key} failed: ${String(e)}`);
          }
        }
      }

      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor && assetPagesScanned < ASSET_HARD_PAGE_CAP);

    if (assetPagesScanned >= ASSET_HARD_PAGE_CAP && cursor) {
      errors.push(
        `Assets pagination cap hit (${ASSET_HARD_PAGE_CAP} pages); some orphans may remain. Cron will catch them next run.`
      );
    }
  } catch (e) {
    errors.push(`Pass 2 (assets) crashed: ${String(e)}`);
  }

  // PASS 3 — orphan submission PDFs (Brief 129)
  try {
    const client = createServiceClient(env);
    let cursor: string | undefined;

    do {
      const list = await env.FORMS_FILES.list({
        prefix: "form-submission-pdfs/",
        cursor,
        limit: 1000
      });
      pdfPagesScanned++;

      // Map R2 keys to submission_ids. Path shape:
      //   form-submission-pdfs/{form_id}/{submission_id}.pdf
      // index 0  1                       2
      const keyToSubmissionId: Map<string, string> = new Map();
      for (const obj of list.objects) {
        if (Date.now() - obj.uploaded.getTime() < PDF_GRACE_MS) continue;
        const parts = obj.key.split("/");
        if (parts.length < 3 || !parts[2]) continue;
        const basename = parts[2];
        const subId = basename.endsWith(".pdf")
          ? basename.slice(0, -4)
          : basename;
        if (!subId) continue;
        keyToSubmissionId.set(obj.key, subId);
      }

      if (keyToSubmissionId.size > 0) {
        const ids = Array.from(new Set(keyToSubmissionId.values()));
        const { data, error } = await client
          .from("form_submissions")
          .select("id")
          .in("id", ids);
        if (error) {
          errors.push(`Supabase form_submissions query failed (PDF pass): ${error.message}`);
          break;
        }
        const knownIds = new Set(
          ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
        );

        for (const [key, subId] of keyToSubmissionId.entries()) {
          if (knownIds.has(subId)) continue;
          try {
            await env.FORMS_FILES.delete(key);
            pdfsDeleted++;
          } catch (e) {
            errors.push(`R2 delete PDF ${key} failed: ${String(e)}`);
          }
        }
      }

      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor && pdfPagesScanned < PDF_HARD_PAGE_CAP);

    if (pdfPagesScanned >= PDF_HARD_PAGE_CAP && cursor) {
      errors.push(
        `PDFs pagination cap hit (${PDF_HARD_PAGE_CAP} pages); some orphans may remain. Cron will catch them next run.`
      );
    }
  } catch (e) {
    errors.push(`Pass 3 (PDFs) crashed: ${String(e)}`);
  }

  console.log("[forms.cleanup] complete", {
    submissionFilesDeleted,
    assetsDeleted,
    pdfsDeleted,
    submissionPagesScanned,
    assetPagesScanned,
    pdfPagesScanned,
    errorCount: errors.length
  });
  if (errors.length > 0) {
    console.warn("[forms.cleanup] errors", errors);
  }

  return {
    submissionFilesDeleted,
    assetsDeleted,
    pdfsDeleted,
    submissionPagesScanned,
    assetPagesScanned,
    pdfPagesScanned,
    errors
  };
}
