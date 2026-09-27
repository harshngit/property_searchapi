// Parses the free-text `properties.price` ("2.1 Cr", "₹ 85 Lakh",
// "Rs. 5,00,000") into a plain INR number. Mirrors the SQL backfill in
// migration 019 so rows written before and after it parse identically.
// Returns null for anything that isn't a number ("Price on Request").
const UNIT_MULTIPLIERS = {
  '': 1,
  cr: 1e7,
  crore: 1e7,
  crores: 1e7,
  l: 1e5,
  lac: 1e5,
  lacs: 1e5,
  lakh: 1e5,
  lakhs: 1e5,
  k: 1e3,
  thousand: 1e3,
};

function parsePriceToNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;

  const cleaned = String(value)
    .toLowerCase()
    .replace(/[₹,\s]|rs\.?|inr/g, '');
  const match = cleaned.match(/^([0-9]+(?:\.[0-9]+)?)([a-z]*)$/);
  if (!match) return null;

  const multiplier = UNIT_MULTIPLIERS[match[2]];
  if (multiplier === undefined) return null;
  return Math.round(Number(match[1]) * multiplier * 100) / 100;
}

// Indian-style short display: 21000000 -> "₹2.1 Cr", 8500000 -> "₹85 L".
function formatInr(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  if (n >= 1e7) return `₹${Number((n / 1e7).toFixed(2))} Cr`;
  if (n >= 1e5) return `₹${Number((n / 1e5).toFixed(2))} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

module.exports = { parsePriceToNumber, formatInr };
