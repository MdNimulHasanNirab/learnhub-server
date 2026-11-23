const { MongoClient, ObjectId } = require("mongodb");

const state = { client: null, db: null, connecting: null, memory: new Map() };
function matches(doc, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some((part) => matches(doc, part));
    const actual = doc[key];
    if (expected && typeof expected === "object" && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
      if (expected.$regex && !(new RegExp(expected.$regex, expected.$options || "")).test(String(actual || ""))) return false;
      if (expected.$gt !== undefined && !(actual > expected.$gt)) return false;
      if (expected.$gte !== undefined && !(actual >= expected.$gte)) return false;
      if (expected.$lt !== undefined && !(actual < expected.$lt)) return false;
      if (expected.$lte !== undefined && !(actual <= expected.$lte)) return false;
      if (expected.$ne !== undefined && actual === expected.$ne) return false;
      if (Object.keys(expected).some((operator) => !["$regex", "$options", "$gt", "$gte", "$lt", "$lte", "$ne"].includes(operator))) return JSON.stringify(actual) === JSON.stringify(expected);
      return true;
    }
    return actual instanceof ObjectId || expected instanceof ObjectId ? String(actual) === String(expected) : actual === expected;
  });
}
function memoryCollection(name) {
  if (!state.memory.has(name)) state.memory.set(name, []);
  const rows = () => state.memory.get(name);
  const cursor = (query = {}) => {
    let result = rows().filter((row) => matches(row, query));
    const api = {
      sort(order) { result = [...result].sort((a, b) => { for (const [key, direction] of Object.entries(order || {})) { const cmp = a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0; if (cmp) return cmp * direction; } return 0; }); return api; },
      skip(amount) { result = result.slice(amount); return api; },
      limit(amount) { result = result.slice(0, amount); return api; },
      async toArray() { return result; },
    };
    return api;
  };
  return {
    find: cursor,
    async findOne(query) { return rows().find((row) => matches(row, query)) || null; },
    async countDocuments(query = {}) { return rows().filter((row) => matches(row, query)).length; },
    async insertOne(doc) { const inserted = { ...doc, _id: doc._id || new ObjectId() }; rows().push(inserted); return { insertedId: inserted._id }; },
    async updateOne(query, update, options = {}) {
      const index = rows().findIndex((row) => matches(row, query));
      if (index < 0 && options.upsert) { const row = { ...query, ...(update.$setOnInsert || {}), ...(update.$set || {}), _id: new ObjectId() }; rows().push(row); return { matchedCount: 0, upsertedCount: 1 }; }
      if (index < 0) return { matchedCount: 0 };
      const row = rows()[index]; Object.assign(row, update.$set || {});
      for (const [key, amount] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + amount;
      return { matchedCount: 1 };
    },
    async deleteOne(query) { const index = rows().findIndex((row) => matches(row, query)); if (index < 0) return { deletedCount: 0 }; rows().splice(index, 1); return { deletedCount: 1 }; },
    async deleteMany(query) { const remaining = rows().filter((row) => !matches(row, query)); const count = rows().length - remaining.length; state.memory.set(name, remaining); return { deletedCount: count }; },
    aggregate(pipeline) { return { async toArray() { let data = rows(); for (const stage of pipeline) { if (stage.$match) data = data.filter((row) => matches(row, stage.$match)); if (stage.$group) { const key = stage.$group._id; const grouped = new Map(); for (const row of data) { const groupKey = key && typeof key === "object" ? Object.values(key)[0] : key; const k = typeof groupKey === "object" && groupKey.$dateToString ? new Date(row.createdAt || row.paidAt).toISOString().slice(0, 7) : row[key?.slice?.(1)] ?? null; if (!grouped.has(k)) grouped.set(k, { _id: k }); for (const [field, expr] of Object.entries(stage.$group)) if (field !== "_id" && expr.$sum !== undefined) grouped.get(k)[field] = (grouped.get(k)[field] || 0) + (expr.$sum === 1 ? 1 : row[expr.$sum.slice(1)] || 0); } data = [...grouped.values()]; } if (stage.$sort) data.sort((a, b) => String(a._id).localeCompare(String(b._id)) * (stage.$sort._id || 1)); if (stage.$limit) data = data.slice(0, stage.$limit); if (stage.$lookup) data = data.map((row) => ({ ...row, [stage.$lookup.as]: (state.memory.get(stage.$lookup.from) || []).filter((joined) => String(joined[stage.$lookup.foreignField]) === String(row[stage.$lookup.localField])) })); if (stage.$unwind) { const field = stage.$unwind.slice(1); data = data.flatMap((row) => (row[field] || []).map((joined) => ({ ...row, [field]: joined }))); } } return data; } }; },
  };
}
function collection(name) { return state.db ? state.db.collection(name) : memoryCollection(name); }
async function connectDatabase() {
  if (state.db) return state.db;
  if (state.connecting) return state.connecting;
  if (!process.env.MONGODB_URI) {
    if (process.env.NODE_ENV === "production") throw new Error("MONGODB_URI is required in production");
    console.warn("MONGODB_URI is missing; using ephemeral development storage."); return;
  }
  state.connecting = (async () => {
    const client = new MongoClient(process.env.MONGODB_URI);
    try {
      await client.connect();
      const db = client.db(process.env.MONGODB_DB_NAME || "equipment_rental");
      await Promise.all([
        db.collection("users").createIndex({ email: 1 }, { unique: true }),
        db.collection("equipment").createIndex({ status: 1, category: 1, rentalType: 1, rentalPrice: 1, createdAt: -1 }),
        db.collection("equipment").createIndex({ name: "text", location: "text" }),
        db.collection("equipment").createIndex({ ownerId: 1, createdAt: -1 }),
        db.collection("bookings").createIndex({ customerId: 1, createdAt: -1 }),
        db.collection("bookings").createIndex({ ownerId: 1, createdAt: -1 }),
        db.collection("favorites").createIndex({ customerId: 1, equipmentId: 1 }, { unique: true }),
        db.collection("payments").createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true }),
        db.collection("payments").createIndex({ stripePaymentIntentId: 1 }, { unique: true, sparse: true }),
      ]);
      state.client = client;
      state.db = db;
      return db;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    } finally {
      state.connecting = null;
    }
  })();
  return state.connecting;
}
async function closeDatabase() { if (state.client) await state.client.close(); }
module.exports = { connectDatabase, closeDatabase, collection, ObjectId };
