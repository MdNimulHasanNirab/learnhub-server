const test = require("node:test");
const assert = require("node:assert/strict");

test("public catalog is filtered by the API and excludes unapproved listings", async (t) => {
  // Keep automated tests isolated from the developer's persistent local database.
  process.env.MONGODB_URI = "";
  const { connectDatabase, collection } = require("../src/database");
  const app = require("../src/server");
  await connectDatabase();
  const now = new Date();
  await collection("equipment").insertOne({ name: "Camera kit", location: "Dhaka", category: "Photography Equipment", rentalType: "daily", rentalPrice: 400, availableQuantity: 2, status: "approved", createdAt: now });
  await collection("equipment").insertOne({ name: "Camera pending", location: "Dhaka", category: "Photography Equipment", rentalType: "daily", rentalPrice: 200, availableQuantity: 2, status: "pending", createdAt: now });
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/equipment?search=Dhaka&category=Photography%20Equipment&minPrice=300`);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].name, "Camera kit");
});

test("protected rental endpoint rejects unauthenticated requests", async (t) => {
  const app = require("../src/server");
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bookings`);
  assert.equal(response.status, 401);
});

test("catalog returns sorted database pagination metadata", async (t) => {
  const { collection } = require("../src/database");
  const app = require("../src/server");
  const createdAt = new Date();
  await collection("equipment").insertOne({ name: "Pagination test low", location: "Dhaka", rentalPrice: 100, status: "approved", createdAt });
  await collection("equipment").insertOne({ name: "Pagination test high", location: "Dhaka", rentalPrice: 900, status: "approved", createdAt });
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/equipment?search=pagination%20test&limit=1&sort=price-asc`;
  const first = await (await fetch(`${base}&page=1`)).json();
  const second = await (await fetch(`${base}&page=2`)).json();
  assert.equal(first.data.items[0].name, "Pagination test low");
  assert.equal(second.data.items[0].name, "Pagination test high");
  assert.deepEqual(first.data.pagination, { page: 1, limit: 1, total: 2, pages: 2 });
});
