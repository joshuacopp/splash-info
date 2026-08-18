// Neutralized. Login is handled by the splash SSO page (/login); the inventory
// app no longer renders its own login form. AuthContext redirects unauthenticated
// users to the splash login page, so App.jsx never mounts this component. Kept
// only so any stray import resolves. If it ever does render, bounce to /login.
export default function Login() {
  if (typeof window !== 'undefined') {
    // `return`, not `next` — /login reads ?return= and silently ignores
    // anything else, which is how this used to dump people on /admin/dashboard.
    window.location.href = '/login?return=' + encodeURIComponent('/inventory')
  }
  return null
}
