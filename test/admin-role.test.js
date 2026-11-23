const test = require("node:test");
const assert = require("node:assert/strict");
const { roleChangeError } = require("../src/utils/admin-role");

test("admin role changes reject invalid roles and self-demotion", () => {
  assert.equal(roleChangeError({ actorId: "a", targetId: "b", targetRole: "customer", nextRole: "superuser", adminCount: 1 }).status, 400);
  assert.equal(roleChangeError({ actorId: "a", targetId: "a", targetRole: "admin", nextRole: "owner", adminCount: 2 }).status, 409);
});

test("the final administrator cannot be demoted, but earlier admins can", () => {
  assert.equal(roleChangeError({ actorId: "a", targetId: "b", targetRole: "admin", nextRole: "owner", adminCount: 1 }).status, 409);
  assert.equal(roleChangeError({ actorId: "a", targetId: "b", targetRole: "admin", nextRole: "owner", adminCount: 2 }), null);
});
