/**
 * EP-007 — Writer Selection tests.
 * Run: node test/writer-selection-test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  selectStoriesForWriter,
  toWriterStoriesInput,
} = require("../lib/writer-selection");
const { selectRelevantStories } = require("../lib/writer-content");

function story(id) {
  return {
    id,
    label: id,
    description: `desc ${id}`,
    concepts: [
      {
        label: id,
        summary: `${id} event`,
        posts: [
          {
            authorHandle: `@${id}`,
            postedAt: "2026-07-15T12:00:00.000Z",
            text: `${id} 開催`,
            url: `https://x.com/${id}/1`,
          },
        ],
        postCount: 1,
      },
    ],
    posts: [
      {
        authorHandle: `@${id}`,
        postedAt: "2026-07-15T12:00:00.000Z",
        text: `${id} 開催`,
        url: `https://x.com/${id}/1`,
      },
    ],
    postCount: 1,
  };
}

function editorWithSelected(selected) {
  return {
    topics: [],
    decisions: [],
    ranking: [],
    edition: {
      version: "1.0",
      selected,
      omitted: [],
      summary: {},
    },
  };
}

function sel(storyId, position, extras = {}) {
  return {
    storyId,
    position,
    section: extras.section || "top",
    rank: extras.rank != null ? extras.rank : position,
    score: extras.score != null ? extras.score : 90 - position,
  };
}

function case1SelectedOne() {
  const stories = { stories: [story("a"), story("b"), story("c")] };
  const editor = editorWithSelected([sel("b", 1, { section: "top" })]);
  const result = selectStoriesForWriter({ editor, stories, requireEdition: true });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.selectedStories.length, 1);
  assert.strictEqual(result.selectedStories[0].storyId, "b");
  const ids = result.selectedStories.map((s) => s.storyId);
  assert.ok(!ids.includes("a"));
  assert.ok(!ids.includes("c"));
  console.log("PASS Case 1: selected 1");
}

function case2SelectedThree() {
  const stories = {
    stories: [story("a"), story("b"), story("c"), story("d"), story("e")],
  };
  const editor = editorWithSelected([
    sel("a", 1, { section: "top" }),
    sel("b", 2, { section: "secondary" }),
    sel("c", 3, { section: "secondary" }),
  ]);
  const result = selectStoriesForWriter({ editor, stories, requireEdition: true });
  assert.strictEqual(result.selectedStories.length, 3);
  assert.deepStrictEqual(
    result.selectedStories.map((s) => s.storyId),
    ["a", "b", "c"]
  );
  assert.ok(!result.selectedStories.some((s) => s.storyId === "d"));
  console.log("PASS Case 2: selected 3 in position order");
}

function case3OrderDiffersFromStoryArray() {
  const stories = { stories: [story("c"), story("a"), story("b")] };
  const editor = editorWithSelected([
    sel("a", 1),
    sel("b", 2),
    sel("c", 3),
  ]);
  const result = selectStoriesForWriter({ editor, stories, requireEdition: true });
  assert.deepStrictEqual(
    result.selectedStories.map((s) => s.storyId),
    ["a", "b", "c"]
  );
  const input = toWriterStoriesInput(result, stories);
  assert.deepStrictEqual(
    input.stories.map((s) => s.id),
    ["a", "b", "c"]
  );
  const preserved = selectRelevantStories(input, {});
  assert.deepStrictEqual(
    preserved.map((s) => s.id),
    ["a", "b", "c"]
  );
  console.log("PASS Case 3: selected order over story array order");
}

function case4HoldRejectPresent() {
  const stories = {
    stories: [story("ok"), story("hold"), story("rej")],
  };
  const editor = editorWithSelected([sel("ok", 1)]);
  editor.decisions = [
    { storyId: "ok", decision: "accept", reason: [] },
    { storyId: "hold", decision: "hold", reason: [] },
    { storyId: "rej", decision: "reject", reason: [] },
  ];
  const result = selectStoriesForWriter({ editor, stories, requireEdition: true });
  assert.deepStrictEqual(
    result.selectedStories.map((s) => s.storyId),
    ["ok"]
  );
  console.log("PASS Case 4: hold/reject not selected");
}

function case5RankedButNotSelected() {
  const stories = { stories: [story("top"), story("other")] };
  const editor = editorWithSelected([sel("other", 1)]);
  editor.ranking = [
    { storyId: "top", rank: 1, score: 99 },
    { storyId: "other", rank: 2, score: 80 },
  ];
  const result = selectStoriesForWriter({ editor, stories, requireEdition: true });
  assert.deepStrictEqual(
    result.selectedStories.map((s) => s.storyId),
    ["other"]
  );
  assert.ok(!result.selectedStories.some((s) => s.storyId === "top"));
  console.log("PASS Case 5: ranking alone does not select");
}

function case6DuplicateSelected() {
  const stories = { stories: [story("dup")] };
  const editor = editorWithSelected([
    sel("dup", 1, { section: "top", score: 90 }),
    sel("dup", 2, { section: "secondary", score: 80 }),
  ]);
  const result = selectStoriesForWriter({ editor, stories, requireEdition: true });
  assert.strictEqual(result.selectedStories.length, 1);
  assert.strictEqual(result.summary.duplicateCount, 1);
  assert.ok(
    result.warnings.some((w) => w.code === "duplicate-selected-story")
  );
  console.log("PASS Case 6: duplicate selected");
}

function case7MissingStory() {
  const stories = { stories: [story("real")] };
  const editor = editorWithSelected([
    sel("ghost", 1),
    sel("real", 2, { section: "secondary" }),
  ]);
  const result = selectStoriesForWriter({ editor, stories, requireEdition: true });
  assert.deepStrictEqual(
    result.selectedStories.map((s) => s.storyId),
    ["real"]
  );
  assert.ok(
    result.warnings.some(
      (w) => w.code === "selected-story-not-found" && w.storyId === "ghost"
    )
  );
  assert.ok(!result.selectedStories.some((s) => s.storyId === "ghost"));
  console.log("PASS Case 7: missing story warning, no promote");
}

function case8EmptySelected() {
  const stories = { stories: [story("a"), story("b")] };
  const editor = editorWithSelected([]);
  const result = selectStoriesForWriter({ editor, stories, requireEdition: true });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.selectedStories.length, 0);
  assert.strictEqual(result.summary.resolvedCount, 0);
  const input = toWriterStoriesInput(result, stories);
  assert.strictEqual(input.stories.length, 0);
  console.log("PASS Case 8: empty selection");
}

function case9EditionMissing() {
  const stories = { stories: [story("a")] };
  const pipeline = selectStoriesForWriter({
    editor: { topics: [], decisions: [] },
    stories,
    requireEdition: true,
  });
  assert.strictEqual(pipeline.ok, false);
  assert.strictEqual(pipeline.error, "edition-required");
  assert.strictEqual(pipeline.selectedStories.length, 0);

  const compat = selectStoriesForWriter({
    editor: { topics: [] },
    stories,
    requireEdition: false,
  });
  assert.strictEqual(compat.ok, true);
  assert.strictEqual(compat.mode, "compat");
  assert.strictEqual(compat.selectedStories.length, 1);
  console.log("PASS Case 9: edition missing (pipeline error / CLI compat)");
}

function case10MetadataPreserved() {
  const stories = { stories: [story("m1")] };
  const editor = editorWithSelected([
    sel("m1", 1, { section: "top", rank: 1, score: 92 }),
  ]);
  const result = selectStoriesForWriter({ editor, stories, requireEdition: true });
  const item = result.selectedStories[0];
  assert.strictEqual(item.position, 1);
  assert.strictEqual(item.section, "top");
  assert.strictEqual(item.rank, 1);
  assert.strictEqual(item.score, 92);
  const input = toWriterStoriesInput(result, stories);
  assert.strictEqual(input.__writerSelection.editionContext[0].score, 92);
  console.log("PASS Case 10: metadata preserved");
}

function case11Determinism() {
  const stories = { stories: [story("c"), story("a"), story("b")] };
  const editor = editorWithSelected([
    sel("b", 2, { section: "secondary" }),
    sel("a", 1, { section: "top" }),
    sel("c", 3, { section: "brief" }),
  ]);
  const a = selectStoriesForWriter({ editor, stories, requireEdition: true });
  const b = selectStoriesForWriter({ editor, stories, requireEdition: true });
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(toWriterStoriesInput(a), toWriterStoriesInput(b));
  console.log("PASS Case 11: determinism");
}

function case12RegressionEditorUnchanged() {
  const stories = { stories: [story("a"), story("b")] };
  const editor = editorWithSelected([sel("a", 1)]);
  editor.decisions = [{ storyId: "a", decision: "accept", reason: [] }];
  editor.ranking = [{ storyId: "a", rank: 1, score: 90 }];
  const before = JSON.stringify(editor);
  selectStoriesForWriter({ editor, stories, requireEdition: true });
  assert.strictEqual(JSON.stringify(editor), before, "editor.json not mutated");
  console.log("PASS Case 12: editor unchanged");
}

function integrationFixture() {
  // A,B selected; C omitted capacity; D hold; E reject
  const stories = {
    stories: [
      story("A"),
      story("B"),
      story("C"),
      story("D"),
      story("E"),
    ],
  };
  const editor = editorWithSelected([
    sel("A", 1, { section: "top", rank: 1, score: 95 }),
    sel("B", 2, { section: "secondary", rank: 2, score: 88 }),
  ]);
  editor.edition.omitted = [
    { storyId: "C", reasonCode: "edition-capacity" },
  ];
  editor.decisions = [
    { storyId: "A", decision: "accept", reason: [] },
    { storyId: "B", decision: "accept", reason: [] },
    { storyId: "C", decision: "accept", reason: [] },
    { storyId: "D", decision: "hold", reason: [] },
    { storyId: "E", decision: "reject", reason: [] },
  ];
  editor.ranking = [
    { storyId: "A", rank: 1, score: 95 },
    { storyId: "B", rank: 2, score: 88 },
    { storyId: "C", rank: 3, score: 70 },
  ];
  const before = JSON.stringify(editor);
  const result = selectStoriesForWriter({ editor, stories, requireEdition: true });
  assert.deepStrictEqual(
    result.selectedStories.map((s) => s.storyId),
    ["A", "B"]
  );
  assert.strictEqual(JSON.stringify(editor), before);
  console.log("PASS Integration: A,B only in order");
}

function main() {
  case1SelectedOne();
  case2SelectedThree();
  case3OrderDiffersFromStoryArray();
  case4HoldRejectPresent();
  case5RankedButNotSelected();
  case6DuplicateSelected();
  case7MissingStory();
  case8EmptySelected();
  case9EditionMissing();
  case10MetadataPreserved();
  case11Determinism();
  case12RegressionEditorUnchanged();
  integrationFixture();
  console.log("\nAll Writer Selection (EP-007) cases PASS");
}

main();
