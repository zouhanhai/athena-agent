import type { EmployeeRole } from "./employees.js";

export const ALL_PERMISSIONS = [
  "employees.create",
  "employees.update",
  "employees.list",
  "agent.register",
  "agent.update",
  "agent.list",
  "chat",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<EmployeeRole, readonly Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  member: ["agent.list", "chat"],
};

/** Whether a role holds a given permission (RBAC, G3.S2). */
export function roleHasPermission(role: EmployeeRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export class PermissionDeniedError extends Error {}

/** Throws PermissionDeniedError unless the role holds the permission. */
export function assertPermission(role: EmployeeRole, permission: Permission): void {
  if (!roleHasPermission(role, permission)) {
    throw new PermissionDeniedError(`role "${role}" lacks permission "${permission}"`);
  }
}
