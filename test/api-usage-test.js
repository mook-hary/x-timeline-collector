/**
 * EP-030 — API usage helper tests (no OpenAI calls).
 * Run: node test/api-usage-test.js
 */
const assert = require("assert");
const {
  emptyUsage,
  extractUsageFromResponse,
  addUsage,
  formatUsageBlock,
  formatUsageMarker,
  parseUsageFromOutput,
  formatMorningUsageSummary,
} = require("../lib/api-usage");

{
  const missing = extractUsageFromResponse(null);
  assert.deepStrictEqual(missing, {
    requests: 1,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  });

  const responsesApi = extractUsageFromResponse({
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
  });
  assert.deepStrictEqual(responsesApi, {
    requests: 1,
    input_tokens: 10,
    output_tokens: 3,
    total_tokens: 13,
  });

  const chatStyle = extractUsageFromResponse({
    usage: { prompt_tokens: 7, completion_tokens: 2 },
  });
  assert.strictEqual(chatStyle.input_tokens, 7);
  assert.strictEqual(chatStyle.output_tokens, 2);
  assert.strictEqual(chatStyle.total_tokens, 9);
  console.log("extract PASS");
}

{
  let totals = emptyUsage();
  totals = addUsage(totals, {
    requests: 1,
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
  });
  totals = addUsage(totals, {
    requests: 1,
    input_tokens: 50,
    output_tokens: 10,
    total_tokens: 60,
  });
  assert.deepStrictEqual(totals, {
    requests: 2,
    input_tokens: 150,
    output_tokens: 30,
    total_tokens: 180,
  });
  // cache path: do not addUsage → requests stay same
  assert.strictEqual(emptyUsage().requests, 0);
  console.log("add PASS");
}

{
  const block = formatUsageBlock("Analyze", {
    requests: 18,
    input_tokens: 12340,
    output_tokens: 2410,
    total_tokens: 14750,
  });
  assert.ok(block.includes("Analyze Usage"));
  assert.ok(block.includes("Requests : 18"));
  assert.ok(block.includes("Input     : 12340"));
  assert.ok(block.includes("Output    : 2410"));
  assert.ok(block.includes("Total     : 14750"));

  const marker = formatUsageMarker("Analyze", {
    requests: 18,
    input_tokens: 12340,
    output_tokens: 2410,
    total_tokens: 14750,
  });
  const parsed = parseUsageFromOutput(`noise\n${marker}\n`);
  assert.strictEqual(parsed.label, "Analyze");
  assert.strictEqual(parsed.requests, 18);
  assert.strictEqual(parsed.total_tokens, 14750);
  console.log("format/parse PASS");
}

{
  const summary = formatMorningUsageSummary({
    analyze: {
      requests: 18,
      input_tokens: 12340,
      output_tokens: 2410,
      total_tokens: 14750,
    },
    enrich: {
      requests: 23,
      input_tokens: 14901,
      output_tokens: 4281,
      total_tokens: 19182,
    },
  });
  assert.ok(summary.includes("Morning Summary"));
  assert.ok(summary.includes("Grand Total"));
  assert.ok(summary.includes("Requests : 41"));
  assert.ok(summary.includes("Total    : 33932"));
  console.log("morning-summary PASS");
}

console.log("api-usage-test: ALL PASS");
