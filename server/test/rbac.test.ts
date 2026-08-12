import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PermissionDeniedError,
  assertEmployeePermission,
  assertPermission,
  employeeHasPermission,
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
    "kb.edit",
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

test("kb.edit is NOT granted to a member by default but an admin can grant it", () => {
  assert.equal(roleHasPermission("member", "kb.edit"), false, "member lacks kb.edit by default");
  assert.equal(employeeHasPermission({ role: "member" }, "kb.edit"), false);
  assert.equal(
    employeeHasPermission({ role: "member", permissions: ["kb.edit"] }, "kb.edit"),
    true,
    "a granted permission overrides the role default",
  );
  // admin needs no grant — role default covers it even without a permissions list.
  assert.equal(employeeHasPermission({ role: "admin" }, "kb.edit"), true);
});

test("assertEmployeePermission passes for admin and for a granted member", () => {
  assert.doesNotThrow(() => assertEmployeePermission({ role: "admin" }, "kb.edit"));
  assert.doesNotThrow(() =>
    assertEmployeePermission({ role: "member", permissions: ["kb.edit"] }, "kb.edit"),
  );
});

test("assertEmployeePermission throws PermissionDeniedError for a member without the grant", () => {
  assert.throws(
    () => assertEmployeePermission({ role: "member" }, "kb.edit"),
    PermissionDeniedError,
  );
  assert.throws(
    () => assertEmployeePermission({ role: "member", permissions: [] }, "kb.edit"),
    PermissionDeniedError,
  );
});

test("assertPermission passes when the role holds the permission", () => {
  assert.doesNotThrow(() => assertPermission("admin", "employees.create"));
  assert.doesNotThrow(() => assertPermission("member", "agent.list"));
});

test("assertPermission throws PermissionDeniedError when the role lacks the permission", () => {
  assert.throws(() => assertPermission("member", "employees.create"), PermissionDeniedError);
  assert.throws(() => assertPermission("member", "agent.register"), PermissionDeniedError);
});
