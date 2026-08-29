const OTP_SEND_URL = 'https://control.msg91.com/api/v5/otp';
const FLOW_SEND_URL = 'https://control.msg91.com/api/v5/flow/';

// Each otp_purpose gets its own DLT-approved template (different wording per
// purpose, e.g. "...complete registration..." vs "...login..."), so there is
// no single shared template id - each purpose maps to its own env var.
const TEMPLATE_ENV_VAR_BY_PURPOSE = {
  register: 'MSG91_OTP_TEMPLATE_ID_REGISTER',
  login: 'MSG91_OTP_TEMPLATE_ID_LOGIN',
  reset_password: 'MSG91_OTP_TEMPLATE_ID_RESET_PASSWORD',
  mobile_verification: 'MSG91_OTP_TEMPLATE_ID_MOBILE_VERIFICATION',
};

// Returns the configured template id for a purpose, or undefined if no
// template has been set up for it yet - callers decide what "not configured"
// means for them (skip in dev, hard-fail in prod - see auth.service.js).
function getTemplateIdForPurpose(purpose) {
  const envVar = TEMPLATE_ENV_VAR_BY_PURPOSE[purpose];
  return envVar ? process.env[envVar] : undefined;
}

// MSG91 expects the mobile number with a country code and no leading '+',
// spaces or dashes. The only shape stored today is a bare 10-digit Indian
// number (see users.mobile / swagger examples), so that's what gets the
// country code prefixed; anything that already carries one (11+ digits)
// is left as-is.
function formatMobile(identifier) {
  const digits = identifier.replace(/\D/g, '');
  if (digits.length === 10) {
    const countryCode = process.env.MSG91_COUNTRY_CODE || '91';
    return `${countryCode}${digits}`;
  }
  return digits;
}

function isMobileIdentifier(identifier) {
  return !identifier.includes('@') && /^\+?[0-9\s-]{8,15}$/.test(identifier);
}

// Delivers an already-generated OTP via SMS using MSG91's dedicated SendOTP
// API in "custom OTP" mode (the `otp` param) - our own otp_verifications
// row, with its own expiry and attempt-limiting (see auth.service.js), stays
// the single source of truth for verification. MSG91 is used purely as the
// delivery channel, never asked to verify anything itself.
//
// templateId must point at a DLT-approved template (MSG91 dashboard ->
// SendOTP > Templates, one per purpose) whose body includes the ##OTP##
// variable - that placeholder name is specific to this API, which is why
// it's the default mode (see sendModeViaFlow below for the alternative).
async function sendOtpViaOtpApi(identifier, otpCode, templateId) {
  const params = new URLSearchParams({
    template_id: templateId,
    mobile: formatMobile(identifier),
    authkey: process.env.MSG91_AUTH_KEY,
    otp: otpCode,
    otp_expiry: String(Number(process.env.OTP_EXPIRY_MINUTES) || 5),
  });

  const response = await fetch(`${OTP_SEND_URL}?${params.toString()}`, {
    method: 'POST',
    headers: { authkey: process.env.MSG91_AUTH_KEY },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.type !== 'success') {
    const err = new Error(`Failed to send OTP via MSG91 OTP API: ${data.message || response.statusText}`);
    err.statusCode = 502;
    throw err;
  }

  return data;
}

// Alternative delivery path via MSG91's general "Send SMS" / Flow API,
// for accounts where the OTP-specific product isn't the one actually
// provisioned. Templates for this path are normally written with a named
// variable like ##OTP## too (mapped 1:1 to a same-named key on the
// recipient object below) - if your client's template instead uses the
// older {#var#} DLT syntax with no name, use VAR1 as the key instead.
// Toggle with MSG91_SEND_MODE=flow (default remains the OTP API above).
async function sendOtpViaFlowApi(identifier, otpCode, templateId) {
  const response = await fetch(FLOW_SEND_URL, {
    method: 'POST',
    headers: {
      authkey: process.env.MSG91_AUTH_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      template_id: templateId,
      short_url: '0',
      recipients: [
        {
          mobiles: formatMobile(identifier),
          OTP: otpCode,
        },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.type !== 'success') {
    const err = new Error(`Failed to send OTP via MSG91 Flow/SMS API: ${data.message || response.statusText}`);
    err.statusCode = 502;
    throw err;
  }

  return data;
}

async function sendOtpSms(identifier, otpCode, templateId) {
  const useFlow = process.env.MSG91_SEND_MODE === 'flow';
  const data = useFlow
    ? await sendOtpViaFlowApi(identifier, otpCode, templateId)
    : await sendOtpViaOtpApi(identifier, otpCode, templateId);

  // "success" only means MSG91 accepted the request, not that the carrier
  // delivered it. Logged in full so it can be matched against MSG91
  // dashboard -> SendOTP > Logs, which can also just be searched by number.
  console.log(`[msg91] OTP send accepted (mode: ${useFlow ? 'flow' : 'otp'}) for ${formatMobile(identifier)}:`, data);

  return data;
}

module.exports = { sendOtpSms, isMobileIdentifier, getTemplateIdForPurpose };
