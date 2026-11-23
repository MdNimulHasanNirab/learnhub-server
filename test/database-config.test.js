const test = require("node:test");
const assert = require("node:assert/strict");
const { connectDatabase } = require("../src/database");

test("production database configuration fails closed without a Mongo URI", async () => {
  const previousMode = process.env.NODE_ENV;
  const previousUri = process.env.MONGODB_URI;
  process.env.NODE_ENV = "production";
  process.env.MONGODB_URI = "";
  try {
    await assert.rejects(connectDatabase(), /MONGODB_URI is required in production/);
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
    if (previousUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previousUri;
  }
});
