// vitest setup: global auth for navigation tests.
// athenakb.com is public and the router has a global auth guard — pages that
// aren't login/register/verify redirect to /login when no session token exists.
// Most view/navigation tests mount protected pages, so seed a session token
// before EACH test (setup runs before each test file's own beforeEach, so we
// also re-seed here to survive per-test localStorage.clear()).
import { beforeEach } from "vitest";

function seedSession() {
  if (!localStorage.getItem("athena.session_token")) {
    localStorage.setItem("athena.session_token", "test-session-token");
  }
}

// Seed once at module load (covers tests without their own beforeEach).
seedSession();

// Re-seed before every test (survives per-test localStorage.clear()).
// Tests that specifically exercise signed-out behavior call
// localStorage.clear() AFTER setup and re-mount, so they still work.
beforeEach(() => {
  seedSession();
});
