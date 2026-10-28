// node --test. calculate_tax carries the API's classification facts
// (payment_provider_type, it_support_scope, includes_prewritten_software_access,
// custom_software_attestation, maintenance_contract) with the API's strictness,
// and forwards them unchanged. No network: the end-to-end case points the
// server at a local mock of /api/v1/calculate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CLASSIFICATION_FACTS_SHAPE } from "../classify.js";

const facts = z.object(CLASSIFICATION_FACTS_SHAPE);

const FULL_ATTESTATION = {
  written_for_buyer: true,
  not_offered_to_others: true,
  deliverable: "source_code",
  is_modification_of_prewritten: true,
  separately_stated_charge: true,
  all_rights_transferred: true,
  delivery: "electronic",
  il_requirements_analysis_and_adaptation: true,
  il_assembled_modules_50pct: false,
};

const FULL_MAINTENANCE = {
  mandatory: false,
  includes_upgrades: true,
  includes_support: true,
  separately_itemized: true,
  update_delivery: "electronic",
  support_kind: "help_desk_only",
  seller_sold_software: true,
  business_use: false,
  itemized_amounts: { updates: 60, support: 40 },
};

const base = { role: "seller", amount: 100, buyer_state: "TX", counterparty_id: "c1" };

test("a full custom_software_attestation and maintenance_contract are accepted", () => {
  const r = facts.safeParse({
    custom_software_attestation: FULL_ATTESTATION,
    maintenance_contract: FULL_MAINTENANCE,
    payment_provider_type: "card_network",
    it_support_scope: "help_desk_advice",
    includes_prewritten_software_access: true,
  });
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  assert.deepEqual(r.data.custom_software_attestation, FULL_ATTESTATION);
  assert.deepEqual(r.data.maintenance_contract, FULL_MAINTENANCE);
});

test("every fact is optional", () => {
  assert.ok(facts.safeParse({}).success);
  assert.ok(facts.safeParse({ maintenance_contract: {} }).success);
});

test("an unknown key inside each fact object is rejected (strict, as in the API)", () => {
  for (const bad of [
    { custom_software_attestation: { ...FULL_ATTESTATION, extra: true } },
    { maintenance_contract: { ...FULL_MAINTENANCE, extra: true } },
    { maintenance_contract: { itemized_amounts: { updates: 1, support: 1, other: 1 } } },
  ]) {
    const r = facts.safeParse(bad);
    assert.equal(r.success, false, JSON.stringify(bad));
    assert.ok(r.error.issues.some((i) => i.code === "unrecognized_keys"), JSON.stringify(r.error.issues));
  }
});

test("the attestation's required fields and the enums are enforced", () => {
  const { deliverable, ...noDeliverable } = FULL_ATTESTATION;
  assert.equal(facts.safeParse({ custom_software_attestation: noDeliverable }).success, false);
  assert.equal(facts.safeParse({ custom_software_attestation: { ...FULL_ATTESTATION, deliverable: "saas" } }).success, false);
  assert.equal(facts.safeParse({ payment_provider_type: "crypto" }).success, false);
  assert.equal(facts.safeParse({ it_support_scope: "everything" }).success, false);
  assert.equal(facts.safeParse({ maintenance_contract: { itemized_amounts: { updates: -1, support: 1 } } }).success, false);
  assert.equal(facts.safeParse({ maintenance_contract: { itemized_amounts: { updates: 1 } } }).success, false);
});

async function runServer(messages) {
  const received = [];
  const api = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body: data ? JSON.parse(data) : null });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: true, total_tax: 0, transaction_id: "t1" }));
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
        if (line) {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) responses.set(msg.id, msg);
        }
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
    const results = [];
    for (let k = 0; k < messages.length; k++) {
      write({ jsonrpc: "2.0", id: k + 1, ...messages[k] });
      results.push(await waitFor(k + 1));
    }
    return { received, results };
  } finally {
    child.kill(); // only the child this test spawned
    await new Promise((r) => api.close(r));
  }
}

const call = (args) => ({ method: "tools/call", params: { name: "calculate_tax", arguments: args } });

test("end to end: calculate_tax publishes the facts strictly and forwards them verbatim", async () => {
  const custom = { ...base, transaction_type: "saas", work_type: "custom_software", custom_software_attestation: FULL_ATTESTATION };
  const maint = { ...base, transaction_type: "software_maintenance", work_type: "software_maintenance", maintenance_contract: FULL_MAINTENANCE };
  const pay = { ...base, transaction_type: "payment_processing_fee", work_type: "payment_processing", payment_provider_type: "processor_routing_to_bank_or_network" };
  const host = { ...base, transaction_type: "web_hosting", includes_prewritten_software_access: false };
  const it = { ...base, transaction_type: "it_support", work_type: "it_support", it_support_scope: "monitoring" };
  const { received, results } = await runServer([
    { method: "tools/list", params: {} },
    call(custom),
    call(maint),
    call(pay),
    call(host),
    call(it),
    call({ ...custom, custom_software_attestation: { ...FULL_ATTESTATION, extra: true } }),
    call({ ...maint, maintenance_contract: { ...FULL_MAINTENANCE, extra: true } }),
  ]);

  // tools/list: the published JSON Schema is strict on both objects.
  const schema = results[0].result.tools.find((t) => t.name === "calculate_tax").inputSchema;
  for (const k of ["payment_provider_type", "it_support_scope", "includes_prewritten_software_access", "custom_software_attestation", "maintenance_contract"]) {
    assert.ok(schema.properties[k], `inputSchema lacks ${k}`);
    assert.ok(!(schema.required || []).includes(k), `${k} should be optional`);
  }
  assert.equal(schema.properties.custom_software_attestation.additionalProperties, false);
  assert.equal(schema.properties.maintenance_contract.additionalProperties, false);
  assert.equal(schema.properties.maintenance_contract.properties.itemized_amounts.additionalProperties, false);
  assert.deepEqual(
    [...schema.properties.custom_software_attestation.required].sort(),
    ["deliverable", "is_modification_of_prewritten", "not_offered_to_others", "written_for_buyer"],
  );

  // the five valid calls reach the API with the caller's body unchanged
  for (const r of results.slice(1, 6)) assert.ok(r.result && !r.result.isError, JSON.stringify(r));
  assert.equal(received.length, 5, "the two invalid calls must not reach the API");
  assert.deepEqual(received.map((r) => r.body), [custom, maint, pay, host, it]);

  // unknown nested keys are refused before any API call
  for (const r of results.slice(6)) {
    const refused = r.error || r.result?.isError;
    assert.ok(refused, JSON.stringify(r));
  }
});

// Review 2 (2026-10-28) NIT 6: the API trims and lowercases payment_provider_type,
// it_support_scope, use_context and digital_content_type before its enum check,
// so the MCP layer mirrors that instead of refusing "Bank ".
test("string fact enums are trimmed and lowercased like the API", () => {
  const r = facts.safeParse({ payment_provider_type: "Bank ", it_support_scope: " Monitoring" });
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  assert.equal(r.data.payment_provider_type, "bank");
  assert.equal(r.data.it_support_scope, "monitoring");
  assert.equal(facts.safeParse({ payment_provider_type: "Crypto" }).success, false);
  assert.equal(facts.safeParse({ payment_provider_type: 7 }).success, false);
});

test("end to end: \"Bank \" is accepted, forwarded as \"bank\", and the schema still lists the enums", async () => {
  const pay = { ...base, transaction_type: "payment_processing_fee", work_type: "payment_processing", payment_provider_type: "Bank " };
  const dig = { ...base, transaction_type: "digital_good", digital_content_type: " Art_Image", is_b2b: true, use_context: "Mixed" };
  const { received, results } = await runServer([{ method: "tools/list", params: {} }, call(pay), call(dig)]);
  const schema = results[0].result.tools.find((t) => t.name === "calculate_tax").inputSchema;
  const enumOf = (p) => p.enum || p.anyOf?.find((x) => x.enum)?.enum || p.allOf?.find((x) => x.enum)?.enum;
  for (const [k, n] of [["payment_provider_type", 5], ["it_support_scope", 6], ["use_context", 3]]) {
    const values = enumOf(schema.properties[k]);
    assert.ok(Array.isArray(values) && values.length === n, `${k} schema lost its enum: ${JSON.stringify(schema.properties[k])}`);
  }
  assert.ok(enumOf(schema.properties.digital_content_type)?.includes("art_image"));
  for (const r of results.slice(1)) assert.ok(r.result && !r.result.isError, JSON.stringify(r));
  assert.equal(received.length, 2);
  assert.equal(received[0].body.payment_provider_type, "bank");
  assert.equal(received[1].body.digital_content_type, "art_image");
  assert.equal(received[1].body.use_context, "mixed");
});
