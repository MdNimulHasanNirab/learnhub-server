const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId, connectDatabase, collection } = require("../src/database");
const { syncUserFromPayload, verifyRole } = require("../src/middleware");

test("new users default to customer and token role claims cannot override stored roles", async () => {
  delete process.env.MONGODB_URI;
  process.env.INITIAL_ADMIN_EMAIL = "first-admin@example.com";
  await connectDatabase();
  const customer = await syncUserFromPayload({ email: "customer@example.com", name: "Customer", role: "admin" });
  assert.equal(customer.role, "customer");
  await collection("users").updateOne({ _id: customer._id }, { $set: { role: "owner" } });
  const existing = await syncUserFromPayload({ email: "customer@example.com", role: "customer" });
  assert.equal(existing.role, "owner");
  const admin = await syncUserFromPayload({ email: "FIRST-ADMIN@example.com", role: "customer" });
  assert.equal(admin.role, "admin");
  assert.ok(admin._id instanceof ObjectId);
  delete process.env.INITIAL_ADMIN_EMAIL;
});

test("role middleware returns 403 for an authenticated user without permission", () => {
  let status; let body; let called = false;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  verifyRole("admin")({ user: { role: "customer" } }, res, () => { called = true; });
  assert.equal(status, 403);
  assert.equal(body.message, "Forbidden");
  assert.equal(called, false);
});

test("token middleware rejects requests without a bearer token", async () => {
  const { verifyToken } = require("../src/middleware");
  let status; let body; let nextCalled = false;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await verifyToken({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(status, 401);
  assert.equal(body.message, "Unauthorized");
  assert.equal(nextCalled, false);
});

test("request validation reports required fields before handlers run", () => {
  const { validateBody } = require("../src/middleware");
  let status; let body; let nextCalled = false;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  validateBody(["name", "category"])({ body: { name: "Camera" } }, res, () => { nextCalled = true; });
  assert.equal(status, 400);
  assert.equal(body.message, "Missing fields: category");
  assert.equal(nextCalled, false);
});
