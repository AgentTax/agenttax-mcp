// node --test. Pins the public tool surface of the server: the 15 tool names
// the website (agenttax.io/integrations/mcp) and the README promise, and the
// work_type enum both calculate_tax and track_payment accept. Talks to the
// real server over stdio, no network: AGENTTAX_BASE_URL points at a port
// nothing listens on and tools/list never calls the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WORK_TYPES } from "../classify.js";

// The order is the order index.js registers them in; the set is what matters.
export const TOOL_NAMES = [
  "calculate_tax",
  "track_payment",
  "ingest_transactions",
  "list_transactions",
  "log_trade",
  "list_trades",
  "export_1099_da",
  "get_rates",
  "get_local_rate",
  "get_capital_gains_rates",
  "get_nexus_thresholds",
  "get_nexus",
  "configure_nexus",
  "get_pricing",
  "check_health",
];

const API_WORK_TYPES = [
  "compute", "research", "information_service", "content", "consulting", "trading",
  "payment_processing", "web_hosting", "software_maintenance", "it_support", "custom_software",
];

async function listTools() {
  const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
  const child = spawn(process.execPath, [indexPath], {
    env: { ...process.env, AGENTTAX_BASE_URL: "http://127.0.0.1:9", AGENTTAX_API_KEY: "" },
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
      const deadline = Date.now() + 15000;
      while (!responses.has(id)) {
        if (Date.now() > deadline) throw new Error(`no response for id ${id}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return responses.get(id);
    };
    write({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    await waitFor(0);
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    write({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await waitFor(1);
    return res.result.tools;
  } finally {
    child.kill(); // only the child this test spawned
  }
}

test("the server exposes exactly the 15 documented tools", async () => {
  const tools = await listTools();
  assert.deepEqual([...tools.map((t) => t.name)].sort(), [...TOOL_NAMES].sort());
  for (const t of tools) assert.ok(t.description && t.description.length > 20, `${t.name} has no description`);
});

test("calculate_tax and track_payment accept every work_type the API accepts", async () => {
  assert.deepEqual(WORK_TYPES, API_WORK_TYPES);
  const tools = await listTools();
  for (const name of ["calculate_tax", "track_payment"]) {
    const tool = tools.find((t) => t.name === name);
    const wt = tool.inputSchema.properties.work_type;
    assert.ok(wt, `${name} has no work_type`);
    const values = wt.enum || wt.anyOf?.find((x) => x.enum)?.enum;
    assert.deepEqual(values, API_WORK_TYPES, `${name} work_type enum`);
  }
});
