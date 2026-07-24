/**
 * EP-039 — Today's Picks selection quality.
 * Run: node test/today-picks-test.js
 */
const assert = require("assert");
const {
  normalizeArticleText,
  normalizeArticleUrl,
  calculateTextSimilarity,
  isExactDuplicate,
  isNearDuplicate,
  selectRepresentativeArticle,
  selectTodayPicks,
  categorySoftCap,
  extractStatusId,
} = require("../lib/today-picks");

function post(overrides = {}) {
  const {
    url = "https://x.com/user/status/1",
    text = "本文",
    category = "AI",
    importance = 4,
    summary = "十分な長さのある要約テキストです。",
    reason = "注目理由あり",
    tags = ["t"],
    postedAt = "2026-07-14T12:00:00.000Z",
    authorHandle,
    ...rest
  } = overrides;
  const enrichment = {
    importance,
    summary,
    reason,
    tags,
    ...(rest.enrichment || {}),
  };
  return {
    postedAt,
    url,
    text,
    authorHandle,
    finalAnalysis: { category, ...(rest.finalAnalysis || {}) },
    enrichment,
    ...rest,
  };
}

function urls(picks) {
  return picks.map((p) => p.url);
}

// --- Normalization ---
{
  assert.strictEqual(
    normalizeArticleText("  Hello  WORLD! 🚀 https://ex.com/a  "),
    "hello world"
  );
  assert.ok(normalizeArticleText("ＡＩ発表").includes("ai") || normalizeArticleText("ＡＩ発表").includes("ａｉ") === false);
  // NFKC folds fullwidth Latin
  assert.strictEqual(normalizeArticleText("ＡＩ"), "ai");
  console.log("EP039 normalize-text PASS");
}

{
  const a = normalizeArticleUrl(
    "https://www.x.com/foo/status/123?utm_source=tw&s=20"
  );
  const b = normalizeArticleUrl("https://twitter.com/foo/status/123");
  assert.strictEqual(a, b);
  assert.strictEqual(extractStatusId("https://x.com/a/status/999"), "999");
  console.log("EP039 normalize-url PASS");
}

// --- Exact duplicate ---
{
  const a = post({ url: "https://x.com/a/status/10" });
  const b = post({ url: "https://x.com/a/status/10?utm_campaign=x" });
  assert.ok(isExactDuplicate(a, b));
  console.log("EP039 exact-url-tracking PASS");
}

{
  const a = post({
    url: "https://x.com/a/status/1",
    text: "OpenAIが新機能を発表",
    summary: "s1",
  });
  const b = post({
    url: "https://x.com/b/status/2",
    text: "OpenAIが新機能を発表",
    summary: "s2",
  });
  assert.ok(isExactDuplicate(a, b));
  console.log("EP039 exact-title PASS");
}

{
  const a = post({ url: "https://x.com/a/status/77" });
  const b = post({ url: "https://twitter.com/a/status/77" });
  assert.ok(isExactDuplicate(a, b));
  console.log("EP039 exact-status-id PASS");
}

// --- Near duplicate ---
{
  const a = post({
    url: "https://x.com/a/status/1",
    text: "OpenAIがGPT新機能を正式発表した",
    summary: "OpenAIがGPTの大型新機能を公式に発表したという内容。",
    category: "AI",
  });
  const b = post({
    url: "https://x.com/b/status/2",
    text: "【速報】OpenAI GPT新機能の発表まとめ",
    summary: "OpenAIによるGPT大型新機能の公式発表についての紹介。",
    category: "AI",
  });
  assert.ok(isNearDuplicate(a, b));
  console.log("EP039 near-dup-announcement PASS");
}

{
  const a = post({
    url: "https://x.com/a/status/1",
    text: "全く違う話題の投稿Aです",
    summary: "要約は製品Alphaの価格改定について詳しく述べている。",
  });
  const b = post({
    url: "https://x.com/b/status/2",
    text: "全く違う話題の投稿Bです",
    summary: "要約は製品Alphaの価格改定について詳しく述べている内容だ。",
  });
  assert.ok(isNearDuplicate(a, b));
  console.log("EP039 near-dup-summary PASS");
}

{
  const a = post({
    url: "https://x.com/a/status/1",
    text: "ClaudeのAPI料金が改定された",
    summary: "AnthropicがClaude APIの料金体系を改定した。",
    category: "AI",
  });
  const b = post({
    url: "https://x.com/b/status/2",
    text: "Claudeで長文要約の精度を上げる実践Tips",
    summary: "制作現場でClaudeを使った長文要約の実務的な工夫。",
    category: "AI",
  });
  assert.ok(!isNearDuplicate(a, b));
  console.log("EP039 same-product-different-topic PASS");
}

{
  const a = post({
    url: "https://x.com/a/status/1",
    text: "今日の天気は晴れ",
    summary: "天気の短いメモ",
    category: "AI",
  });
  const b = post({
    url: "https://x.com/b/status/2",
    text: "新しいモデルが公開された",
    summary: "モデル公開の短いメモ",
    category: "AI",
  });
  assert.ok(!isNearDuplicate(a, b));
  console.log("EP039 same-category-alone PASS");
}

{
  const a = post({
    text: "関連する投稿について",
    summary: "関連する記事について",
  });
  const b = post({
    text: "関連する話題について",
    summary: "関連する内容について",
  });
  assert.ok(!isNearDuplicate(a, b) || calculateTextSimilarity(a.text, b.text) < 0.78);
  // Generic stop-ish overlap should not alone force near-dup with distinct content
  const c = post({
    url: "https://x.com/a/status/3",
    text: "円安が輸出企業の業績に与える影響を解説",
    summary: "為替と企業業績の関係を経済面から整理した記事。",
    category: "政治・社会",
  });
  const d = post({
    url: "https://x.com/b/status/4",
    text: "新作アニメの制作現場レポートが公開",
    summary: "作画と撮影の実務に触れた制作レポート。",
    category: "アニメ・漫画",
  });
  assert.ok(!isNearDuplicate(c, d));
  console.log("EP039 generic-words-alone PASS");
}

// --- Category balance ---
{
  assert.strictEqual(categorySoftCap(5), 3);
  assert.strictEqual(categorySoftCap(3), 2);
  console.log("EP039 soft-cap-constant PASS");
}

{
  const posts = [
    post({
      url: "https://x.com/a1/status/1",
      authorHandle: "a1",
      category: "AI",
      importance: 5,
      text: "AI新機能Aの公式発表",
      summary: "大手がAI新機能Aを発表した公式情報。",
    }),
    post({
      url: "https://x.com/a2/status/2",
      authorHandle: "a2",
      category: "AI",
      importance: 5,
      text: "AIツールBのアップデート",
      summary: "別系統のAIツールBが大型更新された。",
    }),
    post({
      url: "https://x.com/a3/status/3",
      authorHandle: "a3",
      category: "AI",
      importance: 5,
      text: "AI研究Cの論文解説",
      summary: "研究論文Cの要点を実務向けに解説。",
    }),
    post({
      url: "https://x.com/a4/status/4",
      authorHandle: "a4",
      category: "AI",
      importance: 4,
      text: "AI周辺Dの話題",
      summary: "周辺トピックDの短い紹介記事。",
    }),
    post({
      url: "https://x.com/g1/status/5",
      authorHandle: "g1",
      category: "ゲーム",
      importance: 4,
      text: "新作ゲームEのレビュー",
      summary: "話題の新作ゲームEを遊んだ所感。",
    }),
    post({
      url: "https://x.com/e1/status/6",
      authorHandle: "e1",
      category: "経済",
      importance: 4,
      text: "金利動向Fの解説",
      summary: "金融政策と市場への影響を整理。",
    }),
  ];
  const picks = selectTodayPicks(posts, 5);
  const cats = picks.map((p) => p.category);
  assert.ok(picks.length === 5);
  assert.ok(cats.includes("ゲーム") || cats.includes("経済"));
  assert.ok(cats.filter((c) => c === "AI").length <= 3);
  console.log("EP039 category-balance-with-quality PASS");
}

{
  // Other categories only low quality → allow AI dominance
  const posts = [
    post({
      url: "https://x.com/a1/status/1",
      authorHandle: "a1",
      category: "AI",
      importance: 5,
      text: "高品質AI記事1の詳細発表",
      summary: "大手モデルの新APIが公開され、料金と制限が整理された。",
      reason: "学習に直結する根拠がある文章",
      tags: ["AI", "tool"],
    }),
    post({
      url: "https://x.com/a2/status/2",
      authorHandle: "a2",
      category: "AI",
      importance: 5,
      text: "高品質AI記事2の別トピック",
      summary: "画像生成の商用利用ガイドラインが更新された実務メモ。",
      reason: "学習に直結する根拠がある文章",
      tags: ["AI", "llm"],
    }),
    post({
      url: "https://x.com/a3/status/3",
      authorHandle: "a3",
      category: "AI",
      importance: 5,
      text: "高品質AI記事3の実務Tips",
      summary: "評価データセットの作り方を現場向けにまとめた記事。",
      reason: "学習に直結する根拠がある文章",
      tags: ["AI"],
    }),
    post({
      url: "https://x.com/w1/status/4",
      authorHandle: "w1",
      category: "日常・雑談",
      importance: 1,
      text: "弱",
      summary: "短",
      reason: "",
      tags: [],
    }),
    post({
      url: "https://x.com/w2/status/5",
      authorHandle: "w2",
      category: "広告・PR",
      importance: 1,
      text: "広告",
      summary: "広告",
      reason: "",
      tags: [],
    }),
  ];
  const picks = selectTodayPicks(posts, 5);
  assert.ok(picks.every((p) => p.category === "AI"));
  assert.ok(picks.filter((p) => p.category === "AI").length >= 3);
  assert.ok(!urls(picks).includes("https://x.com/w1/status/4"));
  assert.ok(!urls(picks).includes("https://x.com/w2/status/5"));
  console.log("EP039 soft-cap-keeps-quality PASS");
}

// --- Source diversity ---
{
  const posts = [
    post({
      url: "https://x.com/same/status/1",
      authorHandle: "same",
      text: "トピックAlphaの公式発表",
      summary: "Alphaの公式発表内容をまとめた要約。",
      category: "AI",
      importance: 5,
    }),
    post({
      url: "https://x.com/same/status/2",
      authorHandle: "same",
      text: "トピックBetaの別発表",
      summary: "Betaについての別の公式発表要約。",
      category: "AI",
      importance: 5,
    }),
    post({
      url: "https://x.com/other/status/3",
      authorHandle: "other",
      text: "トピックGammaの解説記事",
      summary: "Gammaを実務視点で解説した記事。",
      category: "制作",
      importance: 4,
    }),
  ];
  const picks = selectTodayPicks(posts, 3);
  assert.ok(picks.length >= 2);
  assert.ok(urls(picks).includes("https://x.com/other/status/3"));
  console.log("EP039 author-diversity PASS");
}

{
  const posts = [
    post({
      url: "https://news.example.com/announce",
      text: "公式発表: ProductZが公開",
      summary: "ProductZの公式発表ページ要約。十分長い。",
      category: "AI",
      importance: 5,
      authorHandle: "official",
    }),
    post({
      url: "https://blog.example.com/explain",
      text: "ProductZ発表の背景と影響を解説",
      summary: "公式発表とは別に、背景と影響を深掘りした解説。",
      category: "AI",
      importance: 4,
      authorHandle: "writer",
    }),
    post({
      url: "https://mirror.example.com/copy",
      text: "公式発表: ProductZが公開",
      summary: "ProductZの公式発表ページ要約。十分長い。",
      category: "AI",
      importance: 3,
      authorHandle: "mirror",
    }),
  ];
  const picks = selectTodayPicks(posts, 3);
  assert.ok(urls(picks).includes("https://news.example.com/announce"));
  assert.ok(urls(picks).includes("https://blog.example.com/explain"));
  assert.ok(!urls(picks).includes("https://mirror.example.com/copy"));
  console.log("EP039 official-plus-explain-not-repost PASS");
}

// --- Ordering / determinism ---
{
  const posts = [
    post({
      url: "https://x.com/a/status/1",
      authorHandle: "a",
      category: "AI",
      importance: 5,
      text: "最重要の大型発表",
      summary: "今日最も重要な大型発表の要約。十分長い。",
      reason: "学習に直結する根拠がある",
      tags: ["AI", "news"],
    }),
    post({
      url: "https://x.com/b/status/2",
      authorHandle: "b",
      category: "AI",
      importance: 4,
      text: "関連する別のAI話題",
      summary: "別トピックだが同カテゴリの記事要約。",
      reason: "補足として有用",
      tags: ["AI"],
    }),
    post({
      url: "https://x.com/c/status/3",
      authorHandle: "c",
      category: "ゲーム",
      importance: 4,
      text: "注目ゲームの話題",
      summary: "エンタメ側の注目話題をまとめた要約。",
      reason: "今日の広がり",
      tags: ["game"],
    }),
  ];
  const picks = selectTodayPicks(posts, 3);
  assert.ok(picks[0].url.includes("/status/1"));
  const picks2 = selectTodayPicks([...posts].reverse(), 3);
  assert.deepStrictEqual(urls(picks), urls(picks2));
  console.log("EP039 order-and-determinism PASS");
}

// --- Representative ---
{
  const a = {
    post: post({
      url: "https://x.com/a/status/1",
      importance: 3,
      summary: "",
    }),
    editorialScore: 40,
    stableId: "a",
  };
  const b = {
    post: post({
      url: "https://x.com/b/status/2",
      importance: 5,
      summary: "要約あり十分",
      postedAt: "2026-07-14T18:00:00.000Z",
    }),
    editorialScore: 40,
    stableId: "b",
  };
  const rep = selectRepresentativeArticle([a, b]);
  assert.strictEqual(rep.stableId, "b");
  console.log("EP039 representative-tiebreak PASS");
}

// --- Edge cases ---
{
  assert.deepStrictEqual(selectTodayPicks([], 5), []);
  assert.strictEqual(selectTodayPicks([post()], 1).length, 1);
  const few = selectTodayPicks(
    [
      post({ url: "https://x.com/a/status/1", authorHandle: "a", text: "A独自" }),
      post({ url: "https://x.com/b/status/2", authorHandle: "b", text: "B独自" }),
    ],
    5
  );
  assert.ok(few.length <= 2);
  const sparse = selectTodayPicks(
    [
      post({
        url: "",
        text: "",
        summary: "",
        category: "",
        importance: null,
        reason: "",
        tags: [],
      }),
    ],
    5
  );
  assert.ok(sparse.length <= 1);
  const jp = selectTodayPicks(
    [
      post({
        url: "https://x.com/jp/status/1",
        authorHandle: "jp",
        text: "日本語の重要な発表がありました",
        summary: "日本語要約で十分に長い内容になっています。",
      }),
      post({
        url: "https://x.com/en/status/2",
        authorHandle: "en",
        text: "English release notes for a major update",
        summary: "A sufficiently long English summary of the release.",
        category: "制作",
      }),
      post({
        url: "https://x.com/mix/status/3",
        authorHandle: "mix",
        text: "Claude API の rate limit 改定について",
        summary: "日英混在の実務メモとして十分長い要約です。",
        category: "経済",
      }),
    ],
    3
  );
  assert.strictEqual(jp.length, 3);
  console.log("EP039 edge-cases PASS");
}

// --- Before / After sample (selection only; titles) ---
{
  const posts = [
    post({
      url: "https://x.com/1/status/1",
      authorHandle: "1",
      category: "AI",
      importance: 5,
      text: "AI新機能A",
      summary: "OpenAIが新機能Aを発表した公式情報。十分長い。",
    }),
    post({
      url: "https://x.com/2/status/2",
      authorHandle: "2",
      category: "AI",
      importance: 5,
      text: "AI新機能Aの紹介",
      summary: "OpenAI新機能Aの発表を紹介する投稿。十分長い。",
    }),
    post({
      url: "https://x.com/3/status/3",
      authorHandle: "3",
      category: "AI",
      importance: 5,
      text: "AI新機能Aの解説",
      summary: "OpenAIの新機能Aについて解説した記事。十分長い。",
    }),
    post({
      url: "https://x.com/4/status/4",
      authorHandle: "4",
      category: "AI",
      importance: 4,
      text: "AIツールB",
      summary: "別系統のAIツールBの更新情報。十分長い。",
    }),
    post({
      url: "https://x.com/5/status/5",
      authorHandle: "5",
      category: "アニメ・漫画",
      importance: 4,
      text: "アニメ制作C",
      summary: "制作現場の実務に触れたレポート。十分長い。",
    }),
    post({
      url: "https://x.com/6/status/6",
      authorHandle: "6",
      category: "経済",
      importance: 4,
      text: "経済ニュースD",
      summary: "市場に影響する経済ニュースの要約。十分長い。",
    }),
    post({
      url: "https://x.com/7/status/7",
      authorHandle: "7",
      category: "ゲーム",
      importance: 4,
      text: "ゲームニュースE",
      summary: "注目タイトルのゲームニュース要約。十分長い。",
    }),
  ];
  const picks = selectTodayPicks(posts, 5);
  const titles = picks.map((p) => p.text);
  assert.ok(titles.includes("AI新機能A"));
  assert.ok(!titles.includes("AI新機能Aの紹介"));
  assert.ok(!titles.includes("AI新機能Aの解説"));
  assert.ok(titles.includes("AIツールB"));
  assert.ok(
    titles.some((t) =>
      ["アニメ制作C", "経済ニュースD", "ゲームニュースE"].includes(t)
    )
  );
  assert.ok(picks.length >= 4 && picks.length <= 5);
  console.log("EP039 before-after-sample");
  console.log("  After:", titles.join(" / "));
  console.log("EP039 before-after PASS");
}

// Reason / importance preserved
{
  const picks = selectTodayPicks(
    [
      post({
        url: "https://x.com/a/status/1",
        authorHandle: "a",
        reason: "既存の理由を維持",
        importance: 5,
      }),
    ],
    5
  );
  assert.strictEqual(picks[0].reason, "既存の理由を維持");
  assert.strictEqual(picks[0].importance, 5);
  console.log("EP039 reason-importance-preserved PASS");
}

console.log("today-picks-test: all PASS");
