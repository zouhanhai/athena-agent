import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROLE_IDS,
  ROLE_STAGES,
  ROLES,
  roleSoul,
  PLANNING_OWNER,
  type RoleId,
  type RoleStage,
  type RoleSoul,
} from "../src/kanban/index.js";

test("exactly the 6 spec roles are defined, in lifecycle order", () => {
  assert.deepEqual(ROLE_IDS, [
    "consultant",
    "pm",
    "eng-director",
    "worker",
    "reviewer",
    "writer",
  ]);
});

test("every role soul carries a distinct id, name, duty, stages and output", () => {
  for (const id of ROLE_IDS) {
    const soul: RoleSoul | undefined = ROLES[id];
    assert.ok(soul, `ROLES.${id} is defined`);
    assert.equal(soul.id, id);
    assert.ok(soul.name.length > 0, `${id}.name`);
    assert.ok(soul.duty.length > 0, `${id}.duty`);
    assert.ok(soul.stages.length > 0, `${id}.stages`);
    assert.ok(soul.output.length > 0, `${id}.output`);
    for (const stage of soul.stages) {
      assert.ok((ROLE_STAGES as readonly string[]).includes(stage), `unknown stage ${stage}`);
    }
  }
  assert.equal(new Set(ROLE_IDS.map((id) => ROLES[id].name)).size, 6, "names distinct");
  assert.equal(new Set(ROLE_IDS.map((id) => ROLES[id].duty)).size, 6, "duties distinct");
});

test("role souls carry the responsibilities from the requirements table", () => {
  assert.match(ROLES.consultant.duty, /grill/i);
  assert.match(ROLES.pm.duty, /to-spec/i);
  assert.match(ROLES["eng-director"].duty, /to-ticket/i);
  assert.match(ROLES["eng-director"].duty, /re-decompose/i);
  assert.match(ROLES.worker.duty, /claim/i);
  assert.match(ROLES.reviewer.duty, /approve|reject/i);
  assert.match(ROLES.writer.duty, /docs|pr/i);
});

test("roles live at the right lifecycle stage", () => {
  assert.ok(ROLES.consultant.stages.includes("pre-plan"));
  assert.ok(ROLES.pm.stages.includes("planning"));
  assert.ok(ROLES["eng-director"].stages.includes("planning"));
  assert.ok(ROLES["eng-director"].stages.includes("rework"));
  assert.ok(ROLES.worker.stages.includes("execution"));
  assert.ok(ROLES.reviewer.stages.includes("review"));
  assert.ok(ROLES.writer.stages.includes("wrap-up"));
});

test("roleSoul looks up a soul and throws for an unknown role", () => {
  assert.equal(roleSoul("worker"), ROLES.worker);
  assert.throws(() => roleSoul("spy" as RoleId), /unknown role/i);
});

test("PLANNING_OWNER maps each planning layer to its role soul", () => {
  assert.equal(PLANNING_OWNER.goal, "consultant");
  assert.equal(PLANNING_OWNER.spec, "pm");
  assert.equal(PLANNING_OWNER.ticket, "eng-director");
  for (const role of Object.values(PLANNING_OWNER)) {
    assert.ok(ROLE_IDS.includes(role), `${role} is a known role`);
  }
  assert.ok((ROLE_STAGES as readonly string[]).includes("pre-plan" as RoleStage));
});
