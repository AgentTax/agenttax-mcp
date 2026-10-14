# Changelog

## 1.2.0

Tax-safety release for `track_payment`. Some results change; read before upgrading.

- **Guessed consulting and trading are no longer exempt.** 1.1.1 guessed a work type from `description` and sent it as if you had declared it. A description that looked like consulting ("SOC 2 audit platform subscription", "tax advice") sold to an Arizona buyer came back $0 under the AZ professional-services exemption, and one that looked like trading ("game asset pack", "token swap fee") came back $0 in every state as a financial service. Both guesses are now taxed as SaaS. If the sale really is consulting or trading, pass `work_type` and the exemption applies as before.
- **New optional `work_type` argument on `track_payment`** (`compute` | `research` | `information_service` | `content` | `consulting` | `trading`). It overrides the description and is treated as a declaration. Pass it for an exact answer.
- **Guessed compute and research are unchanged** from 1.1.1. They are not exemptions, but those categories can tax less than SaaS in some states (e.g. CT, MD, SC, TN, WV). Pass `work_type` for an exact answer.
- **`is_b2b` is sent only when you pass it.** 1.1.1 always sent `is_b2b: false`, which silently declared every buyer a consumer. Ohio sellers to consumers: pass `is_b2b: false`, or the sale is now taxed (Ohio exempts SaaS and data processing only for a declared consumer; an unknown buyer is taxed). With `is_b2b` omitted, AgentTax may also auto-detect a business buyer when the counterparty has a KYA principal record marked as a business, and apply B2B rules (e.g. Maryland 3%, Iowa B2B exemption); 1.1.1's explicit `false` blocked that. Pass `is_b2b` yourself if you know the buyer.
- The `track_payment` response has a new `classification` field saying where the work type came from (`explicit`, `inferred_from_description` or `default`) and, when a consulting or trading guess was not used, a note telling you to resend with `work_type`.
- No other tool changed. `calculate_tax` and `ingest_transactions` already sent only what you gave them.
