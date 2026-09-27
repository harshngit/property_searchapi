const disclaimerService = require('./disclaimer.service');
const liquidityService = require('./liquidity.service');
const { formatInr } = require('../utils/price');
const { badRequest } = require('../utils/httpError');

// Engine 6 "Investment Guidance Engine (Non-Advisory)" calculators: ROI
// estimation, rental yield, capital appreciation projection, plus the
// Module 14 liquidity score for any area. Pure arithmetic on the caller's
// inputs - indicative only, every result carries the disclaimer.

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

async function guidanceDisclaimers() {
  return disclaimerService.getDisclaimers(['investment_guidance', 'ai_output']);
}

// Rental yield: gross = annual rent / price; net = (annual rent - vacancy
// loss - expenses) / (price + acquisition costs).
async function rentalYield({ propertyPrice, monthlyRent, annualExpenses = 0, vacancyMonths = 0, acquisitionCosts = 0 }) {
  const price = Number(propertyPrice);
  if (!(price > 0)) throw badRequest('propertyPrice must be greater than 0');
  const annualRent = Number(monthlyRent) * 12;
  const effectiveRent = Number(monthlyRent) * (12 - Number(vacancyMonths));
  const netIncome = effectiveRent - Number(annualExpenses);
  const totalCost = price + Number(acquisitionCosts);
  return {
    annualRent: round2(annualRent),
    effectiveAnnualRent: round2(effectiveRent),
    netAnnualIncome: round2(netIncome),
    grossYieldPercent: round2((annualRent / price) * 100),
    netYieldPercent: round2((netIncome / totalCost) * 100),
    paybackYears: netIncome > 0 ? round2(totalCost / netIncome) : null,
    disclaimers: await guidanceDisclaimers(),
  };
}

// Year-by-year value projection at a constant assumed appreciation rate.
async function appreciationProjection({ currentValue, annualAppreciationPercent, years = 5 }) {
  const value = Number(currentValue);
  const rate = Number(annualAppreciationPercent) / 100;
  const span = Math.min(Math.max(Number(years) || 5, 1), 30);
  if (!(value > 0)) throw badRequest('currentValue must be greater than 0');

  const schedule = [];
  for (let y = 1; y <= span; y++) {
    const projected = value * Math.pow(1 + rate, y);
    schedule.push({ year: y, projectedValue: round2(projected), display: formatInr(projected) });
  }
  const final = schedule[schedule.length - 1].projectedValue;
  return {
    currentValue: value,
    annualAppreciationPercent: Number(annualAppreciationPercent),
    years: span,
    projectedValue: final,
    projectedGain: round2(final - value),
    schedule,
    disclaimers: await guidanceDisclaimers(),
  };
}

// Total return over a holding period: appreciation + net rent - entry and
// exit costs, optionally with a loan (interest-only approximation of the
// financing cost), giving absolute ROI, annualised ROI and equity multiple.
async function roi({
  purchasePrice,
  acquisitionCosts = 0,
  monthlyRent = 0,
  annualExpenses = 0,
  annualAppreciationPercent = 0,
  holdingYears = 5,
  exitCostPercent = 0,
  loanAmount = 0,
  loanInterestPercent = 0,
}) {
  const price = Number(purchasePrice);
  if (!(price > 0)) throw badRequest('purchasePrice must be greater than 0');
  const years = Math.min(Math.max(Number(holdingYears) || 5, 0.5), 30);

  const exitValue = price * Math.pow(1 + Number(annualAppreciationPercent) / 100, years);
  const exitCosts = exitValue * (Number(exitCostPercent) / 100);
  const netRentTotal = (Number(monthlyRent) * 12 - Number(annualExpenses)) * years;
  const financingCost = Number(loanAmount) * (Number(loanInterestPercent) / 100) * years;
  const equity = price + Number(acquisitionCosts) - Number(loanAmount);
  if (!(equity > 0)) throw badRequest('Equity invested (price + costs - loan) must be greater than 0');

  const profit = exitValue - exitCosts - price - Number(acquisitionCosts) + netRentTotal - financingCost;
  const multiple = (equity + profit) / equity;
  return {
    holdingYears: years,
    equityInvested: round2(equity),
    projectedExitValue: round2(exitValue),
    netRentalIncome: round2(netRentTotal),
    financingCost: round2(financingCost),
    exitCosts: round2(exitCosts),
    totalProfit: round2(profit),
    absoluteRoiPercent: round2((profit / equity) * 100),
    annualisedRoiPercent: multiple > 0 ? round2((Math.pow(multiple, 1 / years) - 1) * 100) : null,
    equityMultiple: round2(multiple),
    disclaimers: await guidanceDisclaimers(),
  };
}

async function liquidityScore(query) {
  if (!query.city) throw badRequest('city is required');
  const result = await liquidityService.computeLiquidity({
    city: query.city,
    locality: query.locality,
    propertyType: query.propertyType,
    priceValue: query.price ? Number(query.price) : null,
  });
  return { ...result, disclaimers: await disclaimerService.getDisclaimers(['liquidity_score']) };
}

module.exports = { rentalYield, appreciationProjection, roi, liquidityScore };
