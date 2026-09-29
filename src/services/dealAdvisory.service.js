const { formatInr } = require('../utils/price');

// Engine 3 "Deal advisory layer: non-legal guidance on deal structure and
// risk-return profile". Built from the deal's own data - discount, score,
// liquidity, risk indicators, possession, auction terms, yield - into a
// short, plain-language brief. Always shown with the investment-guidance
// and special-situation disclaimers; never legal or financial advice.

const RISK_CHECKS = {
  documentation_pending: 'Ask for the full title chain and encumbrance certificate before bidding - documentation is incomplete.',
  possession_unclear: 'Confirm who is in possession and what vacating would involve - possession is not clear.',
  legal_complexity: 'Have an advocate review the litigation / notice history - there is legal complexity.',
  tenant_occupied: 'The property is tenanted - review the lease, rent and notice terms.',
};

function daysUntil(date) {
  if (!date) return null;
  return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
}

function buildAdvisory(deal) {
  const risks = Array.isArray(deal.risk_indicators) ? deal.risk_indicators : [];
  const discount = deal.discount_percent != null ? Number(deal.discount_percent) : null;
  const score = deal.investment_score != null ? Number(deal.investment_score) : null;
  const liquidity = deal.liquidity_band || null;
  const ask = Number(deal.reserve_price ?? deal.price_value) || null;

  // Risk-return profile.
  let profile = 'balanced';
  if (risks.length >= 2 || liquidity === 'low' || deal.possession_type === 'symbolic') profile = 'higher_risk';
  else if ((discount != null && discount >= 20) && (score == null || score >= 60) && risks.length === 0 && liquidity !== 'low') profile = 'value';
  const profileText = {
    value: 'Value opportunity - meaningful discount with few flagged risks.',
    balanced: 'Balanced - a reasonable discount or score, with some points to verify.',
    higher_risk: 'Higher risk / higher potential return - several points need resolving before committing.',
  }[profile];

  const points = [];
  if (discount != null) points.push(discount > 0 ? `Priced about ${discount}% below the estimated market value${deal.estimated_market_value ? ` (${formatInr(deal.estimated_market_value)})` : ''}.` : 'Priced at or above the estimated market value - the discount case is weak.');
  if (score != null) points.push(`Investment score ${score}/100${score >= 75 ? ' - among the stronger deals on the platform' : score < 45 ? ' - below average; look closely at why' : ''}.`);
  if (liquidity) points.push({ high: 'High liquidity - similar properties in this area sell quickly, so exiting should be easier.', moderate: 'Moderate liquidity - plan for a normal selling period on exit.', low: 'Low liquidity - resale could take longer; suits a longer holding period.' }[liquidity]);
  const yieldPct = deal.yield_percent != null ? Number(deal.yield_percent) : deal.estimated_rent_monthly && ask ? Math.round(((Number(deal.estimated_rent_monthly) * 12) / ask) * 1000) / 10 : null;
  if (yieldPct != null) points.push(`Indicative rental yield around ${yieldPct}%${yieldPct >= 6 ? ' - supports holding for income' : ''}.`);

  // Deal structure.
  const structure = [];
  if (deal.listing_category === 'auction') {
    structure.push('Bank auction: bids are placed on the auction portal; the highest bid at or above the reserve price wins, subject to the bank\'s confirmation.');
    if (deal.emd_amount) structure.push(`Earnest money (EMD) of ${formatInr(deal.emd_amount)} is paid before bidding${deal.emd_deadline ? ` - by ${new Date(deal.emd_deadline).toLocaleDateString('en-IN')}` : ''}; it is refunded if you do not win and adjusted against the price if you do.`);
    structure.push('After winning, banks typically ask for 25% of the bid quickly and the balance within the notice period (often 15-90 days) - arrange funds or a loan sanction in advance.');
    const d = daysUntil(deal.auction_date);
    if (d != null && d >= 0) structure.push(`The auction is in ${d} day${d === 1 ? '' : 's'}${deal.inspection_date ? `; site inspection is on ${new Date(deal.inspection_date).toLocaleDateString('en-IN')}` : ''}.`);
  } else if (deal.listing_category === 'special_situation') {
    structure.push('Negotiated sale: price and terms are agreed with the seller through your A R Buildwel representative, usually against a token, then an agreement to sell and registration.');
    const tags = deal.situation_tags || [];
    if (tags.includes('time_bound_sale') || tags.includes('urgent_sale')) structure.push('The seller is working to a deadline - quick, clean offers tend to get better terms.');
  } else if (deal.listing_category === 'institutional') {
    structure.push('Institutional transaction: runs through the nine-stage process (qualification, NDA and data room, site visit, valuation, legal due diligence, offer, closure) and may be a full sale, stake sale, lease or JV.');
  }
  if (deal.possession_type === 'symbolic') structure.push('Only symbolic possession has been taken - physical possession may need further legal steps after purchase.');
  if (deal.possession_type === 'physical') structure.push('Physical possession has been taken by the lender - handover is usually simpler.');

  const checks = risks.map((r) => RISK_CHECKS[r]).filter(Boolean);
  checks.push('Verify the title, dues (property tax, society, utilities) and any encumbrances independently before paying anything.');
  if (deal.listing_category === 'auction') checks.push('Read the full sale notice and terms on the auctioning bank\'s portal - the notice is the binding document.');

  const exit = liquidity === 'low' ? 'Plan a longer hold (3-5+ years) or an income-led strategy.' : liquidity === 'high' ? 'Exit options should be good; a 2-3 year value-realisation plan is common for discounted deals.' : 'A 3-year horizon is a reasonable planning assumption.';

  return { profile, profileText, points: points.filter(Boolean), structure, checks, exit };
}

module.exports = { buildAdvisory };
