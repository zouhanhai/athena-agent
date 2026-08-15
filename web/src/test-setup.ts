// vitest setup.
//
// The global auth guard (athenakb.com is public) redirects any page that isn't
// login/register/verify to /login when no session token exists. Navigation
// tests that visit protected pages authenticate themselves via
// `installAuthSession()` (__tests__/helpers/auth-session.ts) right before they
// mount, seeded into the same Pinia instance the router guard reads.
//
// NOTE: we deliberately do NOT seed a session token here. A `beforeEach` in
// this setup file runs BEFORE the test files' own `beforeEach`, so per-test
// `localStorage.clear()` would wipe it before the store reads it — and a
// module-level seed leaks into tests that must stay signed out (and makes
// App.vue's bootstrap() fetch /api/me in jsdom, an unhandled rejection).
