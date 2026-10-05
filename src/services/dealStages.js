// Single source of truth for the deal pipeline (Annexure A Engine 2):
// Lead -> Requirement -> Match -> Site Visit -> Negotiation -> Legal
// Coordination -> Loan Referral -> Insurance Referral -> Payment
// Confirmation -> Closure. Enum values keep their original names where a
// stage already existed ('inquiry' = Lead, 'payment' = Payment Confirmation,
// 'closed_won' = Closure); 'booking' / 'documentation' are retired (kept in
// the enum for old history rows only).

const FLOW = [
  'inquiry',
  'requirement',
  'match',
  'site_visit',
  'negotiation',
  'legal_coordination',
  'loan_referral',
  'insurance_referral',
  'payment',
  'closed_won',
];

const LABELS = {
  inquiry: 'Lead',
  requirement: 'Requirement',
  match: 'Match',
  site_visit: 'Site Visit',
  negotiation: 'Negotiation',
  legal_coordination: 'Legal Coordination',
  loan_referral: 'Loan Referral',
  insurance_referral: 'Insurance Referral',
  payment: 'Payment Confirmation',
  closed_won: 'Closure',
  closed_lost: 'Closed - lost',
  on_hold: 'On hold',
  // retired
  booking: 'Booking (old)',
  documentation: 'Documentation (old)',
};

const OPEN = FLOW.filter((s) => s !== 'closed_won');
const RETIRED = ['booking', 'documentation'];
const ALL = [...FLOW, 'closed_lost', 'on_hold'];

// One step forward at a time (orchestration enforces each step's
// requirements); any open stage can go on hold or be lost; on hold returns
// to any open stage.
const TRANSITIONS = Object.fromEntries([
  ...FLOW.map((s, i) => [s, s === 'closed_won' ? [] : [FLOW[i + 1], 'on_hold', 'closed_lost']]),
  ['on_hold', [...OPEN, 'closed_lost']],
  ['closed_lost', []],
  ...RETIRED.map((s) => [s, ['legal_coordination', 'on_hold', 'closed_lost']]),
]);

// Stages at or beyond "site visit completed" (mandate renewal, DD access).
const PAST_SITE_VISIT = FLOW.slice(FLOW.indexOf('negotiation'));

const DEFAULT_SLA_DAYS = {
  inquiry: 2, requirement: 2, match: 3, site_visit: 5, negotiation: 7,
  legal_coordination: 15, loan_referral: 10, insurance_referral: 5, payment: 30,
};

const NEXT_ACTION = {
  requirement: 'Capture the buyer requirement',
  match: 'Link the matched property to the deal',
  site_visit: 'Schedule a site visit',
  negotiation: 'Complete the site visit',
  legal_coordination: 'Record the agreed deal value',
  loan_referral: 'Record the Agreement to Sell (or lease) execution date',
  insurance_referral: 'Refer the home loan or mark it not needed',
  payment: 'Refer property insurance or mark it not needed; get the agreement approved',
  closed_won: 'Record the Sale Deed date and collect all payments and invoices',
};

module.exports = { FLOW, LABELS, OPEN, RETIRED, ALL, TRANSITIONS, PAST_SITE_VISIT, DEFAULT_SLA_DAYS, NEXT_ACTION };
