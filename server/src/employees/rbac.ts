import type { EmployeeRole } from "./employees.js";

export const ALL_PERMISSIONS = [
  "employees.create",
  "employees.update",
  "employees.list",
  "employees.invite",
  "agent.register",
  "agent.update",
  "agent.list",
  "chat",
  // G4.S3.T10: wiki edit/save — admin default, grantable to a member.
  "kb.edit",
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

/** The permission-relevant surface of an employee (role + admin-granted extras). */
export interface EmployeePermissionProfile {
  role: EmployeeRole;
  /** Extra permissions an admin granted this employee beyond the role defaults (G4.S3.T10). */
  permissions?: readonly Permission[];
}

/**
 * Whether an EMPLOYEE holds a permission: the role default, OR an admin-granted
 * extra (e.g. a member granted `kb.edit`). This is the per-employee RBAC check —
 * role-only `roleHasPermission` cannot see admin grants (G4.S3.T10).
 */
export function employeeHasPermission(
  employee: EmployeePermissionProfile,
  permission: Permission,
): boolean {
  return roleHasPermission(employee.role, permission) || employee.permissions?.includes(permission) === true;
}

export class PermissionDeniedError extends Error {}

/** Throws PermissionDeniedError unless the role holds the permission. */
export function assertPermission(role: EmployeeRole, permission: Permission): void {
  if (!roleHasPermission(role, permission)) {
    throw new PermissionDeniedError(`role "${role}" lacks permission "${permission}"`);
  }
}

/** Throws PermissionDeniedError unless the EMPLOYEE holds the permission (role default OR admin grant). */
export function assertEmployeePermission(
  employee: EmployeePermissionProfile,
  permission: Permission,
): void {
  if (!employeeHasPermission(employee, permission)) {
    throw new PermissionDeniedError(
      `employee "${employee.role}" lacks permission "${permission}" (not granted by role or by an admin)`,
    );
  }
}
