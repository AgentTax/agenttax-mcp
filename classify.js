// How track_payment turns its arguments into a POST /api/v1/calculate body.
// Kept apart from index.js (which starts the stdio server on import) so it can
// be unit-tested.

export const WORK_TYPES = ["compute", "research", "information_service", "content", "consulting", "trading"];

// transaction_type sent for each work_type.
export const WORK_TYPE_TO_TX_TYPE = {
  compute: "compute",
  research: "api_access",
  information_service: "api_access",
  content: "saas",
  consulting: "consulting",
  trading: "digital_good",
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
