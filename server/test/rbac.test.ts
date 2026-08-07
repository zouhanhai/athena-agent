import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PermissionDeniedError,
  assertPermission,
  roleHasPermission,
  type Permission,
} from "../src/employees/rbac.js";

test("admin role has every permission", () => {
  const permissions: Permission[] = [
    "employees.create",
    "employees.update",
    "employees.list",
    "employees.invite",
    "agent.register",
    "agent.update",
    "agent.list",
    "chat",
  ];
  for (const permission of permissions) {
    assert.equal(roleHasPermission("admin", permission), true, `${permission} should be granted to admin`);
  }
});

test("member role can list agents and chat but cannot manage employees or agents", () => {
  assert.equal(roleHasPermission("member", "agent.list"), true);
  assert.equal(roleHasPermission("member", "chat"), true);
  assert.equal(roleHasPermission("member", "employees.create"), false);
  assert.equal(roleHasPermission("member", "employees.update"), false);
  assert.equal(roleHasPermission("member", "employees.list"), false);
  assert.equal(roleHasPermission("member", "employees.invite"), false);
  assert.equal(roleHasPermission("member", "agent.register"), false);
  assert.equal(roleHasPermission("member", "agent.update"), false);
});

test("assertPermission passes when the role holds the permission", () => {
  assert.doesNotThrow(() => assertPermission("admin", "employees.create"));
  assert.doesNotThrow(() => assertPermission("member", "agent.list"));
});

test("assertPermission throws PermissionDeniedError when the role lacks the permission", () => {
  assert.throws(() => assertPermission("member", "employees.create"), PermissionDeniedError);
  assert.throws(() => assertPermission("member", "agent.register"), PermissionDeniedError);
});
