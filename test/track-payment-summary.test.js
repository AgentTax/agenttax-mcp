// node --test. track_payment's summary of a /api/v1/calculate response.
//
// Through 1.3.0 the summary read result.nexus_warning, which the API never
// returns top-level, so a seller with no nexus answer for the buyer's state
// was told "No sales tax owed in XX for this transaction type." The two
// live-demo fixtures are verbatim keyless responses from agenttax.io
// (2026-11-04); the keyed shapes follow api/_lib/schemas/calculate.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { summarizeTrackPayment } from "../classify.js";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).response;
const WA = fixture("live-demo-seller-wa-saas.json");
const FL = fixture("live-demo-seller-fl-saas.json");
const classification = { source: "default", work_type: null };
const summarize = (state, result, extra = {}) =>
  summarizeTrackPayment({ amount: 100, buyer_state: state, ...extra }, result, classification);

const OLD_WRONG = /No sales tax owed in \w\w for this transaction type/;

test("live keyless WA: a no-nexus $0 is a default, with the amount owed once nexus is set", () => {
  const s = summarize("WA", WA);
  assert.equal(s.tax_owed, 0);
  assert.equal(s.taxable, false);
  assert.equal(s.tax_rate, 0, "applied rate, not the 6.5% location rate that did not apply");
  assert.doesNotMatch(s.compliance_note, OLD_WRONG);
  assert.match(s.compliance_note, /no nexus is configured for WA/);
  assert.match(s.compliance_note, /default, not a determination/);
  assert.match(s.compliance_note, /this payment owes \$6\.50 \(6\.5%\)/);
  assert.match(s.compliance_note, /shared demo nexus profile/);
  assert.deepEqual(s.tax_if_nexus, WA.tax_if_nexus);
  assert.deepEqual(s.nexus_status, { status: "unknown", basis: "no_nexus_profile" });
  assert.equal(s.nexus_warning.code, "NEXUS_NOT_CONFIGURED_DEMO");
  assert.equal(s.exemption.type, "no_nexus");
  assert.equal(s.mode, "demo");
  assert.match(s.demo_note, /estimate/);
  assert.deepEqual(s.resolution, WA.resolution);
});

test("live keyless FL: no nexus, and $0 even with nexus, says both", () => {
  const s = summarize("FL", FL);
  assert.doesNotMatch(s.compliance_note, OLD_WRONG);
  assert.match(s.compliance_note, /no nexus is configured for FL/);
  assert.match(s.compliance_note, /Even with nexus in FL, AgentTax computes \$0\.00/);
  assert.equal(s.tax_if_nexus.total_tax, 0);
  assert.equal(s.nexus_warning.code, "NEXUS_NOT_CONFIGURED_DEMO");
});

const keyedNoNexus = {
  success: true, mode: "live", transaction_id: "t", total_tax: 0, combined_rate: 0.0625, applied_rate: 0,
  sales_tax: { rate: 0, amount: 0, exemption: { type: "no_nexus", state: "MA" } },
  exemption: { type: "no_nexus", state: "MA" },
  advisories: [
    { type: "other", code: "SOMETHING_ELSE", advisory: "x" },
    { type: "nexus_warning", flagged: true, code: "NEXUS_NOT_CONFIGURED", advisory: "This account has no nexus states configured ...",
      fix: { method: "POST", endpoint: "/api/v1/nexus", body: { nexus: { MA: { hasNexus: true } } } } },
  ],
  tax_if_nexus: { total_tax: 6.25, combined_rate: 0.0625, basis: "Hypothetical" },
  resolution: {
    location: { status: "partial", basis: "state_only", detail: "d" },
    nexus: { status: "unknown", basis: "no_nexus_profile", detail: "d" },
    taxability: { status: "resolved", basis: "category_rule", detail: "d" },
  },
};

test("keyed, nexus not answered: reports the NEXUS_NOT_CONFIGURED advisory and points at configure_nexus", () => {
  const s = summarize("MA", keyedNoNexus);
  assert.match(s.compliance_note, /no nexus is configured for MA/);
  assert.match(s.compliance_note, /owes \$6\.25 \(6\.25%\)/);
  assert.match(s.compliance_note, /configure_nexus/);
  assert.doesNotMatch(s.compliance_note, /demo/);
  assert.equal(s.nexus_warning.code, "NEXUS_NOT_CONFIGURED");
  assert.equal(s.demo_note, undefined);
});

test("nexus not answered is detected from any one signal (older API without resolution)", () => {
  const onlyAdvisory = { ...keyedNoNexus, resolution: undefined, tax_if_nexus: undefined };
  const s = summarize("MA", onlyAdvisory);
  assert.match(s.compliance_note, /no nexus is configured for MA/);
  assert.deepEqual(s.nexus_status, { status: "unknown", basis: "no_nexus_profile" });
});

test("keyed, account answered no nexus: the $0 rests on the caller's own setting", () => {
  const s = summarize("MA", {
    ...keyedNoNexus, advisories: [], tax_if_nexus: undefined,
    resolution: { ...keyedNoNexus.resolution, nexus: { status: "resolved", basis: "configured", detail: "d" } },
  });
  assert.match(s.compliance_note, /your nexus settings say you do not have nexus in MA/);
  assert.equal(s.nexus_warning, undefined);
  assert.equal(s.tax_if_nexus, undefined);
});

test("taxable sale: amount owed and the applied rate", () => {
  const s = summarize("MA", {
    success: true, mode: "live", total_tax: 6.25, combined_rate: 0.0625, applied_rate: 0.0625,
    sales_tax: { rate: 0.0625, amount: 6.25 }, advisories: [],
    resolution: { nexus: { status: "resolved", basis: "configured" }, taxability: { status: "resolved", basis: "category_rule" } },
  });
  assert.equal(s.tax_owed, 6.25);
  assert.equal(s.tax_rate, 0.0625);
  assert.equal(s.taxable, true);
  assert.equal(s.compliance_note, "$6.25 sales tax owed to MA. Remit to the state DOR.");
});

test("a real exemption with nexus configured is still reported as no sales tax owed", () => {
  const s = summarize("FL", {
    success: true, mode: "live", total_tax: 0, combined_rate: 0.06, applied_rate: 0,
    exemption: { type: "category_exempt", state: "FL" }, advisories: [],
    resolution: { nexus: { status: "resolved", basis: "configured" }, taxability: { status: "resolved", basis: "category_rule" } },
  });
  assert.equal(s.compliance_note, "No sales tax owed in FL for this transaction type.");
});

test("an unresolved taxability axis is appended to the note", () => {
  const s = summarize("TX", {
    success: true, mode: "live", total_tax: 8, applied_rate: 0.08, advisories: [],
    resolution: { nexus: { status: "resolved", basis: "configured" },
      taxability: { status: "partial", basis: "fact_not_declared", detail: "is_b2b was not sent." } },
  });
  assert.match(s.compliance_note, /Taxability is partial: is_b2b was not sent\./);
});

test("end to end: track_payment over stdio against the live WA response", async () => {
  const api = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(WA));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
  const child = spawn(process.execPath, [indexPath], {
    env: { ...process.env, AGENTTAX_BASE_URL: `http://127.0.0.1:${api.address().port}`, AGENTTAX_API_KEY: "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    const responses = new Map();
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); }
      }
    });
    const write = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    const waitFor = async (id) => {
      for (let n = 0; n < 600 && !responses.has(id); n++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(responses.has(id), `no response for id ${id}`);
      return responses.get(id);
    };
    write({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    await waitFor(0);
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "track_payment", arguments: { amount: 100, buyer_state: "WA", payment_id: "pi_wa" } } });
    const r = await waitFor(1);
    assert.ok(r.result && !r.result.isError, JSON.stringify(r));
    const s = JSON.parse(r.result.content[0].text);
    assert.doesNotMatch(s.compliance_note, OLD_WRONG);
    assert.match(s.compliance_note, /\$6\.50/);
    assert.equal(s.tax_if_nexus.total_tax, 6.5);
  } finally {
    child.kill(); // only the child this test spawned
    await new Promise((r) => api.close(r));
  }
});
