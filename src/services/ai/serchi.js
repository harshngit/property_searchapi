// Serchi - PropertySerch's own AI intelligence layer.
//
// The ONE service every AI feature calls. No module talks to OpenAI or
// Anthropic directly: it asks Serchi to run an activity, and Serchi picks the
// model (simple work on the cheaper OpenAI model, legal / document work on
// Claude), charges the asking user's AI credits, falls back to the other
// provider when one fails, records the cost and attaches the disclaimer.
// Keeping every call behind this interface means it can move into its own
// microservice in Phase 2 without touching the features.
//
//   serchi.run(activityKey, { user, system, prompt | parts, schema, entityType, entityId })
//     -> { text, json, model, provider, creditsCharged, balance, disclaimer, runId }
//   serchi.available(activityKey)  -> is it switched on with a provider configured
//
// Feature activities (credit prices are set by the Super Admin):
//   lead_insight        #1 lead qualification + #2 HOT / WARM / NURTURE / COLD rating
//   email_lead_parse    #3 reading an inbound lead the regexes could not
//   review_screen       #7 second opinion on a review
//   document_analysis   #9 document classification, risk flags, anomalies (Claude)
//   field_fraud_review  #10 second opinion on a field-partner submission (signals + photos)
//   agreement_review    AI review of a generated agreement (Claude)
//   translation         drafting interface translations
// Safety checks (#8 image contact blocking, #11 crawler OCR, #16 duplicates)
// and the rule-based scores never call Serchi - they run on rules and
// self-hosted tools at no AI cost.

const engine = require('./orchestrator.service');

module.exports = {
  run: engine.run,
  available: engine.available,
  activity: engine.activity,
  InsufficientCredits: engine.InsufficientCredits,
};
