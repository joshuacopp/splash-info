// GET /forms/admin/api/action-item-questions
//
// The checklist questions a Parts Directory row can be mapped to, so the part
// editor can offer a picker instead of asking somebody to type a field key.
//
// WHY THIS LIVES HERE AND NOT ON workorders-worker. The parts table belongs to
// splash-workorders, but form schemas belong to splash-forms, and the mapping
// is a fact about a question. Teaching the parts worker to read
// `form_versions.schema` would give a second worker an opinion about what a
// form field is; apps/web already holds bindings to both and is the natural
// place for the join.
//
// PUBLISHED VERSIONS ONLY. A draft's keys can still change under you, and a
// part mapped to a key that never ships answers nothing. Mapping ahead of
// publication is still possible by hand — the column takes any well-formed key
// — this just does not encourage it.
//
// Nothing here is a permission boundary: it returns question labels, which are
// already visible to anyone who can open the form. The admin gate is for
// consistency with its neighbours, not because the payload is sensitive.

import { adminGate, adminGateResponse, requireServiceKey } from "./auth.js";
import { jsonError } from "@splash/http";
import type { Env } from "../index.js";
import type { Field, FormSchema } from "@splash/forms-schema";

interface QuestionGroup {
  form_id: string;
  form_title: string;
  questions: { key: string; label: string }[];
}

/** A question is mappable when it can raise an action item — the same flag the
 *  email and the PDF key off. Display-only types carry no answer to be bad. */
function mappableFields(schema: FormSchema): Field[] {
  return schema.fields.filter(
    (f) =>
      f.action_item_eligible === true && f.type !== "heading" && f.type !== "image"
  );
}

export async function handleListActionItemQuestions(
  env: Env,
  req: Request
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };

  try {
    const formsUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
    formsUrl.searchParams.set("select", "id,title,current_version_id");
    formsUrl.searchParams.set("status", "eq.published");
    formsUrl.searchParams.set("order", "title.asc");
    const formsResp = await fetch(formsUrl.toString(), { headers });
    if (!formsResp.ok) {
      console.error("[forms.ai-questions] forms list failed", formsResp.status);
      return jsonError(500, "list_failed");
    }
    const forms = (await formsResp.json().catch(() => [])) as {
      id: string;
      title: string | null;
      current_version_id: string | null;
    }[];

    const versionIds = forms
      .map((f) => f.current_version_id)
      .filter((v): v is string => typeof v === "string" && v !== "");
    if (versionIds.length === 0) {
      return json({ forms: [] });
    }

    // One query for every published version rather than one per form: the
    // whole point of this endpoint is that it is cheap enough to load with the
    // parts page.
    const versUrl = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
    versUrl.searchParams.set("select", "id,schema");
    versUrl.searchParams.set("id", `in.(${versionIds.join(",")})`);
    const versResp = await fetch(versUrl.toString(), { headers });
    if (!versResp.ok) {
      console.error("[forms.ai-questions] versions failed", versResp.status);
      return jsonError(500, "list_failed");
    }
    const versions = (await versResp.json().catch(() => [])) as {
      id: string;
      schema: FormSchema | null;
    }[];
    const schemaById = new Map(versions.map((v) => [v.id, v.schema]));

    const groups: QuestionGroup[] = [];
    for (const form of forms) {
      const schema = form.current_version_id
        ? schemaById.get(form.current_version_id)
        : null;
      if (!schema || !Array.isArray(schema.fields)) continue;
      const questions = mappableFields(schema).map((f) => ({
        key: f.key,
        label: f.label || f.key
      }));
      // A form with nothing mappable is noise in a picker, not information.
      if (questions.length === 0) continue;
      groups.push({
        form_id: form.id,
        form_title: form.title || "Untitled form",
        questions
      });
    }

    return json({ forms: groups });
  } catch (err) {
    console.error("[forms.ai-questions] threw", err);
    return jsonError(500, "list_failed");
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
