import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REMOTE_REF,
  DoneRequiresPushError,
  verifyHeadPushed,
} from "../src/push-guard.js";

/**
 * G4.S8.T18 — done-requires-push guard: HEAD must be reachable on the
 * canonical remote branch (caleo/master) before a done state is accepted.
 */

function fakeRun(script: { fetch?: "ok" | "fail"; ancestor?: boolean; head?: string }) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: string[], _cwd: string): Promise<{ stdout: string; stderr: string }> => {
      calls.push(args);
      if (args[0] === "fetch") {
        if (script.fetch === "fail") throw new Error("network down");
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { stdout: `${script.head ?? "abc123"}\n`, stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        if (script.ancestor === false) throw new Error("not an ancestor");
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  };
}

test("verifyHeadPushed fetches the remote branch and accepts an ancestor HEAD", async () => {
  const fake = fakeRun({ fetch: "ok", ancestor: true, head: "abc123" });
  await verifyHeadPushed({ repoDir: "/repo", run: fake.run });
  assert.deepEqual(fake.calls, [
    ["fetch", "--quiet", "caleo", "master"],
    ["rev-parse", "HEAD"],
    ["merge-base", "--is-ancestor", "HEAD", DEFAULT_REMOTE_REF],
  ]);
});

test("a LOCAL-ONLY commit (not an ancestor) throws DoneRequiresPushError — fail closed", async () => {
  const fake = fakeRun({ fetch: "ok", ancestor: false });
  await assert.rejects(
    () => verifyHeadPushed({ repoDir: "/repo", run: fake.run }),
    (err: unknown) => {
      assert.ok(err instanceof DoneRequiresPushError);
      assert.match(err.message, /caleo\/master/);
      return true;
    },
  );
});

test("a FAILED verification (fetch/network) also blocks done — fail closed", async () => {
  const fake = fakeRun({ fetch: "fail" });
  await assert.rejects(
    () => verifyHeadPushed({ repoDir: "/repo", run: fake.run }),
    DoneRequiresPushError,
  );
});

test("an invalid remoteRef is rejected outright", async () => {
  await assert.rejects(
    () =>
      verifyHeadPushed({
        repoDir: "/repo",
        remoteRef: "justabranch",
        run: async () => ({ stdout: "", stderr: "" }),
      }),
    DoneRequiresPushError,
  );
});
