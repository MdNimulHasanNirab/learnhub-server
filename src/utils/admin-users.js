const { escapeRegex } = require("./search");

function buildAdminUserQuery(search = "") {
  const normalized = String(search).trim().slice(0, 100);
  return normalized ? { $or: ["name", "email"].map((field) => ({ [field]: { $regex: escapeRegex(normalized), $options: "i" } })) } : {};
}

module.exports = { buildAdminUserQuery };
