const DAY_MS = 24 * 60 * 60 * 1000;

function calculateRental({ price, rentalType, startDate, endDate, quantity }) {
  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid rental price");
  if (!["daily", "weekly", "monthly"].includes(rentalType)) throw new Error("Invalid rental type");
  if (!(startDate instanceof Date) || !(endDate instanceof Date) || endDate <= startDate) throw new Error("Invalid rental dates");
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Invalid quantity");
  const durationDays = Math.ceil((endDate - startDate) / DAY_MS);
  const billingUnits = rentalType === "weekly" ? Math.ceil(durationDays / 7) : rentalType === "monthly" ? Math.ceil(durationDays / 30) : durationDays;
  return { durationDays, totalAmount: Math.round(price * billingUnits * quantity * 100) / 100 };
}

function hasQuantityForPeriod({ stock, bookings, startDate, endDate, quantity, now = new Date() }) {
  const reserved = bookings.filter((booking) =>
    booking.startDate < endDate && booking.endDate > startDate && booking.status !== "cancelled" &&
    (booking.paymentStatus === "paid" || (booking.status === "pending_payment" && new Date(booking.createdAt) > new Date(now.getTime() - 30 * 60 * 1000)))
  ).reduce((total, booking) => total + Number(booking.quantity || 0), 0);
  return Number.isInteger(quantity) && quantity > 0 && quantity + reserved <= stock;
}

module.exports = { calculateRental, hasQuantityForPeriod };
