const { MongoClient, ObjectId } = require("mongodb");

const state = {
  client: null,
  db: null,
  memory: false,
  collections: new Map(),
};

const seedCourses = [
  {
    _id: new ObjectId(),
    title: "Complete Web Development",
    description: "Build modern full-stack web applications from fundamentals to deployment.",
    category: "Development",
    level: "Beginner",
    price: 49,
    thumbnail: "https://images.unsplash.com/photo-1498050108023-c5249f4df085",
    mentorEmail: null,
    status: "published",
    createdAt: new Date(),
  },
];

function collection(name) {
  if (!state.memory) {
    const mongoCollection = state.db.collection(name);
    const normalize = (query = {}) => {
      const normalized = { ...query };
      if (normalized._id && typeof normalized._id === "string" && ObjectId.isValid(normalized._id)) {
        normalized._id = new ObjectId(normalized._id);
      }
      return normalized;
    };
    return {
      find: (query = {}) => mongoCollection.find(normalize(query)),
      findOne: (query = {}) => mongoCollection.findOne(normalize(query)),
      insertOne: (doc) => mongoCollection.insertOne(doc),
      updateOne: (query, update, options) => mongoCollection.updateOne(normalize(query), update, options),
      deleteOne: (query) => mongoCollection.deleteOne(normalize(query)),
      deleteMany: (query) => mongoCollection.deleteMany(normalize(query)),
    };
  }
  if (!state.collections.has(name)) state.collections.set(name, []);
  return {
    find: (query = {}) => ({
      sort: () => ({ toArray: async () => state.collections.get(name).filter((item) => matches(item, query)) }),
      limit: () => ({ toArray: async () => state.collections.get(name).filter((item) => matches(item, query)).slice(0, 50) }),
      toArray: async () => state.collections.get(name).filter((item) => matches(item, query)),
    }),
    findOne: async (query) => state.collections.get(name).find((item) => matches(item, query)) || null,
    insertOne: async (doc) => {
      const inserted = { ...doc, _id: doc._id || new ObjectId() };
      state.collections.get(name).push(inserted);
      return { insertedId: inserted._id };
    },
    updateOne: async (query, update, options = {}) => {
      const index = state.collections.get(name).findIndex((item) => matches(item, query));
      if (index < 0 && update.$set && options.upsert) {
        const inserted = { ...query, ...update.$set, _id: new ObjectId() };
        state.collections.get(name).push(inserted);
        return { matchedCount: 0, upsertedCount: 1 };
      }
      if (index < 0) return { matchedCount: 0 };
      const doc = state.collections.get(name)[index];
      state.collections.get(name)[index] = { ...doc, ...(update.$set || {}) };
      if (update.$inc) {
        for (const [key, value] of Object.entries(update.$inc)) {
          doc[key] = (doc[key] || 0) + value;
        }
      }
      return { matchedCount: 1 };
    },
    deleteOne: async (query) => {
      const index = state.collections.get(name).findIndex((item) => matches(item, query));
      if (index < 0) return { deletedCount: 0 };
      state.collections.get(name).splice(index, 1);
      return { deletedCount: 1 };
    },
    deleteMany: async (query) => {
      const items = state.collections.get(name);
      const remaining = items.filter((item) => !matches(item, query));
      const deletedCount = items.length - remaining.length;
      state.collections.set(name, remaining);
      return { deletedCount };
    },
  };
}

function matches(doc, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "_id" && doc[key]) return String(doc[key]) === String(value);
    if (value instanceof ObjectId) return String(doc[key]) === String(value);
    if (value && typeof value === "object" && value.$regex) {
      const flags = value.$options || "";
      return new RegExp(value.$regex, flags).test(String(doc[key] || ""));
    }
    return doc[key] === value;
  });
}

async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    state.memory = true;
    state.collections.set("courses", seedCourses);
    console.warn("MONGODB_URI is not set; using the development memory database.");
    return;
  }
  state.client = new MongoClient(process.env.MONGODB_URI);
  await state.client.connect();
  state.db = state.client.db(process.env.MONGODB_DB_NAME || "learnhub");

  await Promise.all([
    state.db.collection("users").createIndex({ email: 1 }, { unique: true }),
    state.db.collection("courses").createIndex({ mentorEmail: 1, status: 1 }),
    state.db.collection("lessons").createIndex({ courseId: 1, order: 1 }),
    state.db.collection("enrollments").createIndex({ studentEmail: 1, courseId: 1 }, { unique: true }),
    state.db.collection("progress").createIndex({ studentEmail: 1, courseId: 1, lessonId: 1 }, { unique: true }),
    state.db.collection("payments").createIndex({ transactionId: 1 }, { unique: true }),
  ]);
}

async function closeDatabase() {
  if (state.client) await state.client.close();
}

module.exports = { connectDatabase, closeDatabase, collection, ObjectId };
