import type { FastifyRequest } from "fastify";
import type { AuthService } from "../employees/auth.js";
import type { EmployeeRecord } from "../employees/employees.js";

/** Extract the Bearer token from a request, or null. */
function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

/** Resolve the signed-in employee from the request's Bearer token, or null. */
export async function currentEmployee(
  request: FastifyRequest,
  auth: AuthService,
): Promise<EmployeeRecord | null> {
  const token = bearerToken(request);
  if (!token) {
    return null;
  }
  return auth.getEmployeeForSession(token);
}
