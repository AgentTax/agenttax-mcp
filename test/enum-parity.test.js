// node --test. The MCP server's enums must equal the AgentTax API's, or an
// MCP caller is refused (or silently loses) a value the API accepts.
//
// test/fixtures/api-calculate-enums.json is a copy of the API's current
// values. To refresh it after an API change, from a checkout of the AgentTax
// repo (AgentTax/AgentTax) run:
//
//   node -e "import('./api/_lib/schemas/common.js').then(m=>{const k=['TRANSACTION_TYPES','WORK_TYPES','PAYMENT_PROVIDER_TYPES','IT_SUPPORT_SCOPES','CUSTOM_SOFTWARE_DELIVERABLES','CUSTOM_SOFTWARE_DELIVERY','MAINTENANCE_UPDATE_DELIVERY','MAINTENANCE_SUPPORT_KINDS','DIGITAL_CONTENT_TYPES'];const o={_source:'AgentTax api/_lib/schemas/common.js @ '+require('child_process').execSync('git rev-parse --short HEAD').toString().trim()};for(const x of k)o[x]=m[x];require('fs').writeFileSync('<path to agenttax-mcp>/test/fixtures/api-calculate-enums.json',JSON.stringify(o,null,2)+'\n')})"
//
// then update classify.js until this test passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as classify from "../classify.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/api-calculate-enums.json", import.meta.url), "utf8"));

const ENUMS = [
  "TRANSACTION_TYPES",
  "WORK_TYPES",
  "PAYMENT_PROVIDER_TYPES",
  "IT_SUPPORT_SCOPES",
  "CUSTOM_SOFTWARE_DELIVERABLES",
  "CUSTOM_SOFTWARE_DELIVERY",
  "MAINTENANCE_UPDATE_DELIVERY",
  "MAINTENANCE_SUPPORT_KINDS",
  "DIGITAL_CONTENT_TYPES",
];

test("the fixture carries every enum this test checks", () => {
  for (const name of ENUMS) assert.ok(Array.isArray(fixture[name]) && fixture[name].length > 0, `fixture lacks ${name}`);
});

for (const name of ENUMS) {
  test(`${name} matches the API`, () => {
    assert.deepEqual(classify[name], fixture[name]);
  });
}

test("every work_type track_payment maps has a transaction_type the API accepts", () => {
  for (const wt of classify.WORK_TYPES) {
    assert.ok(classify.TRANSACTION_TYPES.includes(classify.WORK_TYPE_TO_TX_TYPE[wt]), `${wt} -> ${classify.WORK_TYPE_TO_TX_TYPE[wt]}`);
  }
});
