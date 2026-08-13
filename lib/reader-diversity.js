/**
 * Reader primary-slot diversity: limit same URL / linked article / topic
 * without removing posts from underlying timeline data.
 */

const { buildTopicKey, extractLinkedResourceKey } = require("./digest-core");
const { normalizeArticleUrl } = require("./today-picks");

function getPostUrlKey(post) {
  return normalizeArticleUrl(post?.url || "");
}

function getLinkedArticleKey(post) {
  return extractLinkedResourceKey(
    `${post?.enrichment?.summary || ""}\n${post?.text || ""}`
  );
}

function countOrZero(map, key) {
  return key ? map.get(key) || 0 : 0;
}

/**
 * Partition importance-sorted posts into primary Reader slots vs overflow.
 * Stages: exact URL → linked external article → topicKey.
 * Pass 1 enforces all caps; pass 2 may relax topicCap only to fill slots.
 * Exact URL and linked-article caps are never relaxed for primary slots
 * (duplicates stay available via overflow /「さらに読む」).
 *
 * @param {object[]} posts
 * @param {number} limit
 * @param {{ topicCap?: number, linkCap?: number }} [options]
 * @returns {{ primary: object[], overflow: object[] }}
 */
function diversifyReaderSlots(posts, limit, options = {}) {
  const list = Array.isArray(posts) ? posts : [];
  const rawLimit = Number(limit);
  const cap = Number.isFinite(rawLimit)
    ? Math.max(0, Math.floor(rawLimit))
    : Number.POSITIVE_INFINITY;

  if (list.length === 0) {
    return { primary: [], overflow: [] };
  }
  if (!Number.isFinite(cap)) {
    return { primary: [...list], overflow: [] };
  }
  if (cap === 0) {
    return { primary: [], overflow: [...list] };
  }

  const topicCap = Number.isFinite(Number(options.topicCap))
    ? Math.max(1, Math.floor(Number(options.topicCap)))
    : 1;
  const linkCap = Number.isFinite(Number(options.linkCap))
    ? Math.max(1, Math.floor(Number(options.linkCap)))
    : 1;

  function trySelect(relaxTopic) {
    const primary = [];
    const taken = new Set();
    const seenUrls = new Set();
    const linkCounts = new Map();
    const topicCounts = new Map();

    for (let i = 0; i < list.length; i++) {
      if (primary.length >= cap) break;
      const post = list[i];
      const urlKey = getPostUrlKey(post);
      if (urlKey && seenUrls.has(urlKey)) continue;

      const linkKey = getLinkedArticleKey(post);
      if (linkKey && countOrZero(linkCounts, linkKey) >= linkCap) {
        continue;
      }

      const topicKey = buildTopicKey(post);
      if (
        !relaxTopic &&
        topicKey &&
        countOrZero(topicCounts, topicKey) >= topicCap
      ) {
        continue;
      }

      primary.push(post);
      taken.add(i);
      if (urlKey) seenUrls.add(urlKey);
      if (linkKey) linkCounts.set(linkKey, countOrZero(linkCounts, linkKey) + 1);
      if (topicKey) {
        topicCounts.set(topicKey, countOrZero(topicCounts, topicKey) + 1);
      }
    }

    return { primary, taken };
  }

  let best = trySelect(false);
  if (best.primary.length < cap) {
    const next = trySelect(true);
    if (next.primary.length > best.primary.length) best = next;
  }

  const overflow = [];
  for (let i = 0; i < list.length; i++) {
    if (!best.taken.has(i)) overflow.push(list[i]);
  }

  return { primary: best.primary, overflow };
}

module.exports = {
  diversifyReaderSlots,
  getLinkedArticleKey,
  getPostUrlKey,
};
