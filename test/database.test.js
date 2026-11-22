const test = require("node:test");
const assert = require("node:assert/strict");

test("seed course is available in development memory database", async () => {
  delete process.env.MONGODB_URI;
  const { connectDatabase, collection } = require("../src/database");
  await connectDatabase();
  const courses = await collection("courses").find({ status: "published" }).toArray();
  assert.equal(courses.length, 1);
  assert.equal(courses[0].title, "Complete Web Development");
});
