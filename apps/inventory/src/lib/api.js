// Thin fetch helper for the inventory worker API.
//
// All calls are same-origin under /inventory/api/* and rely on the host-only
// sb-access-token SSO cookie (credentials: 'include') — the worker
// authenticates the session and scopes every response. A 401 is surfaced with
// err.status = 401 so AuthContext can redirect to the splash login page.
const API_BASE = '/inventory/api'

async function req(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `Request failed (${res.status})`
    try {
      const j = await res.json()
      if (j && j.error) msg = j.error
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  if (res.status === 204) return null
  try {
    return await res.json()
  } catch {
    return null
  }
}

export const apiGet = (path) => req(path)
export const apiPost = (path, body) => req(path, { method: 'POST', body })
export const apiPut = (path, body) => req(path, { method: 'PUT', body })
export const apiDelete = (path, body) => req(path, { method: 'DELETE', body })

// Multipart POST — currently only the MaintainX request form, which carries
// photos. Deliberately NOT routed through req(): that helper JSON-encodes the
// body and sets content-type, and a FormData body must go through untouched so
// the browser can generate the multipart boundary header itself. Setting
// content-type by hand here would omit the boundary and the worker's
// request.formData() would fail to parse.
export async function apiPostForm(path, formData) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  })
  if (!res.ok) {
    let msg = `Request failed (${res.status})`
    try {
      const j = await res.json()
      if (j && j.error) msg = j.error
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  try {
    return await res.json()
  } catch {
    return null
  }
}
