// Neutralized. The inventory app no longer talks to Supabase from the browser —
// all data access goes through the splash-info worker API (see src/lib/api.js
// and src/lib/data.js), which holds the service key server-side. Nothing imports
// this module after the integration; it is kept only so a stray import fails
// loudly rather than pulling @supabase/supabase-js back into the bundle.
export const IS_DEMO = false
export const supabase = new Proxy(
  {},
  {
    get() {
      throw new Error(
        'Direct Supabase access has been removed from the inventory app. Use src/lib/data.js (worker API) instead.'
      )
    },
  }
)
