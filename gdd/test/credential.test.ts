import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SYNC_EMPLOYEE,
  resolveGithubCredential,
  type EmployeeCredentialReader,
} from "../src/credential.js";

test("resolveGithubCredential: explicit token wins over gh/env/store", async () => {
  const credential = await resolveGithubCredential({
    token: "explicit-token",
    ghToken: "gh-token",
    employeeEmail: "eng@example.com",
    employeeReader: async () => ({ type: "token" as const, value: "store-token" }),
  });
  assert.equal(credential.value, "explicit-token");
});

test("resolveGithubCredential: local gh auth token wins over GITHUB_TOKEN env (local-token-first)", async () => {
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "env-token";
  try {
    const credential = await resolveGithubCredential({ ghToken: "gh-token" });
    assert.equal(credential.value, "gh-token");
    assert.equal(credential.source, "gh");
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previous;
    }
  }
});

test("resolveGithubCredential: falls back to GITHUB_TOKEN when gh auth fails", async () => {
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "env-token";
  try {
    const credential = await resolveGithubCredential({ ghToken: null });
    assert.equal(credential.value, "env-token");
    assert.equal(credential.source, "env");
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previous;
    }
  }
});

test("resolveGithubCredential: no gh, no env → the employee store fallback (when wired)", async () => {
  const previous = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const employeeReader: EmployeeCredentialReader = async (email) => {
    assert.equal(email, "worker@example.com");
    return { type: "token", value: "store-token" };
  };
  try {
    const credential = await resolveGithubCredential({
      ghToken: null,
      employeeEmail: "worker@example.com",
      employeeReader,
    });
    assert.equal(credential.value, "store-token");
    assert.equal(credential.source, "athena-employee");
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previous;
    }
  }
});

test("resolveGithubCredential: default employee email from GITHUB_EMPLOYEE env", async () => {
  const previous = process.env.GITHUB_TOKEN;
  const previousEmployee = process.env.GITHUB_EMPLOYEE;
  delete process.env.GITHUB_TOKEN;
  process.env.GITHUB_EMPLOYEE = "custom@example.com";
  const employeeReader: EmployeeCredentialReader = async (email) => {
    assert.equal(email, "custom@example.com");
    return { type: "token", value: "store-token" };
  };
  try {
    const credential = await resolveGithubCredential({ ghToken: null, employeeReader });
    assert.equal(credential.value, "store-token");
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previous;
    }
    if (previousEmployee === undefined) {
      delete process.env.GITHUB_EMPLOYEE;
    } else {
      process.env.GITHUB_EMPLOYEE = previousEmployee;
    }
  }
});

test("resolveGithubCredential: throws a helpful error when nothing resolves", async () => {
  const previous = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await assert.rejects(
      () => resolveGithubCredential({ ghToken: null, ghEnabled: false }),
      /no GitHub credential.*gh auth token|GITHUB_TOKEN|GITHUB_EMPLOYEE/i,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previous;
    }
  }
});

test("resolveGithubCredential: DEFAULT_SYNC_EMPLOYEE is the athena default employee", () => {
  assert.equal(DEFAULT_SYNC_EMPLOYEE, "zouha108@caleo.com");
});
