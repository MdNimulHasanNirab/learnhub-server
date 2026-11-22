require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const Stripe = require("stripe");
const { connectDatabase, closeDatabase, collection } = require("./database");
const { verifyToken, verifyRole, validateBody } = require("./middleware");

const app = express();
const port = Number(process.env.PORT || 5000);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:3000", credentials: true }));
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ success: false, message: "Stripe webhook is not configured" });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).json({ success: false, message: "Invalid webhook signature" });
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object;
    if (session.payment_status !== "paid") return res.json({ received: true });
    const transactionId = session.id;
    const email = session.metadata?.studentEmail?.toLowerCase();
    const courseId = session.metadata?.courseId;
    if (!email || !courseId || !transactionId) return res.status(400).json({ success: false, message: "Invalid checkout metadata" });
    const course = await collection("courses").findOne({ _id: courseId });
    if (!course || session.currency !== "usd" || Math.round(Number(course.price) * 100) !== session.amount_total) {
      return res.status(400).json({ success: false, message: "Checkout amount does not match the course price" });
    }
    const recordedPayment = await collection("payments").findOne({ transactionId });
    if (!recordedPayment) {
      try {
        await collection("payments").insertOne({
          userEmail: email, courseId, amount: session.amount_total / 100,
          transactionId, paymentIntentId: session.payment_intent, checkoutSessionId: session.id,
          paymentStatus: "paid", provider: "stripe", paidAt: new Date(),
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }
    if (!(await collection("enrollments").findOne({ courseId, studentEmail: email }))) {
      try {
        await collection("enrollments").insertOne({ courseId, studentEmail: email, status: "active", enrolledAt: new Date() });
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }
  }
  res.json({ received: true });
});
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => res.json({ success: true, message: "LearnHub API is running" }));

app.get("/api/courses", async (req, res, next) => {
  try {
    const { search = "", category = "", level = "", page = "1", limit = "12", sort = "newest" } = req.query;
    const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 12));
    let courses = await collection("courses").find({ status: "published" }).toArray();
    courses = courses.filter((course) =>
      (!search || `${course.title} ${course.description}`.toLowerCase().includes(String(search).toLowerCase())) &&
      (!category || course.category === category) &&
      (!level || course.level === level)
    );
    courses.sort((a, b) => sort === "price-asc" ? a.price - b.price : new Date(b.createdAt) - new Date(a.createdAt));
    const total = courses.length;
    res.json({
      success: true,
      data: courses.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
      pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) },
    });
  } catch (error) { next(error); }
});

app.get("/api/courses/:id", async (req, res, next) => {
  try {
    const course = await collection("courses").findOne({ _id: req.params.id });
    if (!course) return res.status(404).json({ success: false, message: "Course not found" });
    if (course.status !== "published") return res.status(404).json({ success: false, message: "Course not found" });
    const mentor = course.mentorEmail ? await collection("users").findOne({ email: course.mentorEmail }) : null;
    res.json({ success: true, data: { ...course, mentorName: mentor?.name || "LearnHub mentor" } });
  } catch (error) { next(error); }
});

app.get("/api/courses/:id/lessons", verifyToken, async (req, res, next) => {
  try {
    const course = await collection("courses").findOne({ _id: req.params.id });
    if (!course) return res.status(404).json({ success: false, message: "Course not found" });
    const isOwner = req.user.role === "mentor" && course.mentorEmail === req.user.email;
    const isEnrolled = await collection("enrollments").findOne({ courseId: req.params.id, studentEmail: req.user.email });
    if (!isOwner && req.user.role !== "admin" && !isEnrolled) {
      return res.status(403).json({ success: false, message: "Enrollment required" });
    }
    const lessons = await collection("lessons").find({ courseId: req.params.id }).toArray();
    lessons.sort((a, b) => a.order - b.order);
    res.json({ success: true, data: lessons });
  } catch (error) { next(error); }
});

app.get("/api/me", verifyToken, async (req, res) => {
  res.json({ success: true, data: req.user });
});

app.patch("/api/me", verifyToken, async (req, res, next) => {
  try {
    const update = {};
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || !req.body.name.trim()) {
        return res.status(400).json({ success: false, message: "Name cannot be empty" });
      }
      update.name = req.body.name.trim().slice(0, 100);
    }
    if (req.body.image !== undefined) {
      if (typeof req.body.image !== "string") return res.status(400).json({ success: false, message: "Invalid image URL" });
      update.image = req.body.image;
    }
    if (!Object.keys(update).length) return res.status(400).json({ success: false, message: "No profile fields provided" });
    await collection("users").updateOne({ email: req.user.email }, { $set: update });
    res.json({ success: true, data: { ...req.user, ...update } });
  } catch (error) { next(error); }
});

app.post("/api/courses", verifyToken, verifyRole("admin", "mentor"), validateBody(["title", "description", "price"]), async (req, res, next) => {
  try {
    if (typeof req.body.title !== "string" || typeof req.body.description !== "string" ||
      !req.body.title.trim() || !req.body.description.trim() ||
      req.body.title.trim().length > 120 || req.body.description.trim().length > 5000) {
      return res.status(400).json({ success: false, message: "Course title or description is invalid" });
    }
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ success: false, message: "Invalid price" });
    if (req.body.status !== undefined && !["draft", "published"].includes(req.body.status)) {
      return res.status(400).json({ success: false, message: "Invalid course status" });
    }
    const mentorEmail = req.user.role === "mentor" ? req.user.email : (req.body.mentorEmail || req.user.email);
    if (req.user.role === "admin" && req.body.mentorEmail) {
      const mentor = await collection("users").findOne({ email: String(req.body.mentorEmail).toLowerCase() });
      if (!mentor || mentor.role !== "mentor") return res.status(400).json({ success: false, message: "Select a registered mentor" });
    }
    const course = {
      title: req.body.title.trim(), description: req.body.description.trim(),
      price, category: req.body.category || "General", level: req.body.level || "Beginner",
      thumbnail: req.body.thumbnail || "", mentorEmail,
      status: req.body.status || "published", createdAt: new Date(),
    };
    const result = await collection("courses").insertOne(course);
    res.status(201).json({ success: true, data: { ...course, _id: result.insertedId } });
  } catch (error) { next(error); }
});

app.patch("/api/courses/:id", verifyToken, verifyRole("admin", "mentor"), async (req, res, next) => {
  try {
    const course = await collection("courses").findOne({ _id: req.params.id });
    if (!course) return res.status(404).json({ success: false, message: "Course not found" });
    if (req.user.role === "mentor" && course.mentorEmail !== req.user.email) return res.status(403).json({ success: false, message: "Forbidden" });
    const allowed = ["title", "description", "price", "category", "level", "thumbnail", "status"];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] === undefined) continue;
      if (["title", "description", "category", "level", "thumbnail", "status"].includes(key) && typeof req.body[key] !== "string") {
        return res.status(400).json({ success: false, message: `Invalid ${key}` });
      }
      update[key] = key === "price" ? Number(req.body[key]) : req.body[key].trim();
    }
    if (update.title !== undefined && (!update.title || update.title.length > 120)) {
      return res.status(400).json({ success: false, message: "Course title must be 1-120 characters" });
    }
    if (update.description !== undefined && (!update.description || update.description.length > 5000)) {
      return res.status(400).json({ success: false, message: "Course description must be 1-5000 characters" });
    }
    if (req.user.role === "admin" && req.body.mentorEmail !== undefined) {
      const email = String(req.body.mentorEmail).toLowerCase();
      const mentor = await collection("users").findOne({ email });
      if (email !== req.user.email && (!mentor || mentor.role !== "mentor")) {
        return res.status(400).json({ success: false, message: "Select a registered mentor" });
      }
      update.mentorEmail = email;
    }
    if (update.price !== undefined && (!Number.isFinite(update.price) || update.price < 0)) {
      return res.status(400).json({ success: false, message: "Invalid course price" });
    }
    if (update.status !== undefined && !["draft", "published"].includes(update.status)) {
      return res.status(400).json({ success: false, message: "Invalid course status" });
    }
    if (!Object.keys(update).length) return res.status(400).json({ success: false, message: "No course fields provided" });
    await collection("courses").updateOne({ _id: req.params.id }, { $set: update });
    res.json({ success: true, data: { ...course, ...update } });
  } catch (error) { next(error); }
});

app.delete("/api/courses/:id", verifyToken, verifyRole("admin", "mentor"), async (req, res, next) => {
  try {
    const course = await collection("courses").findOne({ _id: req.params.id });
    if (!course) return res.status(404).json({ success: false, message: "Course not found" });
    if (req.user.role === "mentor" && course.mentorEmail !== req.user.email) return res.status(403).json({ success: false, message: "Forbidden" });
    await collection("courses").deleteOne({ _id: req.params.id });
    await collection("lessons").deleteMany({ courseId: req.params.id });
    res.json({ success: true, message: "Course deleted" });
  } catch (error) { next(error); }
});

app.get("/api/users", verifyToken, verifyRole("admin"), async (_req, res, next) => {
  try { res.json({ success: true, data: await collection("users").find({}).toArray() }); } catch (error) { next(error); }
});

app.get("/api/admin/courses", verifyToken, verifyRole("admin"), async (_req, res, next) => {
  try { res.json({ success: true, data: await collection("courses").find({}).toArray() }); } catch (error) { next(error); }
});

app.get("/api/mentor/courses", verifyToken, verifyRole("mentor"), async (req, res, next) => {
  try { res.json({ success: true, data: await collection("courses").find({ mentorEmail: req.user.email }).toArray() }); } catch (error) { next(error); }
});

app.patch("/api/users/:id/role", verifyToken, verifyRole("admin"), validateBody(["role"]), async (req, res, next) => {
  try {
    if (!["admin", "mentor", "student"].includes(req.body.role)) return res.status(400).json({ success: false, message: "Invalid role" });
    const target = await collection("users").findOne({ _id: req.params.id });
    if (!target) return res.status(404).json({ success: false, message: "User not found" });
    if (target.email === req.user.email && req.body.role !== "admin") {
      return res.status(400).json({ success: false, message: "You cannot remove your own admin role" });
    }
    await collection("users").updateOne({ _id: req.params.id }, { $set: { role: req.body.role } });
    res.json({ success: true, message: "Role updated" });
  } catch (error) { next(error); }
});

app.post("/api/courses/:id/lessons", verifyToken, verifyRole("admin", "mentor"), validateBody(["title"]), async (req, res, next) => {
  try {
    if (typeof req.body.title !== "string" || !req.body.title.trim() || req.body.title.trim().length > 200) {
      return res.status(400).json({ success: false, message: "Lesson title must be 1-200 characters" });
    }
    const course = await collection("courses").findOne({ _id: req.params.id });
    if (!course) return res.status(404).json({ success: false, message: "Course not found" });
    if (req.user.role === "mentor" && course.mentorEmail !== req.user.email) return res.status(403).json({ success: false, message: "Forbidden" });
    const order = Number(req.body.order || 1);
    if (!Number.isInteger(order) || order < 1) return res.status(400).json({ success: false, message: "Lesson order must be a positive integer" });
    const lesson = { courseId: req.params.id, title: req.body.title.trim(), content: req.body.content || "", videoUrl: req.body.videoUrl || "", order, createdAt: new Date() };
    const result = await collection("lessons").insertOne(lesson);
    res.status(201).json({ success: true, data: { ...lesson, _id: result.insertedId } });
  } catch (error) { next(error); }
});

app.patch("/api/lessons/:id", verifyToken, verifyRole("admin", "mentor"), async (req, res, next) => {
  try {
    const lesson = await collection("lessons").findOne({ _id: req.params.id });
    if (!lesson) return res.status(404).json({ success: false, message: "Lesson not found" });
    const course = await collection("courses").findOne({ _id: lesson.courseId });
    if (!course) return res.status(404).json({ success: false, message: "Course not found" });
    if (req.user.role === "mentor" && course.mentorEmail !== req.user.email) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const update = {};
    for (const key of ["title", "content", "videoUrl"]) {
      if (req.body[key] !== undefined) {
        if (typeof req.body[key] !== "string") return res.status(400).json({ success: false, message: `Invalid ${key}` });
        update[key] = req.body[key].trim();
      }
    }
    if (update.title !== undefined && (!update.title || update.title.length > 200)) {
      return res.status(400).json({ success: false, message: "Lesson title must be 1-200 characters" });
    }
    if (req.body.order !== undefined) {
      const order = Number(req.body.order);
      if (!Number.isInteger(order) || order < 1) {
        return res.status(400).json({ success: false, message: "Lesson order must be a positive integer" });
      }
      update.order = order;
    }
    if (!Object.keys(update).length) return res.status(400).json({ success: false, message: "No lesson fields provided" });
    await collection("lessons").updateOne({ _id: req.params.id }, { $set: update });
    res.json({ success: true, data: { ...lesson, ...update } });
  } catch (error) { next(error); }
});

app.delete("/api/lessons/:id", verifyToken, verifyRole("admin", "mentor"), async (req, res, next) => {
  try {
    const lesson = await collection("lessons").findOne({ _id: req.params.id });
    if (!lesson) return res.status(404).json({ success: false, message: "Lesson not found" });
    const course = await collection("courses").findOne({ _id: lesson.courseId });
    if (req.user.role === "mentor" && course?.mentorEmail !== req.user.email) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    await collection("lessons").deleteOne({ _id: req.params.id });
    res.json({ success: true, message: "Lesson deleted" });
  } catch (error) { next(error); }
});

app.get("/api/enrollments/me", verifyToken, async (req, res, next) => {
  try {
    const enrollments = await collection("enrollments").find({ studentEmail: req.user.email }).toArray();
    const data = await Promise.all(enrollments.map(async (enrollment) => {
      const course = await collection("courses").findOne({ _id: enrollment.courseId });
      const [lessons, progress] = await Promise.all([
        collection("lessons").find({ courseId: enrollment.courseId }).toArray(),
        collection("progress").find({ courseId: enrollment.courseId, studentEmail: req.user.email }).toArray(),
      ]);
      return {
        ...enrollment,
        course,
        progressPercent: lessons.length ? Math.round((progress.length / lessons.length) * 100) : 0,
      };
    }));
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

app.get("/api/mentor/enrollments", verifyToken, verifyRole("mentor"), async (req, res, next) => {
  try {
    const courses = await collection("courses").find({ mentorEmail: req.user.email }).toArray();
    const data = [];
    for (const course of courses) {
      const enrollments = await collection("enrollments").find({ courseId: String(course._id) }).toArray();
      const lessonCount = (await collection("lessons").find({ courseId: String(course._id) }).toArray()).length;
      const students = await Promise.all(enrollments.map(async (enrollment) => {
        const progress = await collection("progress").find({
          courseId: String(course._id),
          studentEmail: enrollment.studentEmail,
        }).toArray();
        return {
          ...enrollment,
          progressPercent: lessonCount ? Math.round((progress.length / lessonCount) * 100) : 0,
        };
      }));
      data.push({ course, enrollments: students });
    }
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

app.post("/api/enrollments", verifyToken, verifyRole("student"), validateBody(["courseId"]), async (req, res, next) => {
  try {
    const course = await collection("courses").findOne({ _id: req.body.courseId });
    if (!course) return res.status(404).json({ success: false, message: "Course not found" });
    if (course.status !== "published") return res.status(404).json({ success: false, message: "Course not found" });
    const existing = await collection("enrollments").findOne({ courseId: req.body.courseId, studentEmail: req.user.email });
    if (existing) return res.json({ success: true, data: existing });
    if (Number(course.price) === 0) {
      const enrollment = { courseId: req.body.courseId, studentEmail: req.user.email, status: "active", enrolledAt: new Date() };
      await collection("enrollments").insertOne(enrollment);
      return res.status(201).json({ success: true, data: enrollment });
    }
    return res.status(402).json({ success: false, message: "Paid course - use Stripe checkout", data: { course } });
  } catch (error) { next(error); }
});

app.get("/api/enrollments/course/:courseId", verifyToken, verifyRole("admin", "mentor"), async (req, res, next) => {
  try {
    const course = await collection("courses").findOne({ _id: req.params.courseId });
    if (!course) return res.status(404).json({ success: false, message: "Course not found" });
    if (req.user.role === "mentor" && course.mentorEmail !== req.user.email) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    res.json({ success: true, data: await collection("enrollments").find({ courseId: req.params.courseId }).toArray() });
  } catch (error) { next(error); }
});

app.post("/api/progress", verifyToken, verifyRole("student"), validateBody(["courseId", "lessonId"]), async (req, res, next) => {
  try {
    const enrollment = await collection("enrollments").findOne({ courseId: req.body.courseId, studentEmail: req.user.email });
    if (!enrollment) return res.status(403).json({ success: false, message: "Enrollment required" });
    const lesson = await collection("lessons").findOne({ _id: req.body.lessonId });
    if (!lesson || lesson.courseId !== req.body.courseId) return res.status(404).json({ success: false, message: "Lesson not found in this course" });
    const progress = { courseId: req.body.courseId, lessonId: req.body.lessonId, studentEmail: req.user.email, completed: true, completedAt: new Date() };
    await collection("progress").updateOne(
      { courseId: req.body.courseId, lessonId: req.body.lessonId, studentEmail: req.user.email },
      { $set: progress },
      { upsert: true }
    );
    res.json({ success: true, data: progress });
  } catch (error) { next(error); }
});

app.get("/api/progress/:courseId", verifyToken, async (req, res, next) => {
  try {
    if (req.user.role === "student") {
      const enrollment = await collection("enrollments").findOne({ courseId: req.params.courseId, studentEmail: req.user.email });
      if (!enrollment) return res.status(403).json({ success: false, message: "Enrollment required" });
      return res.json({
        success: true,
        data: await collection("progress").find({ courseId: req.params.courseId, studentEmail: req.user.email }).toArray(),
      });
    }
    if (req.user.role === "mentor") {
      const course = await collection("courses").findOne({ _id: req.params.courseId });
      if (!course || course.mentorEmail !== req.user.email) return res.status(403).json({ success: false, message: "Forbidden" });
    } else if (req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    res.json({ success: true, data: await collection("progress").find({ courseId: req.params.courseId }).toArray() });
  } catch (error) { next(error); }
});

app.post("/api/checkout", verifyToken, verifyRole("student"), validateBody(["courseId"]), async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ success: false, message: "Stripe is not configured" });
    const course = await collection("courses").findOne({ _id: req.body.courseId });
    if (!course) return res.status(404).json({ success: false, message: "Course not found" });
    if (course.status !== "published") return res.status(404).json({ success: false, message: "Course not found" });
    if (!Number.isFinite(Number(course.price)) || Number(course.price) <= 0) {
      return res.status(400).json({ success: false, message: "Course is not a paid course" });
    }
    const enrolled = await collection("enrollments").findOne({ courseId: req.body.courseId, studentEmail: req.user.email });
    if (enrolled) return res.status(409).json({ success: false, message: "You are already enrolled" });
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: { currency: "usd", unit_amount: Math.round(Number(course.price) * 100), product_data: { name: course.title, description: course.description } },
      }],
      customer_email: req.user.email,
      success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment-cancelled?courseId=${encodeURIComponent(req.body.courseId)}`,
      metadata: { courseId: req.body.courseId, studentEmail: req.user.email },
    });
    res.json({ success: true, data: { url: session.url } });
  } catch (error) { next(error); }
});

app.get("/api/checkout/:sessionId", verifyToken, verifyRole("student"), async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ success: false, message: "Stripe is not configured" });
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    if (session.metadata?.studentEmail?.toLowerCase() !== req.user.email) {
      return res.status(403).json({ success: false, message: "This checkout session does not belong to you" });
    }
    const course = await collection("courses").findOne({ _id: session.metadata.courseId });
    res.json({
      success: true,
      data: {
        paymentStatus: session.payment_status,
        sessionStatus: session.status,
        courseTitle: course?.title || "Course",
        enrolled: Boolean(await collection("enrollments").findOne({
          courseId: session.metadata.courseId,
          studentEmail: req.user.email,
        })),
      },
    });
  } catch (error) { next(error); }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.post("/api/upload-image", verifyToken, upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(req.file.mimetype)) {
      return res.status(400).json({ success: false, message: "A valid JPG, PNG, WebP or GIF image is required" });
    }
    if (!process.env.IMGBB_API_KEY) return res.status(503).json({ success: false, message: "ImgBB is not configured" });
    const form = new FormData();
    form.append("image", req.file.buffer.toString("base64"));
    const response = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(process.env.IMGBB_API_KEY)}`, { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok || !data.success) return res.status(502).json({ success: false, message: "Image upload failed" });
    res.json({ success: true, data: { url: data.data.url, thumbUrl: data.data.thumb?.url } });
  } catch (error) { next(error); }
});

app.use((req, res) => res.status(404).json({ success: false, message: "API route not found" }));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ success: false, message: error.message || "Internal server error" });
});

if (require.main === module) {
  connectDatabase().then(() => {
    app.listen(port, () => console.log(`LearnHub server running on http://localhost:${port}`));
  }).catch((error) => {
    console.error("Database connection failed", error);
    process.exit(1);
  });
  process.on("SIGTERM", async () => { await closeDatabase(); process.exit(0); });
}

module.exports = app;
