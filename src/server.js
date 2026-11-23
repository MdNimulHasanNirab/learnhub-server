require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const Stripe = require("stripe");
const { ObjectId } = require("mongodb");
const { connectDatabase, closeDatabase, collection } = require("./database");
const { verifyToken, verifyRole, verifyRenter, verifyOwner, verifyAdmin, validateBody } = require("./middleware");
const { calculateRental, hasQuantityForPeriod } = require("./utils/rental");
const { roleChangeError } = require("./utils/admin-role");
const { bookingStatusError } = require("./utils/booking-status");
const { escapeRegex } = require("./utils/search");

const app = express();
const port = Number(process.env.PORT || 5000);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const categories = ["Construction Equipment", "Photography Equipment", "Vehicles & Transportation", "Agriculture Equipment", "Electronics", "Event Equipment"];
const rentalTypes = ["daily", "weekly", "monthly"];
const id = (value) => ObjectId.isValid(String(value)) ? new ObjectId(String(value)) : null;
const validImageUrl = (value) => { try { return ["http:", "https:"].includes(new URL(String(value)).protocol); } catch { return false; } };
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const date = (value) => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed; };

app.use(cors({ origin: (process.env.CORS_ORIGINS || process.env.CLIENT_URL || "http://localhost:3000").split(",").map((origin) => origin.trim()), credentials: true }));
// Stripe must receive the unparsed body to validate the webhook signature.
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return fail(res, 503, "Stripe webhook is not configured");
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return fail(res, 400, "Invalid webhook signature"); }
  try {
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      const session = event.data.object;
      if (session.payment_status !== "paid") return res.json({ received: true });
      const bookingId = id(session.metadata?.bookingId);
      if (!bookingId) return fail(res, 400, "Invalid checkout metadata");
      const booking = await collection("bookings").findOne({ _id: bookingId });
      if (!booking || session.currency !== booking.currency || session.amount_total !== Math.round(booking.totalAmount * 100)) return fail(res, 400, "Payment does not match booking");
      await collection("payments").updateOne({ stripeSessionId: session.id }, { $setOnInsert: {
        bookingId, customerId: booking.customerId, ownerId: booking.ownerId, equipmentId: booking.equipmentId,
        stripeSessionId: session.id, stripePaymentIntentId: String(session.payment_intent || ""), amount: booking.totalAmount,
        currency: booking.currency, status: "paid", paidAt: new Date(), createdAt: new Date(),
      } }, { upsert: true });
      await collection("bookings").updateOne({ _id: bookingId, paymentStatus: { $ne: "paid" } }, { $set: { paymentStatus: "paid", status: "confirmed", updatedAt: new Date() } });
    }
    res.json({ received: true });
  } catch (error) { console.error("Stripe webhook fulfillment failed", error); fail(res, 500, "Webhook fulfillment failed"); }
});
app.use(express.json({ limit: "1mb" }));
app.get("/api/health", (_req, res) => ok(res, { message: "Equipment Rental API is running" }));

// Public catalog: search, filters, sorting, pagination and featured limit are database-side.
app.get("/api/equipment", async (req, res, next) => {
  try {
    const query = { status: "approved" };
    const search = String(req.query.search || "").trim().slice(0, 100);
    if (search) query.$or = ["name", "location", "category"].map((field) => ({ [field]: { $regex: escapeRegex(search), $options: "i" } }));
    if (req.query.category) query.category = String(req.query.category);
    if (req.query.rentalType) query.rentalType = String(req.query.rentalType);
    if (req.query.availability === "available") query.availableQuantity = { $gt: 0 };
    if (req.query.availability === "unavailable") query.availableQuantity = 0;
    const min = Number(req.query.minPrice); const max = Number(req.query.maxPrice);
    if (Number.isFinite(min) || Number.isFinite(max)) query.rentalPrice = { ...(Number.isFinite(min) ? { $gte: min } : {}), ...(Number.isFinite(max) ? { $lte: max } : {}) };
    const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(48, Math.max(1, Number(req.query.limit) || 12));
    const sort = req.query.sort === "price-asc" ? { rentalPrice: 1 } : req.query.sort === "price-desc" ? { rentalPrice: -1 } : { createdAt: -1 };
    const [data, total] = await Promise.all([
      collection("equipment").find(query).sort(sort).skip((page - 1) * limit).limit(limit).toArray(),
      collection("equipment").countDocuments(query),
    ]);
    ok(res, { items: data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});
app.get("/api/equipment/featured", async (_req, res, next) => {
  try { ok(res, await collection("equipment").find({ status: "approved" }).sort({ createdAt: -1 }).limit(6).toArray()); } catch (e) { next(e); }
});
app.get("/api/equipment/:id", verifyToken, async (req, res, next) => {
  try {
    const equipmentId = id(req.params.id); if (!equipmentId) return fail(res, 400, "Invalid equipment ID");
    const equipment = await collection("equipment").findOne({ _id: equipmentId });
    if (!equipment) return fail(res, 404, "Equipment not found");
    if (equipment.status !== "approved" && req.user.role !== "admin" && !(req.user.role === "owner" && String(equipment.ownerId) === req.user.id)) return fail(res, 404, "Equipment not found");
    const owner = await collection("users").findOne({ _id: equipment.ownerId }, { projection: { name: 1, image: 1 } });
    ok(res, { ...equipment, owner: owner && { name: owner.name, image: owner.image } });
  } catch (e) { next(e); }
});

app.get("/api/me", verifyToken, async (req, res, next) => { try { ok(res, await collection("users").findOne({ _id: id(req.user.id) }, { projection: { password: 0 } })); } catch (e) { next(e); } });
app.patch("/api/me", verifyToken, async (req, res, next) => {
  try {
    const update = {};
    for (const key of ["name", "image", "phone", "address"]) if (req.body[key] !== undefined) update[key] = String(req.body[key]).trim().slice(0, key === "address" ? 300 : 160);
    if (!Object.keys(update).length) return fail(res, 400, "No profile fields provided");
    await collection("users").updateOne({ _id: id(req.user.id) }, { $set: { ...update, updatedAt: new Date() } });
    ok(res, { ...req.user, ...update });
  } catch (e) { next(e); }
});

app.post("/api/equipment", verifyToken, verifyOwner, validateBody(["name", "description", "category", "location", "rentalPrice", "rentalType", "availableQuantity", "image"]), async (req, res, next) => {
  try {
    const price = Number(req.body.rentalPrice); const quantity = Number(req.body.availableQuantity);
    if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(quantity) || quantity < 1) return fail(res, 400, "Enter a valid price and quantity");
    if (!categories.includes(req.body.category) || !rentalTypes.includes(req.body.rentalType) || !validImageUrl(req.body.image)) return fail(res, 400, "Choose a valid category, rental type and image URL");
    const equipment = { name: String(req.body.name).trim().slice(0, 120), description: String(req.body.description).trim().slice(0, 5000), category: String(req.body.category), location: String(req.body.location), rentalPrice: price, rentalType: String(req.body.rentalType), availableQuantity: quantity, condition: String(req.body.condition || "Good"), brand: String(req.body.brand || ""), model: String(req.body.model || ""), image: String(req.body.image), terms: String(req.body.terms || ""), ownerId: id(req.user.id), status: "pending", createdAt: new Date(), updatedAt: new Date() };
    const result = await collection("equipment").insertOne(equipment); ok(res, { ...equipment, _id: result.insertedId }, 201);
  } catch (e) { next(e); }
});
app.get("/api/owner/equipment", verifyToken, verifyOwner, async (req, res, next) => { try { ok(res, await collection("equipment").find({ ownerId: id(req.user.id) }).sort({ createdAt: -1 }).toArray()); } catch (e) { next(e); } });
app.patch("/api/equipment/:id", verifyToken, verifyRole("owner", "admin"), async (req, res, next) => {
  try {
    const equipmentId = id(req.params.id); if (!equipmentId) return fail(res, 400, "Invalid equipment ID");
    const filter = { _id: equipmentId, ...(req.user.role === "owner" ? { ownerId: id(req.user.id) } : {}) };
    const equipment = await collection("equipment").findOne(filter); if (!equipment) return fail(res, 404, "Equipment not found");
    const update = {};
    for (const key of ["name", "description", "category", "location", "rentalPrice", "rentalType", "availableQuantity", "condition", "brand", "model", "image", "terms"]) if (req.body[key] !== undefined) update[key] = req.body[key];
    if (req.user.role === "admin" && ["pending", "approved", "rejected"].includes(req.body.status)) update.status = req.body.status;
    if (req.user.role === "owner") update.status = "pending";
    if (update.rentalPrice !== undefined && (!Number.isFinite(Number(update.rentalPrice)) || Number(update.rentalPrice) <= 0)) return fail(res, 400, "Invalid rental price");
    if (update.availableQuantity !== undefined && (!Number.isInteger(Number(update.availableQuantity)) || Number(update.availableQuantity) < 0)) return fail(res, 400, "Invalid quantity");
    if (update.category !== undefined && !categories.includes(update.category)) return fail(res, 400, "Invalid category");
    if (update.rentalType !== undefined && !rentalTypes.includes(update.rentalType)) return fail(res, 400, "Invalid rental type");
    if (update.image !== undefined && !validImageUrl(update.image)) return fail(res, 400, "Invalid image URL");
    await collection("equipment").updateOne(filter, { $set: { ...update, updatedAt: new Date() } }); ok(res, { ...equipment, ...update });
  } catch (e) { next(e); }
});
app.delete("/api/equipment/:id", verifyToken, verifyRole("owner", "admin"), async (req, res, next) => {
  try { const filter = { _id: id(req.params.id), ...(req.user.role === "owner" ? { ownerId: id(req.user.id) } : {}) }; const result = await collection("equipment").deleteOne(filter); if (!result.deletedCount) return fail(res, 404, "Equipment not found"); await collection("favorites").deleteMany({ equipmentId: filter._id }); ok(res, { deleted: true }); } catch (e) { next(e); }
});

app.get("/api/favorites", verifyToken, verifyRenter, async (req, res, next) => { try { const favorites = await collection("favorites").aggregate([{ $match: { customerId: id(req.user.id) } }, { $lookup: { from: "equipment", localField: "equipmentId", foreignField: "_id", as: "equipment" } }, { $unwind: "$equipment" }]).toArray(); ok(res, favorites); } catch (e) { next(e); } });
app.post("/api/favorites/:equipmentId", verifyToken, verifyRenter, async (req, res, next) => {
  try { const equipmentId = id(req.params.equipmentId); if (!equipmentId) return fail(res, 400, "Invalid equipment ID"); if (!(await collection("equipment").findOne({ _id: equipmentId, status: "approved" }))) return fail(res, 404, "Equipment not found"); await collection("favorites").updateOne({ customerId: id(req.user.id), equipmentId }, { $setOnInsert: { customerId: id(req.user.id), equipmentId, createdAt: new Date() } }, { upsert: true }); ok(res, { saved: true }, 201); } catch (e) { next(e); }
});
app.delete("/api/favorites/:equipmentId", verifyToken, verifyRenter, async (req, res, next) => { try { await collection("favorites").deleteOne({ customerId: id(req.user.id), equipmentId: id(req.params.equipmentId) }); ok(res, { removed: true }); } catch (e) { next(e); } });

app.post("/api/bookings", verifyToken, verifyRenter, validateBody(["equipmentId", "startDate", "endDate", "quantity", "contactNumber", "deliveryAddress"]), async (req, res, next) => {
  try {
    const equipmentId = id(req.body.equipmentId); const start = date(req.body.startDate); const end = date(req.body.endDate); const quantity = Number(req.body.quantity);
    if (!equipmentId || !start || !end || start < new Date(new Date().setHours(0, 0, 0, 0)) || end <= start || !Number.isInteger(quantity) || quantity < 1) return fail(res, 400, "Check your dates and quantity");
    const equipment = await collection("equipment").findOne({ _id: equipmentId, status: "approved" }); if (!equipment) return fail(res, 404, "Equipment not available");
    const existingBookings = await collection("bookings").find({ equipmentId }).toArray();
    if (!hasQuantityForPeriod({ stock: equipment.availableQuantity, bookings: existingBookings, startDate: start, endDate: end, quantity })) return fail(res, 409, "Requested dates or quantity are not available");
    const { durationDays, totalAmount } = calculateRental({ price: equipment.rentalPrice, rentalType: equipment.rentalType, startDate: start, endDate: end, quantity });
    const booking = { customerId: id(req.user.id), ownerId: equipment.ownerId, equipmentId, startDate: start, endDate: end, quantity, contactNumber: String(req.body.contactNumber).slice(0, 30), deliveryAddress: String(req.body.deliveryAddress).slice(0, 500), notes: String(req.body.notes || "").slice(0, 1000), durationDays, totalAmount, currency: "bdt", paymentStatus: "unpaid", status: "pending_payment", createdAt: new Date(), updatedAt: new Date() };
    const result = await collection("bookings").insertOne(booking); ok(res, { ...booking, _id: result.insertedId }, 201);
  } catch (e) { next(e); }
});
app.get("/api/bookings", verifyToken, async (req, res, next) => {
  try {
    if (!["customer", "owner", "admin"].includes(req.user.role)) return fail(res, 403, "Forbidden");
    const filter = req.user.role === "admin" ? {} : req.user.role === "owner" ? { ownerId: id(req.user.id) } : { customerId: id(req.user.id) };
    const bookings = await collection("bookings").find(filter).sort({ createdAt: -1 }).toArray();
    const data = await Promise.all(bookings.map(async (booking) => {
      const [equipment, customer, owner] = await Promise.all([
        collection("equipment").findOne({ _id: booking.equipmentId }),
        req.user.role === "customer" ? null : collection("users").findOne({ _id: booking.customerId }),
        req.user.role === "customer" ? null : collection("users").findOne({ _id: booking.ownerId }),
      ]);
      return { ...booking, equipmentName: equipment?.name || "Equipment", customer: customer && { name: customer.name, email: customer.email }, owner: owner && { name: owner.name, email: owner.email } };
    }));
    ok(res, data);
  } catch (e) { next(e); }
});
app.get("/api/checkout/:sessionId", verifyToken, verifyRenter, async (req, res, next) => {
  try {
    const payment = await collection("payments").findOne({ stripeSessionId: req.params.sessionId, customerId: id(req.user.id) });
    const booking = await collection("bookings").findOne({ stripeSessionId: req.params.sessionId, customerId: id(req.user.id) });
    if (!payment && !booking) return fail(res, 404, "Checkout session not found");
    ok(res, { paymentStatus: payment?.status || booking?.paymentStatus || "pending", bookingStatus: booking?.status || "pending_payment", equipmentId: booking?.equipmentId });
  } catch (e) { next(e); }
});
app.patch("/api/admin/bookings/:id/status", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const bookingId = id(req.params.id); const booking = bookingId && await collection("bookings").findOne({ _id: bookingId });
    if (!booking) return fail(res, 404, "Booking not found");
    const error = bookingStatusError({ nextStatus: req.body.status, paymentStatus: booking.paymentStatus });
    if (error) return fail(res, error.status, error.message);
    await collection("bookings").updateOne({ _id: bookingId }, { $set: { status: req.body.status, updatedAt: new Date() } });
    ok(res, { status: req.body.status });
  } catch (e) { next(e); }
});
app.post("/api/bookings/:id/checkout", verifyToken, verifyRenter, async (req, res, next) => {
  try { if (!stripe) return fail(res, 503, "Stripe is not configured"); const bookingId = id(req.params.id); const booking = await collection("bookings").findOne({ _id: bookingId, customerId: id(req.user.id) }); if (!booking) return fail(res, 404, "Booking not found"); if (booking.paymentStatus === "paid") return fail(res, 409, "Booking is already paid");
    const equipment = await collection("equipment").findOne({ _id: booking.equipmentId }); if (!equipment) return fail(res, 404, "Equipment not found");
    const session = await stripe.checkout.sessions.create({ mode: "payment", line_items: [{ quantity: 1, price_data: { currency: booking.currency, unit_amount: Math.round(booking.totalAmount * 100), product_data: { name: equipment.name, description: `${booking.durationDays} day rental` } } }], customer_email: req.user.email, success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${process.env.CLIENT_URL}/payment-cancelled`, metadata: { bookingId: String(booking._id) }, idempotencyKey: `booking-${booking._id}` });
    await collection("bookings").updateOne({ _id: bookingId }, { $set: { stripeSessionId: session.id, updatedAt: new Date() } }); ok(res, { url: session.url });
  } catch (e) { next(e); }
});

app.get("/api/admin/users", verifyToken, verifyAdmin, async (_req, res, next) => { try { ok(res, await collection("users").find({}, { projection: { password: 0 } }).sort({ createdAt: -1 }).toArray()); } catch (e) { next(e); } });
app.patch("/api/admin/users/:id/role", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const targetId = id(req.params.id);
    if (!targetId) return fail(res, 400, "Invalid user ID");
    const target = await collection("users").findOne({ _id: targetId });
    if (!target) return fail(res, 404, "User not found");
    const adminCount = target.role === "admin" ? await collection("users").countDocuments({ role: "admin" }) : 0;
    const error = roleChangeError({ actorId: req.user.id, targetId, targetRole: target.role, nextRole: req.body.role, adminCount });
    if (error) return fail(res, error.status, error.message);
    await collection("users").updateOne({ _id: targetId }, { $set: { role: req.body.role, updatedAt: new Date() } });
    ok(res, { updated: true });
  } catch (e) { next(e); }
});
app.get("/api/admin/equipment", verifyToken, verifyAdmin, async (_req, res, next) => { try { ok(res, await collection("equipment").find({}).sort({ createdAt: -1 }).toArray()); } catch (e) { next(e); } });
app.get("/api/analytics/admin", verifyToken, verifyAdmin, async (_req, res, next) => { try { const [users, equipment, bookings, pending, completed, revenue, monthly] = await Promise.all([collection("users").countDocuments({}), collection("equipment").countDocuments({}), collection("bookings").countDocuments({}), collection("equipment").countDocuments({ status: "pending" }), collection("bookings").countDocuments({ status: "completed" }), collection("payments").aggregate([{ $match: { status: "paid" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]).toArray(), collection("bookings").aggregate([{ $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, total: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: 12 }]).toArray()]); ok(res, { users, equipment, bookings, pendingApprovals: pending, completedRentals: completed, totalRevenue: revenue[0]?.total || 0, monthlyBookings: monthly }); } catch (e) { next(e); } });
app.get("/api/analytics/owner", verifyToken, verifyOwner, async (req, res, next) => { try { const ownerId = id(req.user.id); const [listed, completed, earnings, monthly] = await Promise.all([collection("equipment").countDocuments({ ownerId }), collection("bookings").countDocuments({ ownerId, status: "completed" }), collection("payments").aggregate([{ $match: { ownerId, status: "paid" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]).toArray(), collection("payments").aggregate([{ $match: { ownerId, status: "paid" } }, { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$paidAt" } }, total: { $sum: "$amount" } } }, { $sort: { _id: 1 } }, { $limit: 12 }]).toArray()]); ok(res, { listedEquipment: listed, completedRentals: completed, totalEarnings: earnings[0]?.total || 0, monthlyEarnings: monthly }); } catch (e) { next(e); } });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) });
app.post("/api/upload-image", verifyToken, upload.single("image"), async (req, res, next) => { try { if (!req.file) return fail(res, 400, "Choose a JPG, PNG or WebP image under 5 MB"); if (!process.env.IMGBB_API_KEY) return fail(res, 503, "ImgBB is not configured"); const form = new FormData(); form.append("image", req.file.buffer.toString("base64")); const response = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(process.env.IMGBB_API_KEY)}`, { method: "POST", body: form }); const data = await response.json(); if (!response.ok || !data.success) return fail(res, 502, "Image upload failed"); ok(res, { url: data.data.url }); } catch (e) { next(e); } });

app.use((req, res) => fail(res, 404, "API route not found"));
app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.code === "LIMIT_FILE_SIZE" ? 413 : error.status || 500;
  const message = error.code === "LIMIT_FILE_SIZE" ? "Image must be 5 MB or smaller" : error.message || "Internal server error";
  res.status(status).json({ success: false, message });
});
if (require.main === module) connectDatabase().then(() => app.listen(port, () => console.log(`Equipment Rental API listening on ${port}`))).catch((error) => { console.error("Database connection failed", error); process.exit(1); });
process.on("SIGTERM", async () => { await closeDatabase(); process.exit(0); });
module.exports = app;
