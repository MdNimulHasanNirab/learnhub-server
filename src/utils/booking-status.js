function bookingStatusError({ nextStatus, paymentStatus }) {
  if (!["completed", "cancelled"].includes(nextStatus)) return { status: 400, message: "Status must be completed or cancelled" };
  if (nextStatus === "completed" && paymentStatus !== "paid") return { status: 409, message: "Only paid rentals can be completed" };
  return null;
}

module.exports = { bookingStatusError };
