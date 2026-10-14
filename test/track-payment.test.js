// node --test. No network: the end-to-end case points the server at a local
// mock of /api/v1/calculate and records what the MCP server sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildTrackPaymentRequest, guessWorkType } from "../classify.js";

const base = { amount: 100, buyer_state: "AZ", payment_id: "pi_1" };
const send = (extra) => buildTrackPaymentRequest({ ...base, ...extra }).body;

test("explicit work_type consulting passes through as a declaration", () => {
  const { body, classification } = buildTrackPaymentRequest({ ...base, work_type: "consulting", description: "SaaS subscription" });
  assert.equal(body.work_type, "consulting");
  assert.equal(body.transaction_type, "consulting");
  assert.equal(classification.source, "explicit");
});

for (const description of [
  "SOC 2 audit platform subscription",
  "tax advice",
  "AI consulting",
  "advisory retainer",
  "consult call",
]) {
  test(`description "${description}" without work_type never sends consulting`, () => {
    const body = send({ description });
    assert.notEqual(body.work_type, "consulting");
    assert.notEqual(body.transaction_type, "consulting");
    assert.equal(body.transaction_type, "saas");
    assert.equal("work_type" in body, false);
  });
}

test("a guessed consulting sale says why the guess was not used", () => {
  const { classification } = buildTrackPaymentRequest({ ...base, description: "SOC 2 audit platform subscription" });
  assert.equal(classification.source, "default");
  assert.equal(classification.guess_not_used, "consulting");
  assert.match(classification.note, /work_type: "consulting"/);
});

test("description that looks like trading never sends trading (financial_service is exempt everywhere)", () => {
  for (const description of ["game asset pack", "token swap fee", "trading signals"]) {
    const body = send({ description });
    assert.notEqual(body.work_type, "trading", description);
    assert.notEqual(body.transaction_type, "digital_good", description);
  }
});

test("explicit trading still passes through", () => {
  const body = send({ work_type: "trading" });
  assert.equal(body.work_type, "trading");
  assert.equal(body.transaction_type, "digital_good");
});

test("guessed compute and research are unchanged", () => {
  const c = send({ description: "GPU inference credits" });
  assert.deepEqual([c.work_type, c.transaction_type], ["compute", "compute"]);
  const r = send({ description: "market research report" });
  assert.deepEqual([r.work_type, r.transaction_type], ["research", "api_access"]);
});

test("no description or no keyword: saas with no work_type", () => {
  for (const description of [undefined, "", "MCP tool subscription"]) {
    const body = send({ description });
    assert.equal(body.transaction_type, "saas");
    assert.equal("work_type" in body, false);
  }
});

test("explicit work_type overrides the description guess", () => {
  const body = send({ work_type: "content", description: "GPU inference credits" });
  assert.equal(body.work_type, "content");
  assert.equal(body.transaction_type, "saas");
});

test("every explicit work_type maps to a transaction_type", () => {
  const expected = {
    compute: "compute", research: "api_access", information_service: "api_access",
    content: "saas", consulting: "consulting", trading: "digital_good",
  };
  for (const [wt, tx] of Object.entries(expected)) assert.equal(send({ work_type: wt }).transaction_type, tx, wt);
});

test("is_b2b is sent only when the caller gave a boolean", () => {
  assert.equal("is_b2b" in send({}), false);
  assert.equal(send({ is_b2b: false }).is_b2b, false);
  assert.equal(send({ is_b2b: true }).is_b2b, true);
});

test("counterparty_id, role and amounts carried through", () => {
  const body = send({ buyer_zip: "85004" });
  assert.equal(body.role, "seller");
  assert.equal(body.counterparty_id, "pi_1");
  assert.equal(body.amount, 100);
  assert.equal(body.buyer_state, "AZ");
  assert.equal(body.buyer_zip, "85004");
  const generated = buildTrackPaymentRequest({ amount: 5, buyer_state: "TX" }, { now: () => 42 }).body;
  assert.equal(generated.counterparty_id, "payment_42");
});

test("guessWorkType returns null when nothing matches", () => {
  assert.equal(guessWorkType("MCP tool subscription"), null);
  assert.equal(guessWorkType(undefined), null);
});

// ── end to end through the stdio server ──────────────────────────────────
async function callTools(calls) {
  const received = [];
  const api = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = data ? JSON.parse(data) : null;
      received.push({ method: req.method, url: req.url, body });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: true, total_tax: 0, work_type: body?.work_type ?? null, transaction_id: "t1" }));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const port = api.address().port;
  const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
  const child = spawn(process.execPath, [indexPath], {
    env: { ...process.env, AGENTTAX_BASE_URL: `http://127.0.0.1:${port}`, AGENTTAX_API_KEY: "" },
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
      for (let n = 0; n < 400 && !responses.has(id); n++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(responses.has(id), `no response for id ${id}`);
      return responses.get(id);
    };
    write({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    await waitFor(0);
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    const results = [];
    for (let k = 0; k < calls.length; k++) {
      write({ jsonrpc: "2.0", id: k + 1, method: "tools/call", params: calls[k] });
      results.push(await waitFor(k + 1));
    }
    return { received, results };
  } finally {
    child.kill(); // only the child this test spawned
    await new Promise((r) => api.close(r));
  }
}

test("end to end: track_payment and calculate_tax send only declared work types", async () => {
  const { received, results } = await callTools([
    { name: "track_payment", arguments: { amount: 100, buyer_state: "AZ", description: "SOC 2 audit platform subscription", payment_id: "pi_a" } },
    { name: "track_payment", arguments: { amount: 100, buyer_state: "AZ", description: "SOC 2 audit platform subscription", work_type: "consulting", payment_id: "pi_b" } },
    { name: "calculate_tax", arguments: { role: "seller", amount: 100, buyer_state: "AZ", transaction_type: "consulting", work_type: "consulting", counterparty_id: "c1" } },
    { name: "calculate_tax", arguments: { role: "seller", amount: 100, buyer_state: "AZ", transaction_type: "saas", counterparty_id: "c2" } },
  ]);
  for (const r of results) assert.ok(r.result && !r.result.isError, JSON.stringify(r));
  assert.equal(received.length, 4);
  assert.ok(received.every((r) => r.method === "POST" && r.url === "/api/v1/calculate"));

  // guessed consulting: not sent
  assert.equal(received[0].body.transaction_type, "saas");
  assert.equal("work_type" in received[0].body, false);
  assert.equal("is_b2b" in received[0].body, false);
  const summary = JSON.parse(results[0].result.content[0].text);
  assert.equal(summary.classification.guess_not_used, "consulting");

  // declared consulting: sent
  assert.equal(received[1].body.work_type, "consulting");
  assert.equal(received[1].body.transaction_type, "consulting");

  // calculate_tax passes the caller's fields through unchanged
  assert.equal(received[2].body.work_type, "consulting");
  assert.equal(received[2].body.transaction_type, "consulting");
  assert.equal("work_type" in received[3].body, false);
  assert.equal(received[3].body.transaction_type, "saas");
});
