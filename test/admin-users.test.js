const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAdminUserQuery } = require("../src/utils/admin-users");

test("admin user search matches name or email and escapes regex input", () => {
  const query = buildAdminUserQuery("  name+tag@example.com  ");
  assert.equal(query.$or.length, 2);
  assert.deepEqual(query.$or.map((part) => Object.keys(part)[0]), ["name", "email"]);
  assert.equal(query.$or[1].email.$regex, "name\\+tag@example\\.com");
  assert.deepEqual(buildAdminUserQuery("  "), {});
});
