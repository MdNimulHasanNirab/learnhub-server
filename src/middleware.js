const { createRemoteJWKSet, jwtVerify } = require("jose");
const { collection } = require("./database");

const jwksByUrl = new Map();

function getJwks(url) {
  if (!jwksByUrl.has(url)) jwksByUrl.set(url, createRemoteJWKSet(new URL(url)));
  return jwksByUrl.get(url);
}

async function syncUserFromPayload(payload) {
  const email = payload.email?.toLowerCase();
  if (!email) return null;

  let user = await collection("users").findOne({ email });
  if (!user) {
    user = {
      email,
      name: payload.name || email.split("@")[0],
      role: email === process.env.INITIAL_ADMIN_EMAIL?.toLowerCase() ? "admin" : "student",
      image: payload.image || null,
      createdAt: new Date(),
    };
    const result = await collection("users").insertOne(user);
    user._id = result.insertedId;
  } else if (email === process.env.INITIAL_ADMIN_EMAIL?.toLowerCase() && user.role !== "admin") {
    await collection("users").updateOne({ email }, { $set: { role: "admin" } });
    user.role = "admin";
  }
  return user;
}

async function verifyToken(req, res, next) {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  try {
    const token = authorization.slice(7);
    const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
    const jwksUrl = `${clientUrl.replace(/\/$/, "")}/api/auth/jwks`;
    const jwks = getJwks(jwksUrl);
    const { payload } = await jwtVerify(token, jwks, { issuer: clientUrl, audience: clientUrl });
    const user = await syncUserFromPayload(payload);
    if (!user) return res.status(401).json({ success: false, message: "Invalid token" });
    req.user = { id: String(user._id), email: user.email, name: user.name, role: user.role, image: user.image };
    next();
  } catch (error) {
    if (
      error.code === "ERR_JWKS_NO_MATCHING_KEY" ||
      error.code === "ERR_JWT_EXPIRED" ||
      error.code === "ERR_JWS_INVALID" ||
      error.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" ||
      error.code === "ERR_JWT_INVALID" ||
      error.code === "ERR_JWT_CLAIM_VALIDATION_FAILED"
    ) {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
    next(error);
  }
}

function verifyRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    next();
  };
}

function validateBody(fields) {
  return (req, res, next) => {
    const missing = fields.filter((field) => req.body[field] === undefined || req.body[field] === "");
    if (missing.length) {
      return res.status(400).json({ success: false, message: `Missing fields: ${missing.join(", ")}` });
    }
    next();
  };
}

module.exports = { verifyToken, verifyRole, validateBody, syncUserFromPayload };
