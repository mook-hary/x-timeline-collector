/**
 * Canonical tweet media metadata (X-MEDIA-METADATA-001).
 *
 * Collects public DOM metadata only. Does not download files, call X APIs,
 * or send images to AI. Missing/legacy `media` is treated as [].
 *
 * Item shape:
 *   { type, url, previewUrl, altText, width, height }
 * type: image | video | gif | unknown
 */
(function (factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  const g = typeof globalThis !== "undefined" ? globalThis : this;
  if (g) g.__xTweetMedia = api;
})(function () {
  const MEDIA_TYPES = ["image", "video", "gif", "unknown"];
  const MEDIA_TYPE_SET = {
    image: true,
    video: true,
    gif: true,
    unknown: true,
  };

  const ALLOWED_HOSTS = {
    "pbs.twimg.com": true,
    "video.twimg.com": true,
    "ton.twimg.com": true,
  };

  const ALLOWED_QUERY = {
    format: true,
    name: true,
  };

  const BLOCKED_QUERY =
    /^(token|auth|authorization|access[_-]?token|signature|sig|expires?|expiry|key|api[_-]?key|secret|cookie|session|sid|hmac|private|oauth|bearer|jwt)$/i;

  const BLOCKED_PATH =
    /\/(profile_images|profile_banners|emoji|hashflags|sticky)\//i;

  const GENERIC_ALT = {
    image: true,
    img: true,
    photo: true,
    picture: true,
    video: true,
    gif: true,
    media: true,
    thumbnail: true,
    "embedded video": true,
    "embedded image": true,
    画像: true,
    写真: true,
    動画: true,
    ビデオ: true,
    メディア: true,
    サムネイル: true,
  };

  const SKIP_SUBTREE_TESTIDS = {
    QuoteTweet: true,
    "Tweet-User-Avatar": true,
    tweetText: true,
  };

  function isElement(node) {
    return !!(node && typeof node === "object" && typeof node.tagName === "string");
  }

  function tagOf(node) {
    return isElement(node) ? String(node.tagName).toUpperCase() : "";
  }

  function childrenOf(node) {
    if (!node) return [];
    if (node.childNodes && node.childNodes.length != null) {
      return Array.prototype.slice.call(node.childNodes);
    }
    if (node.children && node.children.length != null) {
      return Array.prototype.slice.call(node.children);
    }
    return [];
  }

  function attr(node, name) {
    if (!isElement(node) || typeof node.getAttribute !== "function") return null;
    const value = node.getAttribute(name);
    return value == null ? null : String(value);
  }

  function testId(node) {
    return attr(node, "data-testid");
  }

  function shouldSkipSubtree(node, rootArticle) {
    const id = testId(node);
    if (id && SKIP_SUBTREE_TESTIDS[id]) return true;
    if (tagOf(node) === "ARTICLE" && node !== rootArticle) return true;
    return false;
  }

  function findByTag(root, tag) {
    const want = String(tag).toUpperCase();
    if (tagOf(root) === want) return root;
    const kids = childrenOf(root);
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (!isElement(child)) continue;
      const found = findByTag(child, tag);
      if (found) return found;
    }
    return null;
  }

  function subtreeHasTestId(root, id) {
    if (testId(root) === id) return true;
    const kids = childrenOf(root);
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (!isElement(child)) continue;
      if (subtreeHasTestId(child, id)) return true;
    }
    return false;
  }

  function ariaSuggestsGif(node) {
    const label = (attr(node, "aria-label") || "").toLowerCase();
    return label.indexOf("gif") !== -1;
  }

  function looksLikeGif(photoNode, videoNode) {
    if (subtreeHasTestId(photoNode, "gif")) return true;
    if (ariaSuggestsGif(photoNode) || ariaSuggestsGif(videoNode)) return true;
    return false;
  }

  function toDim(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n);
  }

  function dimFromAttr(node, name) {
    return toDim(attr(node, name));
  }

  function meaningfulAlt(value) {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;
    const key = text
      .toLowerCase()
      .replace(/[.。]+$/g, "")
      .trim();
    if (GENERIC_ALT[key]) return null;
    return text;
  }

  function sanitizeMediaUrl(raw, base) {
    if (raw == null) return null;
    const text = String(raw).trim();
    if (!text) return null;
    if (/^(blob|data|javascript|file):/i.test(text)) return null;

    let parsed;
    try {
      parsed = base ? new URL(text, base) : new URL(text);
    } catch (_error) {
      return null;
    }

    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    const host = String(parsed.hostname || "").toLowerCase();
    if (!ALLOWED_HOSTS[host]) return null;
    if (BLOCKED_PATH.test(parsed.pathname || "")) return null;

    const kept = [];
    const names = [];
    parsed.searchParams.forEach(function (_value, key) {
      names.push(key);
    });
    for (let i = 0; i < names.length; i++) {
      const key = names[i];
      if (BLOCKED_QUERY.test(key)) return null;
      if (ALLOWED_QUERY[String(key).toLowerCase()]) {
        kept.push([key, parsed.searchParams.get(key)]);
      }
    }

    parsed.search = "";
    parsed.hash = "";
    kept.sort(function (a, b) {
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    for (let j = 0; j < kept.length; j++) {
      parsed.searchParams.append(kept[j][0], kept[j][1]);
    }
    return parsed.toString();
  }

  function mediaItem(fields) {
    const url = sanitizeMediaUrl(fields.url);
    const previewUrl = sanitizeMediaUrl(fields.previewUrl);
    if (!url && !previewUrl) return null;
    const type = MEDIA_TYPE_SET[fields.type] ? fields.type : "unknown";
    return {
      type: type,
      url: url,
      previewUrl: previewUrl,
      altText: meaningfulAlt(fields.altText),
      width: toDim(fields.width),
      height: toDim(fields.height),
    };
  }

  function mediaFromPhoto(photoNode) {
    const video = findByTag(photoNode, "video");
    const img = findByTag(photoNode, "img");
    const altText = img ? attr(img, "alt") : null;
    const width = dimFromAttr(img || video, "width");
    const height = dimFromAttr(img || video, "height");

    if (video) {
      const poster = sanitizeMediaUrl(attr(video, "poster"));
      const type = looksLikeGif(photoNode, video) ? "gif" : "video";
      return mediaItem({
        type: type,
        url: null,
        previewUrl: poster,
        altText: altText,
        width: width,
        height: height,
      });
    }

    if (!img) return null;
    const src = sanitizeMediaUrl(attr(img, "src"));
    return mediaItem({
      type: "image",
      url: src,
      previewUrl: src,
      altText: altText,
      width: width,
      height: height,
    });
  }

  function mediaFromVideoPlayer(playerNode) {
    const video = findByTag(playerNode, "video");
    if (!video) return null;
    const poster = sanitizeMediaUrl(attr(video, "poster"));
    return mediaItem({
      type: "video",
      url: null,
      previewUrl: poster,
      altText: null,
      width: dimFromAttr(video, "width"),
      height: dimFromAttr(video, "height"),
    });
  }

  function extractMediaFromArticle(article) {
    if (!isElement(article)) return [];
    const items = [];

    function walk(node, inPhoto) {
      const kids = childrenOf(node);
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (!isElement(child)) continue;
        if (shouldSkipSubtree(child, article)) continue;
        const id = testId(child);
        const nextInPhoto = inPhoto || id === "tweetPhoto";
        if (id === "tweetPhoto") {
          const item = mediaFromPhoto(child);
          if (item) items.push(item);
        } else if (
          !nextInPhoto &&
          (id === "videoPlayer" || id === "videoComponent")
        ) {
          const item = mediaFromVideoPlayer(child);
          if (item) items.push(item);
        }
        walk(child, nextInPhoto);
      }
    }

    walk(article, false);
    return items;
  }

  function canonicalizeMediaItem(item) {
    if (!item || typeof item !== "object") return null;
    return mediaItem({
      type: item.type,
      url: item.url,
      previewUrl: item.previewUrl,
      altText: item.altText,
      width: item.width,
      height: item.height,
    });
  }

  function canonicalizeMediaList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const item = canonicalizeMediaItem(list[i]);
      if (item) out.push(item);
    }
    return out;
  }

  return {
    MEDIA_TYPES: MEDIA_TYPES,
    extractMediaFromArticle: extractMediaFromArticle,
    canonicalizeMediaList: canonicalizeMediaList,
    canonicalizeMediaItem: canonicalizeMediaItem,
    sanitizeMediaUrl: sanitizeMediaUrl,
    meaningfulAlt: meaningfulAlt,
  };
});
