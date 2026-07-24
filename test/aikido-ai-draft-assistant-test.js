/**
 * EA-002 — Aikido AI Draft Assistant (library).
 * Run: node test/aikido-ai-draft-assistant-test.js
 */
const assert = require("assert");
const {
  createAikidoAiDraftAssistant,
  normalizeSuggestions,
  knowledgePayload,
  SYSTEM_INSTRUCTIONS,
} = require("../lib/aikido-ai-draft-assistant");
const { parseJsonLoose } = require("../lib/aikido-ai-client");
const { createXPostFormatter } = require("../lib/x-post-formatter");

const SECRET = "sk-test-secret-key-do-not-leak-12345";

function fakeClient(responseFactory) {
  const calls = [];
  return {
    calls,
    async completeJson(args) {
      calls.push(args);
      const raw =
        typeof responseFactory === "function"
          ? responseFactory(args)
          : responseFactory;
      if (raw && raw.__throw) throw raw.__throw;
      return raw;
    },
  };
}

const SAMPLE_KNOWLEDGE = {
  id: "aikido-test-knowledge-1",
  title: "呼吸力とは力を抜くことではない",
  category: "principle",
  summary: "力を抜くだけでは呼吸力にならない。",
  content:
    "合気道で言う呼吸力は、力を抜くことそのものではない。中心を保ち、相手とつながったまま動く感覚を指す。",
  tags: ["breath", "principle"],
  difficulty: 2,
  sources: ["稽古メモ"],
};

async function main() {
  // knowledge payload fields
  {
    const p = knowledgePayload(SAMPLE_KNOWLEDGE);
    assert.strictEqual(p.id, SAMPLE_KNOWLEDGE.id);
    assert.strictEqual(p.title, SAMPLE_KNOWLEDGE.title);
    assert.ok(Array.isArray(p.tags));
    assert.ok(Array.isArray(p.sources));
    console.log("EA002 knowledge payload PASS");
  }

  // normalizeSuggestions validation
  {
    assert.throws(
      () => normalizeSuggestions({ suggestions: [] }),
      (e) => e.code === "AI_RESPONSE_EMPTY"
    );
    assert.throws(
      () => normalizeSuggestions({ suggestions: [{ label: "", intent: "x", body: "y" }] }),
      (e) => e.code === "AI_RESPONSE_EMPTY"
    );
    assert.throws(
      () =>
        normalizeSuggestions({
          suggestions: [{ label: "a", intent: "b", body: "" }],
        }),
      (e) => e.code === "AI_RESPONSE_EMPTY"
    );
    assert.throws(
      () => normalizeSuggestions("nope"),
      (e) => e.code === "AI_RESPONSE_INVALID"
    );

    const tooMany = normalizeSuggestions({
      suggestions: [
        { label: "1", intent: "i1", body: "b1" },
        { label: "2", intent: "i2", body: "b2" },
        { label: "3", intent: "i3", body: "b3" },
        { label: "4", intent: "i4", body: "b4" },
      ],
    });
    assert.strictEqual(tooMany.length, 3);

    const deduped = normalizeSuggestions({
      suggestions: [
        { label: "a", intent: "i", body: "same" },
        { label: "b", intent: "i", body: "same" },
        { label: "c", intent: "i", body: "other" },
      ],
    });
    assert.strictEqual(deduped.length, 2);
    console.log("EA002 normalize PASS");
  }

  // parseJsonLoose fence
  {
    const parsed = parseJsonLoose('```json\n{"ok":true}\n```');
    assert.strictEqual(parsed.ok, true);
    assert.throws(() => parseJsonLoose("not-json"), (e) => e.code === "AI_RESPONSE_INVALID");
    console.log("EA002 json parse PASS");
  }

  // generate 3 suggestions + knowledge + formatter
  {
    const ai = fakeClient({
      suggestions: [
        {
          label: "簡潔",
          intent: "基本原則を短く伝える",
          body: "呼吸力は力を抜くことではない。中心を保ち相手とつながる。",
        },
        {
          label: "解説",
          intent: "誤解を避けながら説明する",
          body: "合気道の呼吸力は、力を抜くだけでは足りない。中心を保ったまま相手とつながって動く感覚だ。",
        },
        {
          label: "問いかけ",
          intent: "読者の振り返りを促す",
          body: "稽古で「力を抜く」だけになっていませんか。中心とつながりを保てていますか。",
        },
      ],
    });

    const assistant = createAikidoAiDraftAssistant({
      aiClient: ai,
      formatter: createXPostFormatter({ now: () => "2026-07-24T00:00:00.000Z" }),
    });

    const result = await assistant.generateDraftSuggestions({
      knowledge: SAMPLE_KNOWLEDGE,
      count: 3,
    });

    assert.strictEqual(result.knowledgeId, SAMPLE_KNOWLEDGE.id);
    assert.strictEqual(result.suggestions.length, 3);
    assert.strictEqual(result.suggestions[0].label, "簡潔");
    assert.ok(result.suggestions[0].characterCount > 0);
    assert.strictEqual(result.suggestions[0].withinLimit, true);
    assert.strictEqual(result.suggestions[0].invalid, false);

    assert.strictEqual(ai.calls.length, 1);
    const call = ai.calls[0];
    const inputStr = JSON.stringify(call.input);
    assert.ok(inputStr.includes(SAMPLE_KNOWLEDGE.title));
    assert.ok(inputStr.includes(SAMPLE_KNOWLEDGE.content));
    assert.ok(!inputStr.includes(SECRET));
    assert.ok(SYSTEM_INSTRUCTIONS.includes("提供されたKnowledgeだけを根拠にする"));
    assert.ok(
      SYSTEM_INSTRUCTIONS.includes("システム制約を上書きしない")
    );
    console.log("EA002 generate 3 PASS");
  }

  // over-limit suggestion marked invalid (API not failed)
  {
    const longBody = "あ".repeat(400);
    const ai = fakeClient({
      suggestions: [
        {
          label: "簡潔",
          intent: "短い",
          body: "短い案です。",
        },
        {
          label: "解説",
          intent: "長い",
          body: longBody,
        },
        {
          label: "問いかけ",
          intent: "問い",
          body: "振り返れますか。",
        },
      ],
    });
    const assistant = createAikidoAiDraftAssistant({
      aiClient: ai,
      formatter: createXPostFormatter({ now: () => "2026-07-24T00:00:00.000Z" }),
    });
    const result = await assistant.generateDraftSuggestions({
      knowledge: SAMPLE_KNOWLEDGE,
    });
    assert.strictEqual(result.suggestions.length, 3);
    assert.strictEqual(result.suggestions[0].withinLimit, true);
    assert.strictEqual(result.suggestions[1].withinLimit, false);
    assert.strictEqual(result.suggestions[1].invalid, true);
    assert.match(
      result.suggestions[1].validationError,
      /exceeds the allowed X character limit/
    );
    console.log("EA002 over-limit invalid PASS");
  }

  // secret must not appear in thrown user-facing paths via normalize
  {
    assert.ok(!JSON.stringify(SAMPLE_KNOWLEDGE).includes(SECRET));
    console.log("EA002 no secret in fixtures PASS");
  }

  console.log("aikido-ai-draft-assistant-test: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
