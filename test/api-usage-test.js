/**
 * EP-030 / EP-032 — API usage + cost estimate helper tests (no OpenAI calls).
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
  estimateApiCost,
  resolveModelPricing,
  resolveUsageModel,
  formatUsd,
  formatEstimatedCostSection,
  MODEL_PRICING,
  DEFAULT_USAGE_MODEL,
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
  assert.ok(marker.startsWith("[api-usage] "));
  const parsed = parseUsageFromOutput(`noise\n${marker}\n`);
  assert.strictEqual(parsed.label, "Analyze");
  assert.strictEqual(parsed.requests, 18);
  assert.strictEqual(parsed.total_tokens, 14750);
  // marker payload shape unchanged (no cost fields)
  const payload = JSON.parse(marker.slice("[api-usage] ".length));
  assert.deepStrictEqual(Object.keys(payload).sort(), [
    "input_tokens",
    "label",
    "output_tokens",
    "requests",
    "total_tokens",
  ]);
  console.log("format/parse PASS");
}

{
  assert.strictEqual(MODEL_PRICING["gpt-5-mini"].inputPerMillion, 0.25);
  assert.strictEqual(MODEL_PRICING["gpt-5-mini"].outputPerMillion, 2.0);

  const both = estimateApiCost({
    inputTokens: 27241,
    outputTokens: 6691,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 2.0,
  });
  assert.strictEqual(both.inputCostUsd, (27241 / 1_000_000) * 0.25);
  assert.strictEqual(both.outputCostUsd, (6691 / 1_000_000) * 2.0);
  assert.strictEqual(
    both.totalCostUsd,
    both.inputCostUsd + both.outputCostUsd
  );
  assert.ok(Math.abs(both.inputCostUsd - 0.00681025) < 1e-12);
  assert.ok(Math.abs(both.outputCostUsd - 0.013382) < 1e-12);
  assert.ok(Math.abs(both.totalCostUsd - 0.02019225) < 1e-12);
  assert.strictEqual(formatUsd(both.totalCostUsd), "$0.0202");
  assert.strictEqual(formatUsd(both.inputCostUsd), "$0.0068");
  assert.strictEqual(formatUsd(both.outputCostUsd), "$0.0134");

  const inputOnly = estimateApiCost({
    inputTokens: 27241,
    outputTokens: 0,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 2.0,
  });
  assert.strictEqual(inputOnly.inputCostUsd, both.inputCostUsd);
  assert.strictEqual(inputOnly.outputCostUsd, 0);
  assert.strictEqual(inputOnly.totalCostUsd, both.inputCostUsd);

  const outputOnly = estimateApiCost({
    inputTokens: 0,
    outputTokens: 6691,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 2.0,
  });
  assert.strictEqual(outputOnly.inputCostUsd, 0);
  assert.strictEqual(outputOnly.outputCostUsd, both.outputCostUsd);
  assert.strictEqual(outputOnly.totalCostUsd, both.outputCostUsd);

  const zero = estimateApiCost({
    inputTokens: 0,
    outputTokens: 0,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 2.0,
  });
  assert.deepStrictEqual(zero, {
    inputCostUsd: 0,
    outputCostUsd: 0,
    totalCostUsd: 0,
  });
  assert.strictEqual(formatUsd(0), "$0.0000");
  assert.strictEqual(formatUsd(0.00005), "$0.000050");

  const again = estimateApiCost({
    inputTokens: 27241,
    outputTokens: 6691,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 2.0,
  });
  assert.deepStrictEqual(again, both);
  console.log("estimate cost PASS");
}

{
  assert.deepStrictEqual(resolveModelPricing("gpt-5-mini"), {
    modelKey: "gpt-5-mini",
    inputPerMillion: 0.25,
    outputPerMillion: 2.0,
  });
  assert.deepStrictEqual(resolveModelPricing("gpt-5-mini-2025-08-07"), {
    modelKey: "gpt-5-mini",
    inputPerMillion: 0.25,
    outputPerMillion: 2.0,
  });
  assert.strictEqual(resolveModelPricing("gpt-4o-mini"), null);
  assert.strictEqual(resolveModelPricing(""), null);

  const unavailable = formatEstimatedCostSection(
    { input_tokens: 10, output_tokens: 2 },
    "unknown-model-xyz"
  );
  assert.ok(unavailable.includes("Estimated Cost: unavailable"));
  assert.ok(
    unavailable.includes(
      "Reason: pricing is not configured for unknown-model-xyz"
    )
  );
  assert.ok(unavailable.includes("Estimate only; actual billing may differ."));
  console.log("pricing resolve PASS");
}

{
  const summary = formatMorningUsageSummary(
    {
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
    },
    { model: "gpt-5-mini" }
  );
  assert.ok(summary.includes("Morning Summary"));
  assert.ok(summary.includes("Grand Total"));
  assert.ok(summary.includes("Requests : 41"));
  assert.ok(summary.includes("Input    : 27241"));
  assert.ok(summary.includes("Output   : 6691"));
  assert.ok(summary.includes("Total    : 33932"));
  assert.ok(summary.includes("Estimated Cost"));
  assert.ok(summary.includes("Model  : gpt-5-mini"));
  assert.ok(summary.includes("Input  : $0.0068"));
  assert.ok(summary.includes("Output : $0.0134"));
  assert.ok(summary.includes("Total  : $0.0202"));
  assert.ok(summary.includes("Estimate only; actual billing may differ."));

  const snap = formatMorningUsageSummary(
    {
      analyze: emptyUsage(),
      enrich: emptyUsage(),
    },
    { model: "gpt-5-mini-2025-08-07" }
  );
  assert.ok(snap.includes("Model  : gpt-5-mini-2025-08-07"));
  assert.ok(snap.includes("Total  : $0.0000"));

  const unknown = formatMorningUsageSummary(
    { analyze: emptyUsage(), enrich: emptyUsage() },
    { model: "gpt-99" }
  );
  assert.ok(unknown.includes("Estimated Cost: unavailable"));
  assert.ok(unknown.includes("pricing is not configured for gpt-99"));

  assert.strictEqual(resolveUsageModel("explicit"), "explicit");
  assert.strictEqual(DEFAULT_USAGE_MODEL, "gpt-5-mini");
  console.log("morning-summary PASS");
}

console.log("api-usage-test: ALL PASS");
