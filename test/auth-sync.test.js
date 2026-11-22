const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId, connectDatabase, collection } = require("../src/database");
const { syncUserFromPayload } = require("../src/middleware");

test("user synchronization ignores untrusted token roles and preserves backend role", async () => {
  delete process.env.MONGODB_URI;
  process.env.INITIAL_ADMIN_EMAIL = "first-admin@example.com";
  await connectDatabase();

  const student = await syncUserFromPayload({
    email: "student@example.com",
    name: "Student",
    role: "admin",
  });
  assert.equal(student.role, "student");

  await collection("users").updateOne({ _id: student._id }, { $set: { role: "mentor" } });
  const refreshed = await syncUserFromPayload({ email: "student@example.com", role: "student" });
  assert.equal(refreshed.role, "mentor");

  const admin = await syncUserFromPayload({
    email: "FIRST-ADMIN@example.com",
    role: "student",
  });
  assert.equal(admin.role, "admin");
  assert.ok(admin._id instanceof ObjectId);

  delete process.env.INITIAL_ADMIN_EMAIL;
});
