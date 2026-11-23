function roleChangeError({ actorId, targetId, targetRole, nextRole, adminCount }) {
  if (!["customer", "owner", "admin"].includes(nextRole)) return { status: 400, message: "Invalid role" };
  if (String(actorId) === String(targetId) && nextRole !== "admin") return { status: 409, message: "You cannot remove your own admin role" };
  if (targetRole === "admin" && nextRole !== "admin" && adminCount <= 1) return { status: 409, message: "At least one administrator must remain" };
  return null;
}

module.exports = { roleChangeError };
