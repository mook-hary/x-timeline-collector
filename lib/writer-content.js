/**
 * Writer v2 — Story-aware deterministic content helpers (Editorial Polish v1).
 * EP-001: optional Editorial Brief edit context.
 * No AI. No new facts. Reader-facing prose only in visible body.
 */

const {
  resolveEditContext,
  resolveEditorialHeadline,
  resolveEditorialLead,
  whyNowToProse,
  uncoveredKeyFacts,
  stripForbiddenByRisks,
} = require("./writer-editorial");

const GENERIC_TITLE_RE =
  /^(制作・クリエイティブ技術|アニメ・漫画|ゲーム・ゲーム開発|注目の話題|その他|テクノロジー|エンタメ)$/;

const ABSTRACT_FILLER_RE =
  /(について紹介します|が注目されています|が話題になっています|今後の動向が注目されます|さまざまな可能性があります|重要なテーマです|確認済み投稿を整理|についての確認済み)/;

const INTERNAL_TERM_RE =
  /\b(Story|Concept|Topic|Knowledge|Evidence|Confidence|importance|reason)\b|関連投稿|重要度|入力上の要点/;

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHeading(text) {
  return asString(text).replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "");
}

function ensurePeriod(text) {
  let t = asString(text);
  if (!t) return "";
  if (!/[。．!?？]$/.test(t)) t = `${t}。`;
  return t;
}

/**
 * Extract stories array from stories.js --json payload or raw array.
 */
function extractStoriesList(input) {
  if (input == null) return [];
  if (Array.isArray(input)) return input.filter((s) => s && typeof s === "object");
  if (typeof input === "object" && Array.isArray(input.stories)) {
    return input.stories.filter((s) => s && typeof s === "object");
  }
  if (typeof input === "object" && asString(input.id)) {
    return [input];
  }
  return [];
}

/**
 * Pick stories relevant to Brief evidence / knowledge ids. Deterministic.
 * When storiesInput.__preserveStoryOrder is true (EP-007 selection), keep order as-is.
 */
function selectRelevantStories(storiesInput, brief) {
  const list = extractStoriesList(storiesInput);
  if (list.length === 0) return [];

  if (
    storiesInput &&
    typeof storiesInput === "object" &&
    !Array.isArray(storiesInput) &&
    storiesInput.__preserveStoryOrder === true
  ) {
    return list;
  }

  const ids = new Set();
  const evidence = brief && brief.evidence ? brief.evidence : {};
  for (const id of evidence.stories || []) {
    if (typeof id === "string" && id) ids.add(id);
  }
  for (const k of Array.isArray(brief?.knowledge) ? brief.knowledge : []) {
    if (typeof k?.id === "string" && k.id) ids.add(k.id);
  }

  if (ids.size === 0) return list.slice(0, 1);

  const matched = list.filter((s) => typeof s.id === "string" && ids.has(s.id));
  return matched.length > 0 ? matched : list.slice(0, 1);
}

function conceptRankKey(concept, index) {
  const importance = Number.isFinite(Number(concept.maxImportance))
    ? Number(concept.maxImportance)
    : Number.isFinite(Number(concept.importance))
      ? Number(concept.importance)
      : -1;
  const postCount = Number.isFinite(Number(concept.postCount))
    ? Number(concept.postCount)
    : Array.isArray(concept.posts)
      ? concept.posts.length
      : 0;
  const newest = Date.parse(concept.newestPostedAt || "") || 0;
  return { importance, postCount, newest, index };
}

function compareRank(a, b) {
  if (b.importance !== a.importance) return b.importance - a.importance;
  if (b.postCount !== a.postCount) return b.postCount - a.postCount;
  if (b.newest !== a.newest) return b.newest - a.newest;
  return a.index - b.index;
}

function selectRepresentativeConcept(story) {
  const concepts = Array.isArray(story?.concepts) ? story.concepts : [];
  if (concepts.length === 0) return null;

  let best = null;
  let bestRank = null;
  for (let i = 0; i < concepts.length; i++) {
    const rank = conceptRankKey(concepts[i], i);
    if (!bestRank || compareRank(rank, bestRank) < 0) {
      best = concepts[i];
      bestRank = rank;
    }
  }
  return best;
}

function selectRepresentativeTopic(concept) {
  const topics = Array.isArray(concept?.topics) ? concept.topics : [];
  if (topics.length === 0) return null;

  let best = null;
  let bestRank = null;
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i];
    const rank = {
      importance: Number.isFinite(Number(t.maxImportance))
        ? Number(t.maxImportance)
        : -1,
      postCount: Number.isFinite(Number(t.postCount))
        ? Number(t.postCount)
        : Array.isArray(t.posts)
          ? t.posts.length
          : 0,
      newest: Date.parse(t.newestPostedAt || "") || 0,
      index: i,
    };
    if (!bestRank || compareRank(rank, bestRank) < 0) {
      best = t;
      bestRank = rank;
    }
  }
  return best;
}

function postIdentity(post) {
  const url = asString(post?.url);
  if (url) return `url:${url}`;
  const handle = asString(post?.authorHandle);
  const postedAt = asString(post?.postedAt);
  const text = asString(post?.text).slice(0, 120);
  return `fallback:${handle}|${postedAt}|${text}`;
}

function dedupePosts(posts) {
  const list = Array.isArray(posts) ? posts : [];
  const seen = new Set();
  const out = [];
  for (const post of list) {
    if (!post || typeof post !== "object") continue;
    const key = postIdentity(post);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(post);
  }
  return out;
}

function collectPosts(story, concept, topic) {
  const raw = [];
  if (Array.isArray(topic?.posts) && topic.posts.length > 0) {
    raw.push(...topic.posts);
  } else if (Array.isArray(concept?.posts) && concept.posts.length > 0) {
    raw.push(...concept.posts);
  } else if (Array.isArray(story?.posts)) {
    raw.push(...story.posts);
  }
  return dedupePosts(raw);
}

function formatPostedAt(iso) {
  const raw = asString(iso);
  if (!raw) return "";
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return raw;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function cleanPostText(text) {
  let t = asString(text);
  if (!t) return "";
  t = t.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function proseFromPostText(text) {
  let cleaned = cleanPostText(text);
  if (!cleaned) return "";
  cleaned = cleaned.replace(
    /https?:\/\/(?:[^\s\n]*\s*\n\s*)+[^\s\n]+/gi,
    (block) => block.replace(/\s+/g, "")
  );
  const lines = cleaned.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const prose = [];
  for (const line of lines) {
    if (/^https?:\/\/\S+$/i.test(line)) continue;
    let withoutUrls = line.replace(/https?:\/\/\S+/gi, "").trim();
    withoutUrls = withoutUrls
      .replace(/\s+/g, " ")
      .replace(/\s*[….]{1,3}\s*$/, "")
      .trim();
    if (!withoutUrls) continue;
    if (/^#\S+(\s+#\S+)*$/.test(withoutUrls)) continue;
    if (/^[a-z0-9._/-]+$/i.test(withoutUrls) && withoutUrls.includes("/")) {
      continue;
    }
  // Soften bracket headlines like 【来週閉幕】 — keep as short clause without forcing 。 mid-sentence.
  withoutUrls = withoutUrls.replace(/^【([^】]+)】\s*/, "（$1）");
  prose.push(withoutUrls);
  }
  return prose.join(" ").replace(/\s+/g, " ").trim();
}

function truncateTitle(text, maxLen = 80) {
  const t = asString(text);
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1)}…`;
}

function isGenericTitle(text, storyLabel) {
  const t = asString(text);
  if (!t) return true;
  if (GENERIC_TITLE_RE.test(t)) return true;
  if (storyLabel && t === asString(storyLabel)) return true;
  return false;
}

/** Concept path labels like "人名 / 会場 / 展覧会". */
function looksLikeSlashLabel(text) {
  const t = asString(text);
  if (!t) return false;
  const parts = t.split(/\s*\/\s*/).filter(Boolean);
  return parts.length >= 2 && parts.every((p) => p.length <= 40);
}

/**
 * Prefer work/event names embedded in summaries or post text.
 */
function extractEventOrWorkTitle(sources, storyLabel) {
  const pool = sources.map(asString).filter(Boolean);
  let workTitle = null;
  for (const src of pool) {
    const normalized = src.match(/『[^』]{2,80}』\s*展/);
    if (normalized && !isGenericTitle(normalized[0], storyLabel)) {
      workTitle = escapeHeading(truncateTitle(normalized[0]));
      break;
    }
    const jpQuote = src.match(/「([^」]{2,80})」\s*展/);
    if (jpQuote) {
      const name = `『${jpQuote[1]}』展`;
      if (!isGenericTitle(name, storyLabel)) {
        workTitle = escapeHeading(truncateTitle(name));
        break;
      }
    }
  }
  if (workTitle) {
    for (const src of pool) {
      const venue = extractVenue(src);
      if (venue) {
        return escapeHeading(truncateTitle(`${workTitle}（${venue}）`));
      }
    }
    return workTitle;
  }
  return null;
}

function extractVenue(text) {
  const raw = asString(text);
  if (!raw) return "";
  // Prefer explicit venue tokens; reject matches that swallow titles or headlines.
  const matches = raw.match(
    /[^\s\n『』「」【】。．]{0,20}(?:現代|市立|県立|国立)?(?:美術館|博物館|アートの森|ギャラリー)/g
  );
  if (!matches) return "";
  for (const candidate of matches) {
    const v = candidate.trim();
    if (!v) continue;
    if (/[』「」【】]|展が|開催|閉幕|来週/.test(v)) continue;
    if (v.length > 24) continue;
    if (!/(美術館|博物館|アートの森|ギャラリー)$/.test(v)) continue;
    return v;
  }
  return "";
}

function extractPeriod(text) {
  const raw = asString(text);
  const period = raw.match(/会期[は:：]?\s*([^\n。]+)/);
  if (period) return period[1].trim();
  const range = raw.match(
    /(\d{1,2}\s*[\/月]\s*\d{1,2}\s*日?\s*[〜~\-－]\s*\d{1,2}\s*[\/月]\s*\d{1,2}\s*日?)/
  );
  if (range) return range[1].replace(/\s+/g, "");
  return "";
}

/**
 * Build concrete article title from normalized story context.
 * Priority: work/event name → service → person/org slash label → story label.
 */
function buildStoryTitle(ctx) {
  if (!ctx) return null;
  const { story, concept, topic, posts } = ctx;
  const storyLabel = asString(story?.label);

  const eventTitle = extractEventOrWorkTitle(
    [
      asString(concept?.summary),
      asString(topic?.summary),
      asString(posts[0]?.enrichment?.summary),
      proseFromPostText(posts[0]?.text),
      asString(posts[0]?.text),
    ],
    storyLabel
  );
  if (eventTitle) return eventTitle;

  const conceptLabel = asString(concept?.label);
  if (
    conceptLabel &&
    !isGenericTitle(conceptLabel, storyLabel) &&
    !looksLikeSlashLabel(conceptLabel)
  ) {
    return escapeHeading(truncateTitle(conceptLabel));
  }

  // Slash label: try to prefer person + venue short form only if no event name.
  if (conceptLabel && looksLikeSlashLabel(conceptLabel)) {
    const parts = conceptLabel.split(/\s*\/\s*/).filter(Boolean);
    // Prefer first concrete token that is not a generic type noun.
    const skip = new Set(["展覧会", "書籍", "新刊", "展示", "話題"]);
    const picked = parts.filter((p) => !skip.has(p));
    if (picked.length >= 2) {
      return escapeHeading(truncateTitle(`${picked[0]}（${picked[1]}）`));
    }
    if (picked.length === 1) {
      return escapeHeading(truncateTitle(picked[0]));
    }
  }

  const topicSummary = asString(topic?.summary);
  if (topicSummary && !isGenericTitle(topicSummary, storyLabel)) {
    return escapeHeading(truncateTitle(topicSummary, 60));
  }

  const enrichSummary = asString(posts[0]?.enrichment?.summary);
  if (enrichSummary && !isGenericTitle(enrichSummary, storyLabel)) {
    return escapeHeading(truncateTitle(enrichSummary, 60));
  }

  const conceptSummary = asString(concept?.summary);
  if (conceptSummary && !isGenericTitle(conceptSummary, storyLabel)) {
    return escapeHeading(truncateTitle(conceptSummary, 60));
  }

  if (conceptLabel && !isGenericTitle(conceptLabel, storyLabel)) {
    return escapeHeading(truncateTitle(conceptLabel));
  }

  const postProse = proseFromPostText(posts[0]?.text);
  if (postProse) {
    const first = postProse.split(/[。．\n]/)[0] || postProse;
    if (first && !isGenericTitle(first, storyLabel)) {
      return escapeHeading(truncateTitle(first));
    }
  }

  if (storyLabel) return escapeHeading(truncateTitle(storyLabel));
  return null;
}

/**
 * Turn enrichment.reason into reader-facing prose without metric language.
 */
function reasonToReaderProse(reason) {
  let r = asString(reason);
  if (!r) return "";
  if (/重要度|Confidence|Evidence Count|関連投稿/i.test(r)) return "";
  if (ABSTRACT_FILLER_RE.test(r) && r.length < 40) return "";
  if (/ため$/.test(r)) r = `${r}です`;
  return ensurePeriod(r);
}

function buildImportanceSection(ctx, avoidTexts, edit) {
  const avoid = new Set((avoidTexts || []).map(asString).filter(Boolean));
  const lines = [];
  const used = new Set();
  const riskFlags = edit && edit.riskFlags;

  const pushUnique = (sentence) => {
    let s = asString(sentence);
    if (!s) return;
    s = stripForbiddenByRisks(s, riskFlags);
    if (!s) return;
    if (used.has(s)) return;
    if (
      [...avoid].some(
        (a) => a && (s === a || (a.includes(s) && s.length > 12))
      )
    ) {
      return;
    }
    if (INTERNAL_TERM_RE.test(s)) return;
    used.add(s);
    lines.push(s);
  };

  if (edit && edit.usedEditorial) {
    pushUnique(whyNowToProse(edit.whyNow, edit.angle));
  }

  if (!(riskFlags && riskFlags.questionOnly)) {
    for (const post of ctx.posts.slice(0, 2)) {
      const reason = reasonToReaderProse(post?.enrichment?.reason);
      // Avoid restating the same closing theme after whyNow.
      if (
        /会期終了|終了間近/.test(lines.join("")) &&
        /会期終了|終了間近/.test(reason)
      ) {
        continue;
      }
      pushUnique(reason);
    }
  }

  const blob = [
    asString(ctx.concept?.summary),
    proseFromPostText(ctx.posts[0]?.text),
  ].join(" ");
  const angleClosing =
    (edit && edit.angle === "終了間近") ||
    /来週閉幕|閉幕|終了間近/.test(blob);
  if (angleClosing) {
    const joined = lines.join("");
    if (!/会期|閉幕|終了/.test(joined)) {
      pushUnique(
        "会期終了が近づいており、来場を検討している人にとって確認しておきたい情報です。"
      );
    }
  }

  if (lines.length === 0) {
    const summary = asString(ctx.concept?.summary);
    if (summary && !avoid.has(summary)) {
      pushUnique(ensurePeriod(summary));
    }
  }

  return lines.join("\n\n");
}

function overlapRatio(a, b) {
  const x = asString(a);
  const y = asString(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    return Math.min(x.length, y.length) / Math.max(x.length, y.length);
  }
  return 0;
}

function buildHappeningsSection(ctx, avoidTexts, edit) {
  const avoid = new Set((avoidTexts || []).map(asString).filter(Boolean));
  const chunks = [];
  const riskFlags = edit && edit.riskFlags;

  const author = asString(ctx.posts[0]?.authorName);
  const conceptSummary = asString(ctx.concept?.summary);
  const postProse = proseFromPostText(ctx.posts[0]?.text);
  const coveredLead = [...avoid].join("\n");

  // Question-only: stick to the post wording; do not expand with summaries.
  let main = postProse || conceptSummary || asString(ctx.story?.description);
  if (riskFlags && riskFlags.questionOnly) {
    main = postProse || asString(ctx.posts[0]?.text) || main;
  }

  if (main) {
    main = stripForbiddenByRisks(main, riskFlags) || main;
    const tooSimilar = [...avoid].some((a) => overlapRatio(a, main) >= 0.5);
    if (!tooSimilar) {
      if (author && !main.includes(author)) {
        chunks.push(
          `${author} の投稿では、${ensurePeriod(main).replace(/。$/u, "")}。`
        );
      } else {
        chunks.push(ensurePeriod(main));
      }
    }
  }

  if (
    !(riskFlags && riskFlags.questionOnly) &&
    conceptSummary &&
    postProse
  ) {
    const covered = `${coveredLead}\n${chunks.join("\n")}`;
    if (
      overlapRatio(conceptSummary, postProse) < 0.4 &&
      overlapRatio(conceptSummary, covered) < 0.5
    ) {
      const venue = extractVenue(conceptSummary);
      const feature = /コラボ|ジャンル横断/.test(conceptSummary);
      if (
        (venue && !covered.includes(venue)) ||
        (feature && !/コラボ/.test(covered))
      ) {
        const extra = stripForbiddenByRisks(conceptSummary, riskFlags);
        if (extra) chunks.push(ensurePeriod(extra));
      }
    }
  }

  return chunks.join("\n\n");
}

/**
 * Natural 2–3 sentence lead from available facts (no template / meta language).
 */
function buildLead(ctx) {
  const summary =
    asString(ctx.concept?.summary) ||
    asString(ctx.topic?.summary) ||
    asString(ctx.posts[0]?.enrichment?.summary);
  const prose = proseFromPostText(ctx.posts[0]?.text);
  const venue =
    extractVenue(summary) ||
    extractVenue(prose) ||
    extractVenue(asString(ctx.posts[0]?.text));
  const period =
    extractPeriod(asString(ctx.posts[0]?.text)) || extractPeriod(summary);
  const work =
    extractEventOrWorkTitle([summary, prose], asString(ctx.story?.label)) || "";

  const sentences = [];

  if (venue && work) {
    sentences.push(
      ensurePeriod(`${venue}では、${work.replace(/（[^）]+）$/, "")}が開催されています`)
    );
  } else if (summary) {
    // Use first clause of summary as lead sentence.
    const first = summary.split(/[。．]/)[0] || summary;
    sentences.push(ensurePeriod(first));
  } else if (prose) {
    const first = prose.split(/[。．]/)[0] || prose;
    sentences.push(ensurePeriod(first));
  }

  if (period) {
    const closing = /来週閉幕|閉幕/.test(`${summary} ${prose}`)
      ? ensurePeriod(`会期は${period}で、終了まで残り少なくなっています`)
      : ensurePeriod(`会期は${period}です`);
    if (!sentences.some((s) => s.includes(period))) {
      sentences.push(closing);
    }
  } else if (/来週閉幕/.test(`${summary} ${prose}`) && sentences.length === 1) {
    sentences.push("終了まで残り少なくなっています。");
  }

  // Short posts: keep lead minimal.
  if (!summary && prose && prose.length < 80) {
    return sentences.slice(0, 2).join("");
  }

  return sentences.slice(0, 3).join("");
}

/**
 * Highlights are supplements only — skip facts already covered in body.
 */
function extractHighlightItems(ctx, coveredText, edit) {
  const covered = asString(coveredText);
  const items = [];
  const seen = new Set();

  const add = (text) => {
    const t = asString(text);
    if (!t || t.length < 4) return;
    if (seen.has(t)) return;
    if (ABSTRACT_FILLER_RE.test(t)) return;
    if (INTERNAL_TERM_RE.test(t)) return;
    const core = t.replace(
      /^(会期:\s*|会場:\s*|会期は|会場は|作品・イベント:\s*|状況:\s*)/,
      ""
    );
    if (covered.includes(core) || covered.includes(t)) return;
    if (
      core.length >= 6 &&
      covered.includes(core.slice(0, Math.min(12, core.length)))
    ) {
      return;
    }
    seen.add(t);
    items.push(t);
  };

  // Prefer uncovered editorial keyFacts first (no re-listing of lead/body facts).
  for (const fact of uncoveredKeyFacts(edit, covered)) {
    add(fact);
  }

  if (!(edit && edit.riskFlags && edit.riskFlags.questionOnly)) {
    for (const post of ctx.posts.slice(0, 2)) {
      const raw = cleanPostText(post.text);
      const period = extractPeriod(raw);
      if (period) add(`会期: ${period}`);
      const venue = extractVenue(raw);
      if (venue) add(`会場: ${venue}`);
      const collab = raw.match(/他ジャンルとのコラボレーション[^\n。]*/);
      if (collab) add(collab[0].trim());
    }

    const summary = asString(ctx.concept?.summary);
    if (summary) {
      const venue = extractVenue(summary);
      if (venue) add(`会場: ${venue}`);
    }

    if (/ジャンル横断|コラボ/.test(summary) && !/コラボ/.test(covered)) {
      if (/ジャンル横断のコラボ展示/.test(summary)) {
        add("ジャンル横断のコラボ展示");
      }
    }
  }

  return items.slice(0, 4);
}

function buildSourcesSection(posts) {
  const lines = [];
  const seen = new Set();
  for (const post of posts) {
    const url = asString(post.url);
    const key = url || postIdentity(post);
    if (seen.has(key)) continue;
    seen.add(key);

    const name = asString(post.authorName) || "投稿者不明";
    const handle = asString(post.authorHandle);
    const handlePart = handle
      ? handle.startsWith("@")
        ? handle
        : `@${handle}`
      : "";
    const when = formatPostedAt(post.postedAt);

    let line = `- ${name}`;
    if (handlePart) line += `（${handlePart}）`;
    if (when) line += ` — ${when}`;
    if (url) line += ` — ${url}`;

    if (!url && !when && name === "投稿者不明") continue;
    lines.push(line);
  }
  return lines;
}

function normalizeStoryContext(storiesInput, brief) {
  const stories = selectRelevantStories(storiesInput, brief);
  if (stories.length === 0) return null;

  const story = stories[0];
  const concept = selectRepresentativeConcept(story);
  const topic = concept ? selectRepresentativeTopic(concept) : null;
  const posts = collectPosts(story, concept, topic);

  const hasConcrete =
    asString(concept?.label) ||
    asString(concept?.summary) ||
    asString(topic?.summary) ||
    posts.some((p) => asString(p.text)) ||
    asString(story.description);

  if (!hasConcrete && !asString(story.label)) return null;

  return {
    story,
    concept,
    topic,
    posts,
    tags: Array.isArray(story.tags)
      ? story.tags.map(asString).filter(Boolean)
      : [],
  };
}

function hasRichStoryContent(ctx) {
  if (!ctx) return false;
  if (ctx.posts.some((p) => asString(p.text))) return true;
  if (asString(ctx.concept?.summary) || asString(ctx.concept?.label)) return true;
  if (asString(ctx.topic?.summary)) return true;
  return false;
}

/**
 * Embed usable claim texts for Article Report exact-match, without internal jargon.
 */
function embedMissingClaims(parts, brief) {
  const bodySoFar = parts.join("\n");
  for (const claim of Array.isArray(brief?.claims) ? brief.claims : []) {
    if (!claim || claim.usable !== true) continue;
    const text = asString(claim.text);
    if (!text) continue;
    if (bodySoFar.includes(text)) continue;
    // Reader-facing wrapper; claim text must appear verbatim for Article Report.
    parts.push(`${text}。`);
    parts.push("");
  }
}

function renderStoryArticle(ctx, plan, brief) {
  if (!hasRichStoryContent(ctx) && !asString(ctx?.story?.label)) {
    return null;
  }

  const edit = resolveEditContext(brief, ctx, plan);
  const editorialHeadline = resolveEditorialHeadline(edit);
  const storyTitle = buildStoryTitle(ctx);
  const title =
    editorialHeadline ||
    storyTitle ||
    escapeHeading(asString(plan?.title)) ||
    escapeHeading(asString(brief?.title)) ||
    "(untitled article)";

  const editorialLead = resolveEditorialLead(edit);
  const lead = editorialLead || buildLead(ctx);
  const happenings = buildHappeningsSection(ctx, [lead], edit);
  const importance = buildImportanceSection(ctx, [lead, happenings], edit);
  const covered = [lead, happenings, importance].join("\n");
  const highlights = extractHighlightItems(ctx, covered, edit);
  const sources = buildSourcesSection(ctx.posts);

  const parts = [];
  if (lead) {
    parts.push(lead);
    parts.push("");
  }

  if (happenings) {
    parts.push("## 何が起きたか");
    parts.push("");
    parts.push(happenings);
    parts.push("");
  }

  if (importance) {
    parts.push("## なぜ重要なのか");
    parts.push("");
    parts.push(importance);
    parts.push("");
  }

  embedMissingClaims(parts, brief);

  if (highlights.length > 0) {
    parts.push("## 注目ポイント");
    parts.push("");
    for (const item of highlights) {
      parts.push(`- ${item}`);
    }
    parts.push("");
  }

  if (sources.length > 0) {
    parts.push("## 情報源");
    parts.push("");
    parts.push(...sources);
    parts.push("");
  }

  for (const claim of Array.isArray(brief?.claims) ? brief.claims : []) {
    if (!claim || claim.usable !== false) continue;
    parts.push("## 補足");
    parts.push("");
    parts.push(`> この項目は根拠不足のため本文へ採用しませんでした。`);
    parts.push("");
  }

  const bodyMarkdown = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    title,
    bodyMarkdown,
    usedEditorial: !!(edit && edit.usedEditorial),
    validation: edit && edit.validation ? edit.validation : null,
  };
}

function resolveContentTitle(storiesInput, brief, plan) {
  const ctx = normalizeStoryContext(storiesInput, brief || {});
  if (ctx && hasRichStoryContent(ctx)) {
    const t = buildStoryTitle(ctx);
    if (t) return t;
  }
  if (ctx && asString(ctx.story?.label)) {
    return escapeHeading(ctx.story.label);
  }
  if (plan && asString(plan.title)) return asString(plan.title);
  if (brief && asString(brief.title)) return asString(brief.title);
  return null;
}

module.exports = {
  extractStoriesList,
  selectRelevantStories,
  selectRepresentativeConcept,
  selectRepresentativeTopic,
  dedupePosts,
  collectPosts,
  buildStoryTitle,
  normalizeStoryContext,
  hasRichStoryContent,
  renderStoryArticle,
  resolveContentTitle,
  formatPostedAt,
  proseFromPostText,
  postIdentity,
  looksLikeSlashLabel,
  extractEventOrWorkTitle,
  extractVenue,
  extractPeriod,
  resolveEditContext,
};
