// Controlled Contact Architecture (Annexure A sec. 11.2) display masking.
// Phone: first 2 + last 2 digits visible ("98XXXXXX67").
// Email: first letter + "*" + domain ("a*@example.com").
function maskPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (local.length < 4) return 'XXXX';
  return `${local.slice(0, 2)}${'X'.repeat(local.length - 4)}${local.slice(-2)}`;
}

function maskEmail(email) {
  if (!email || !String(email).includes('@')) return null;
  const [local, domain] = String(email).split('@');
  return `${local.charAt(0)}*@${domain}`;
}

module.exports = { maskPhone, maskEmail };
