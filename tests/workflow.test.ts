import test from "node:test";
import assert from "node:assert/strict";
import { validateReviewers, mayDecide } from "../shared/workflow.js";
const assignments = { chemist: "c", compliance: "s", leader: "l" };
const users = Object.entries(assignments).map(([role, id]) => ({
  id,
  roles: [role],
  active: true,
}));
test("专业审核均通过后才能终审", () => {
  assert.equal(
    mayDecide(
      [
        { role: "chemist", status: "approved" },
        { role: "compliance", status: "pending" },
      ],
      "leader",
    ),
    false,
  );
  assert.equal(
    mayDecide(
      [
        { role: "chemist", status: "approved" },
        { role: "compliance", status: "approved" },
      ],
      "leader",
    ),
    true,
  );
});
test("拒绝自审、职责重叠、错角色及停用审核人", () => {
  assert.throws(
    () => validateReviewers("c", "owner", assignments, users),
    /不能审批/,
  );
  assert.throws(
    () => validateReviewers("owner", "c", assignments, users),
    /不能审批/,
  );
  assert.throws(
    () =>
      validateReviewers(
        "owner",
        "owner",
        { ...assignments, leader: "c" },
        users,
      ),
    /不同审核人/,
  );
  assert.throws(
    () =>
      validateReviewers(
        "owner",
        "owner",
        assignments,
        users.map((x) => ({ ...x, active: false })),
      ),
    /未启用/,
  );
  assert.throws(
    () =>
      validateReviewers(
        "owner",
        "owner",
        assignments,
        users.map((x) => ({ ...x, roles: ["engineer"] })),
      ),
    /对应角色/,
  );
  assert.doesNotThrow(() =>
    validateReviewers("owner", "owner", assignments, users),
  );
});
