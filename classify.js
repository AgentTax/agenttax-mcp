// How track_payment turns its arguments into a POST /api/v1/calculate body,
// plus the enums and classification-fact schema calculate_tax shares with the
// API. Kept apart from index.js (which starts the stdio server on import) so
// it can be unit-tested.

import { z } from "zod";

// The work types the AgentTax API accepts (api/_lib/schemas/common.js
// WORK_TYPES). 1.3.0 adds the five classification work types the API has
// taken since 2026-10-16; before this the zod enum rejected them, so an MCP
// caller could not declare a payment fee, hosting, maintenance, IT support or
// custom software at all. The API decides taxability; nothing here does.
export const WORK_TYPES = [
  "compute", "research", "information_service", "content", "consulting", "trading",
  "payment_processing", "web_hosting", "software_maintenance", "it_support", "custom_software",
];

// The transaction types the AgentTax API accepts (api/_lib/schemas/common.js
// TRANSACTION_TYPES), including the four classification types the API has
// taken since 2026-10-16.
export const TRANSACTION_TYPES = [
  "compute", "api_access", "data_purchase", "saas", "ai_labor", "storage",
  "digital_good", "consulting", "data_processing", "cloud_infrastructure",
  "ai_model_access", "marketplace_fee", "subscription", "license", "service",
  "payment_processing_fee", "web_hosting", "software_maintenance", "it_support",
];

// digital_content_type values (api/_lib/schemas/common.js DIGITAL_CONTENT_TYPES).
export const DIGITAL_CONTENT_TYPES = [
  "ebook", "audio", "video", "art_image", "photograph", "printable_document", "software", "data", "other",
];

// Classification-fact enums, copied from api/_lib/schemas/common.js. Pinned
// against the API by test/enum-parity.test.js.
export const PAYMENT_PROVIDER_TYPES = [
  "bank", "licensed_money_transmitter", "card_network", "processor_routing_to_bank_or_network", "other",
];
export const IT_SUPPORT_SCOPES = [
  "help_desk_advice", "remote_repair_or_config", "software_installation", "monitoring", "security_monitoring", "managed_bundle",
];
export const MAINTENANCE_UPDATE_DELIVERY = ["electronic", "tangible"];
export const MAINTENANCE_SUPPORT_KINDS = ["help_desk_only", "includes_fixes"];
export const CUSTOM_SOFTWARE_DELIVERABLES = ["source_code", "compiled_artifact", "hosted"];
export const CUSTOM_SOFTWARE_DELIVERY = ["electronic", "tangible"];

// The API trims and lowercases these string facts before its enum check
// (api/_lib/schemas/calculate.js: .trim().transform(toLowerCase).pipe(z.enum)),
// so "Bank " is valid there. Mirror that here, the way index.js stateCode
// uppercases, so the MCP layer does not refuse what the API accepts. The
// normalised value is what gets forwarded. The published JSON Schema still
// shows the enum.
export const lowerEnum = (values) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(values));

// The optional classification facts calculate_tax forwards to the API.
// Names, nesting, enum values and strictness match calculateRequest in
// api/_lib/schemas/calculate.js; the API decides what each fact does to the
// answer. Every field is optional: absent means the API's conservative
// default.
export const CLASSIFICATION_FACTS_SHAPE = {
  payment_provider_type: lowerEnum(PAYMENT_PROVIDER_TYPES).optional()
    .describe("With transaction_type payment_processing_fee: who provides the payment processing. " +
      "Changes the answer in some states; absent = the conservative answer. Your representation, recorded with the transaction"),
  it_support_scope: lowerEnum(IT_SUPPORT_SCOPES).optional()
    .describe("With transaction_type or work_type it_support: what the remote IT support engagement is. " +
      "Absent = managed_bundle, the per-state default; some states answer specific scopes differently"),
  includes_prewritten_software_access: z.boolean().optional()
    .describe("With transaction_type web_hosting: true when the plan gives the buyer vendor prewritten software beyond an incidental " +
      "control panel or file manager (site builder, CMS or app platform, email or office suite, managed application). " +
      "Absent or false = plain hosting of the buyer's own site or application"),
  custom_software_attestation: z.object({
    written_for_buyer: z.boolean(),
    not_offered_to_others: z.boolean(),
    deliverable: z.enum(CUSTOM_SOFTWARE_DELIVERABLES),
    is_modification_of_prewritten: z.boolean(),
    separately_stated_charge: z.boolean().optional(),
    all_rights_transferred: z.boolean().optional(),
    delivery: z.enum(CUSTOM_SOFTWARE_DELIVERY).optional(),
    il_requirements_analysis_and_adaptation: z.boolean().optional(),
    il_assembled_modules_50pct: z.boolean().optional(),
  }).strict().optional()
    .describe("Required with work_type custom_software; without a complete attestation the sale is answered as prewritten software / SaaS. " +
      "Complete = written_for_buyer true, not_offered_to_others true, deliverable source_code or compiled_artifact (hosted is SaaS), " +
      "is_modification_of_prewritten set, and separately_stated_charge true when it is a modification. The other fields are state-specific facts. " +
      "Your representation, recorded with the transaction; not a state safe harbor"),
  maintenance_contract: z.object({
    mandatory: z.boolean().optional(),
    includes_upgrades: z.boolean().optional(),
    includes_support: z.boolean().optional(),
    separately_itemized: z.boolean().optional(),
    update_delivery: z.enum(MAINTENANCE_UPDATE_DELIVERY).optional(),
    support_kind: z.enum(MAINTENANCE_SUPPORT_KINDS).optional(),
    seller_sold_software: z.boolean().optional(),
    business_use: z.boolean().optional(),
    itemized_amounts: z.object({
      updates: z.number().nonnegative().finite(),
      support: z.number().nonnegative().finite(),
    }).strict().optional(),
  }).strict().optional()
    .describe("With transaction_type software_maintenance: facts about a maintenance contract on prewritten software. Every field is optional; " +
      "a missing fact is answered conservatively (updates assumed included). separately_itemized + itemized_amounts {updates, support} " +
      "(summing to amount) split the charge where a state taxes the parts differently"),
};

// transaction_type sent for each work_type. The classification work types
// have their own transaction types (AGENTS.md "Classification facts");
// custom_software is a work_type on a SaaS/service sale, and without a
// complete custom_software_attestation the API answers it as prewritten
// software or SaaS, which is the conservative default a payment log wants.
export const WORK_TYPE_TO_TX_TYPE = {
  compute: "compute",
  research: "api_access",
  information_service: "api_access",
  content: "saas",
  consulting: "consulting",
  trading: "digital_good",
  payment_processing: "payment_processing_fee",
  web_hosting: "web_hosting",
  software_maintenance: "software_maintenance",
  it_support: "it_support",
  custom_software: "saas",
};

// Work types that, in the AgentTax engine, can route a sale to an exemption:
//   consulting -> exempt professional service in Arizona (A.R.S. 42-5061(A)(1),
//                 TPR 93-48), and the engine also exempts AZ when only
//                 transaction_type "consulting" is sent;
//   trading    -> financial_service, exempt in every state.
// The engine grants these only on a DECLARED fact. The public calculate API
// has no way to mark a work type as guessed, so a keyword match on the
// description must never send either one. A guess that lands here is
// treated as unclassified (the same default as a description with no
// keyword), which is taxed the way the engine taxes SaaS.
export const EXEMPTION_BEARING_WORK_TYPES = new Set(["consulting", "trading"]);

// Guess a work type from a plain-English description. Returns null when no
// keyword matches. A guess is a hint only: see buildTrackPaymentRequest.
export function guessWorkType(description) {
  if (!description) return null;
  const d = description.toLowerCase();
  if (/\b(compute|inference|gpu|process|api[\s-]?call|token)\b/.test(d)) return "compute";
  if (/\b(research|analysis|analytics|data[\s-]?(process|feed))\b/.test(d)) return "research";
  if (/\b(consult|consulting|advisory|advice|audit)\b/.test(d)) return "consulting";
  if (/\b(trade|trading|swap|asset)\b/.test(d)) return "trading";
  return null;
}

// Returns { body, classification } where body is the calculate request and
// classification says where the work type came from.
//
//   explicit work_type          -> sent as work_type, with its transaction_type
//   guessed compute / research  -> sent as in 1.1.1. Not an exemption, but their
//                                  categories can tax less than SaaS in some states
//                                  (e.g. CT, MD, SC, TN, WV); changing that is a
//                                  tax-value decision, so it is left as is.
//   guessed consulting/trading  -> NOT sent; transaction_type "saas", no work_type
//   no guess                    -> transaction_type "saas", no work_type
//   is_b2b                      -> sent only when the caller passed a boolean
export function buildTrackPaymentRequest(params, { now = Date.now } = {}) {
  const counterpartyId = params.payment_id || `payment_${now()}`;
  let workType;
  let transactionType;
  let classification;

  if (params.work_type) {
    workType = params.work_type;
    transactionType = WORK_TYPE_TO_TX_TYPE[workType] || "saas";
    classification = { source: "explicit", work_type: workType };
  } else {
    const guess = guessWorkType(params.description);
    if (guess && !EXEMPTION_BEARING_WORK_TYPES.has(guess)) {
      workType = guess;
      transactionType = WORK_TYPE_TO_TX_TYPE[guess];
      classification = { source: "inferred_from_description", work_type: guess };
    } else {
      workType = undefined; // let the API default from transaction_type
      transactionType = "saas";
      classification = guess
        ? {
            source: "default",
            work_type: null,
            guess_not_used: guess,
            note:
              `The description looks like "${guess}", but a guess never takes the ${guess} exemption, so this sale was ` +
              `taxed as a SaaS / digital service. If the sale really is ${guess}, call track_payment again with ` +
              `work_type: "${guess}".`,
          }
        : { source: "default", work_type: null };
    }
  }

  const body = {
    role: "seller",
    amount: params.amount,
    buyer_state: params.buyer_state,
    buyer_zip: params.buyer_zip,
    transaction_type: transactionType,
    counterparty_id: counterpartyId,
  };
  if (workType) body.work_type = workType;
  // Send is_b2b only when the caller said. The API treats a present
  // is_b2b:false as a DECLARED consumer, which takes explicit-only consumer
  // exemptions (e.g. Ohio SaaS, R.C. 5739.01(B)(3)(e)); an unknown buyer must
  // stay unknown so it is taxed conservatively.
  if (typeof params.is_b2b === "boolean") body.is_b2b = params.is_b2b;
  return { body, classification };
}
