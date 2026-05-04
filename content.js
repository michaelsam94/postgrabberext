"use strict";

/* global postgrabberLog */

/** @type {EventTarget | null} */
let lastContextTarget = null;

document.addEventListener(
  "contextmenu",
  (e) => {
    lastContextTarget = e.target;
  },
  true
);

/**
 * With `all_frames`, Facebook still loads our script in hidden iframes (e.g. sound_iframe for audio).
 * They must not handle `fillComposerWithPost` — there is no Lexical composer there.
 * @returns {boolean}
 */
function isFacebookHiddenUtilityFrame() {
  try {
    const p = (location.pathname || "").toLowerCase();
    const h = (location.href || "").toLowerCase();
    if (p.includes("sound_iframe")) return true;
    if (p.includes("buddy_list.php")) return true;
    if (h.includes("sound_iframe")) return true;
  } catch {
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === "copyPost") {
    (async () => {
      try {
        postgrabberLog("info", "message", "copyPost");
        const payload = extractPostPayload(lastContextTarget);
        await writeClipboard(payload);
        sendResponse({ ok: true, textLen: payload.text.length, hadImage: !!payload.imageCandidate });
      } catch (err) {
        postgrabberLog("error", "message", "copyPost failed", {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined
        });
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.action === "getPostSnapshot") {
    try {
      postgrabberLog("info", "message", "getPostSnapshot");
      const record = buildPostRecord(lastContextTarget);
      sendResponse({ ok: true, record });
    } catch (err) {
      postgrabberLog("error", "message", "getPostSnapshot failed", {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (msg?.action === "fillComposerWithPost") {
    if (isFacebookHiddenUtilityFrame()) {
      postgrabberLog("debug", "message", "fillComposerWithPost ignored (utility frame)", {
        href: location.href.slice(0, 200)
      });
      sendResponse({
        ok: false,
        error: "ignored_utility_frame",
        details: { reason: "hidden_iframe", href: location.href.slice(0, 200) }
      });
      return false;
    }
    (async () => {
      try {
        const opts = msg.options || {};
        postgrabberLog("info", "message", "fillComposerWithPost start", {
          autoAdvance: opts.autoAdvance === true,
          attachMedia: opts.attachMedia !== false,
          hasText: Boolean(msg.post?.text),
          hasImageUrl: Boolean(msg.post?.imageUrl),
          hasVideoUrl: Boolean(msg.post?.videoUrl)
        });
        const result = await fillComposerWithPost(msg.post, opts);
        postgrabberLog("info", "message", "fillComposerWithPost done", {
          ok: result.ok,
          error: result.error,
          details: result.details,
          published: result.published,
          publishMeta: result.publishMeta
        });
        sendResponse(result);
      } catch (err) {
        postgrabberLog("error", "message", "fillComposerWithPost threw", {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined
        });
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          details: {}
        });
      }
    })();
    return true;
  }

  return false;
});

const MAX_TEXT = 12000;

/**
 * @param {EventTarget | null} target
 */
function extractPostPayload(target) {
  if (!target || !(target instanceof Element)) {
    throw new Error("Right-click inside the post first, then choose PostGrabber from the menu.");
  }

  const root = resolvePostRoot(target);
  const mediaRoot = resolveMediaHarvestRoot(target);
  const text = truncateText(collectVisibleText(root), MAX_TEXT);
  const video = pickPrimaryVideo(mediaRoot, target);
  const imageCandidate = pickPrimaryImage(mediaRoot, target);

  const lines = [text];
  if (video?.url) lines.push("", `Video: ${video.url}`);
  if (imageCandidate?.pageUrl && imageCandidate.pageUrl !== imageCandidate.resolvedSrc) {
    lines.push("", `Image (page): ${imageCandidate.pageUrl}`);
  }

  return {
    text: lines.filter(Boolean).join("\n"),
    imageCandidate
  };
}

/**
 * @param {EventTarget | null} target
 */
function buildPostRecord(target) {
  if (!target || !(target instanceof Element)) {
    throw new Error("Right-click inside the post first, then choose PostGrabber from the menu.");
  }

  const root = resolvePostRoot(target);
  const mediaRoot = resolveMediaHarvestRoot(target);
  const postText = truncateText(collectVisibleText(root), MAX_TEXT);
  const video = pickPrimaryVideo(mediaRoot, target);
  const imageCandidate = pickPrimaryImage(mediaRoot, target);
  const imageUrl = resolveBestImageUrlForStorage(mediaRoot, target, imageCandidate);
  const videoUrl = video?.url || null;

  return {
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `pg_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: Date.now(),
    text: postText,
    imageUrl,
    videoUrl,
    sourceUrl: location.href
  };
}

/**
 * @param {Element} target
 */
function resolvePostRoot(target) {
  return (
    target.closest('[role="article"]') ||
    target.closest("[data-pagelet^='FeedUnit']") ||
    target.closest("[data-ad-preview='message'], [data-ad-comet-preview='message']") ||
    walkUpForScope(target, 24)
  );
}

/**
 * Wider than {@link resolvePostRoot}: feed photos often live in a *sibling* of
 * `[data-ad-preview="message"]`, not inside it (see Facebook card DOM).
 * @param {Element} target
 */
function resolveMediaHarvestRoot(target) {
  if (!target || !(target instanceof Element)) return target;

  const article = target.closest('[role="article"]');
  if (article) return article;

  const msg = target.closest("[data-ad-preview='message'], [data-ad-comet-preview='message']");
  if (msg instanceof Element) {
    let cur = msg.parentElement;
    for (let i = 0; i < 10 && cur instanceof Element; i++) {
      if (
        cur.querySelector?.('img[data-imgperflogname="feedImage"]') ||
        cur.querySelector?.("a[href*='photo/?fbid']") ||
        cur.querySelector?.('a[href*="photo.php"]')
      ) {
        return cur;
      }
      cur = cur.parentElement;
    }
  }

  const narrow = resolvePostRoot(target);
  if (!(narrow instanceof Element)) return target;

  let best = narrow;
  let cur = narrow.parentElement;
  for (let i = 0; i < 14 && cur instanceof Element; i++) {
    if (cur.querySelector?.('img[data-imgperflogname="feedImage"]')) best = cur;
    cur = cur.parentElement;
  }
  return best;
}

/**
 * @param {Element} el
 * @param {number} maxHops
 */
function walkUpForScope(el, maxHops) {
  let cur = el;
  for (let i = 0; i < maxHops && cur; i++) {
    if (cur instanceof HTMLElement) {
      const t = cur.innerText?.trim();
      if (t && t.length > 40) return cur;
    }
    cur = cur.parentElement;
  }
  return el;
}

/**
 * Whether this element is not meant to contribute text (live DOM; uses layout CSS).
 * @param {Element} el
 */
function isTextHarvestHiddenSubtree(el) {
  if (!(el instanceof Element) || !el.isConnected) return true;
  if (el.closest("script, style, noscript")) return true;
  const tag = el.tagName;
  if (tag === "SVG" || tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return true;
  if (el.hasAttribute("hidden")) return true;
  try {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return true;
    if (Number(st.opacity) === 0) return true;
    if (st.contentVisibility === "hidden") return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * @param {Node} textNode
 * @param {Element} root
 */
function isHarvestableTextNode(textNode, root) {
  const p = textNode.parentElement;
  if (!p || !root.contains(p)) return false;
  let cur = /** @type {Element | null} */ (p);
  while (cur && root.contains(cur)) {
    if (isTextHarvestHiddenSubtree(cur)) return false;
    cur = cur.parentElement;
  }
  return true;
}

/**
 * Inline emoji / sticker images: include `alt` so saved text keeps emojis.
 * @param {HTMLImageElement} img
 */
function harvestEmojiAltFromImg(img) {
  const alt = img.getAttribute("alt");
  if (alt == null) return "";
  const src = img.currentSrc || img.getAttribute("src") || "";
  if (isFbEmojiOrTinyUiImage(img, src)) return alt;
  if (/emoji\.php|\/emoji\//i.test(src)) return alt;
  const t = alt.trim();
  if (!t || t.length > 48) return "";
  if (/\p{Extended_Pictographic}/u.test(t)) return alt;
  return "";
}

/**
 * Preserves runs of spaces and Unicode (including ZWJ sequences) better than `innerText`,
 * and pulls emoji from Facebook’s `<img alt="…">` inline glyphs.
 * @param {Element} root
 */
function collectVisibleText(root) {
  if (!(root instanceof Element)) return "";

  /** @type {string[]} */
  const chunks = [];

  /** @param {Node} node */
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (isHarvestableTextNode(node, root)) chunks.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {HTMLElement} */ (node);
    if (isTextHarvestHiddenSubtree(el)) return;
    if (el.tagName === "BR") {
      chunks.push("\n");
      return;
    }
    if (el instanceof HTMLImageElement) {
      const em = harvestEmojiAltFromImg(el);
      if (em) chunks.push(em);
      return;
    }
    for (const c of el.childNodes) walk(c);
  }

  walk(root);
  return chunks.join("");
}

function truncateText(s, max) {
  const t = s.replace(/\r\n/g, "\n");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/**
 * @param {Element} root
 * @param {Element} target
 */
function pickPrimaryVideo(root, target) {
  let v =
    (target instanceof HTMLVideoElement ? target : null) ||
    root.querySelector("video") ||
    target.closest("video");
  if (!v && root.parentElement) {
    v = root.parentElement.querySelector("video");
  }
  if (v instanceof HTMLVideoElement) {
    const url = normalizeVideoUrl(v.currentSrc || v.src || v.querySelector("source")?.src);
    if (url) return { url };
  }

  const scopes = [root, root.parentElement].filter((n) => n instanceof Element);
  for (const scope of scopes) {
    const fromAnchors = pickLargestVideoLink(scope, target);
    if (fromAnchors) return { url: fromAnchors };
  }

  return null;
}

/**
 * @param {Element} root
 * @param {Element} target
 */
function pickPrimaryImage(root, target) {
  const feed = root.querySelector?.('img[data-imgperflogname="feedImage"]');
  if (feed instanceof HTMLImageElement) {
    const resolved = resolveImgUrlDeep(feed);
    if (resolved && !isDisposableOrTrackingImageUrl(resolved) && !isFbEmojiOrTinyUiImage(feed, resolved)) {
      return {
        el: feed,
        resolvedSrc: resolved,
        pageUrl: feed.currentSrc || feed.getAttribute("src") || resolved
      };
    }
  }

  const pool = new Set();

  const addFrom = (el) => {
    if (!(el instanceof Element)) return;
    el.querySelectorAll?.("img").forEach((img) => {
      if (img instanceof HTMLImageElement) pool.add(img);
    });
  };

  addFrom(root);
  if (root.parentElement) addFrom(root.parentElement);
  if (target instanceof Element) {
    let n = target;
    for (let i = 0; i < 12 && n; i++) {
      addFrom(n);
      n = n.parentElement;
    }
  }

  /** @type {HTMLImageElement | null} */
  let best = null;
  let bestScore = -1;

  const tryScore = (minArea) => {
    for (const img of pool) {
      const area = imgArea(img);
      if (area < minArea) continue;

      const src = resolveImgUrlDeep(img);
      if (!src || isDisposableOrTrackingImageUrl(src)) continue;
      if (isFbEmojiOrTinyUiImage(img, src)) continue;

      const alt = (img.getAttribute("alt") || "").toLowerCase();
      if (alt.includes("profile picture") || alt.includes("cover photo")) continue;

      const perf = img.getAttribute("data-imgperflogname") || "";
      let bonus = 0;
      if (perf === "feedImage") bonus += 1e9;
      else if (perf && /feed|photo|attachment/i.test(perf)) bonus += 1e6;

      const score = area + bonus;
      if (score > bestScore) {
        bestScore = score;
        best = img;
      }
    }
  };

  tryScore(80 * 80);
  if (!best) tryScore(24 * 24);
  if (!best) tryScore(1);

  if (!best) return null;

  const resolved = resolveImgUrlDeep(best);
  return {
    el: best,
    resolvedSrc: resolved,
    pageUrl: best.currentSrc || best.getAttribute("src") || resolved
  };
}

/**
 * @param {HTMLImageElement} img
 */
function resolveImgUrl(img) {
  return resolveImgUrlDeep(img);
}

function imgArea(img) {
  const rect = img.getBoundingClientRect?.();
  let w = rect?.width || 0;
  let h = rect?.height || 0;
  if (w < 2 || h < 2) {
    w = img.naturalWidth || w;
    h = img.naturalHeight || h;
  }
  return Math.max(0, w) * Math.max(0, h);
}

function urlFromBackgroundImage(value) {
  if (!value || value === "none") return "";
  const m = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(value);
  if (!m?.[1]) return "";
  return absolutize(m[1].trim());
}

function isDisposableOrTrackingImageUrl(url) {
  if (!url) return true;
  if (url.startsWith("data:")) {
    return url.length < 900;
  }
  if (url.startsWith("blob:")) return true;
  if (/rsrc\.php\//i.test(url) && /emoji|gif/i.test(url)) return true;
  if (/static\.xx\.fbcdn\.net\/images\/emoji\.php/i.test(url)) return true;
  return false;
}

/**
 * @param {HTMLImageElement} img
 * @param {string} url
 */
function isFbEmojiOrTinyUiImage(img, url) {
  if (/images\/emoji\.php/i.test(url)) return true;
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  if (w > 0 && h > 0 && w <= 24 && h <= 24) {
    if (/static\.xx\.fbcdn\.net/i.test(url)) return true;
  }
  return false;
}

function pickLargestSrcFromSrcset(srcset) {
  if (!srcset) return "";
  const parts = srcset.split(",").map((p) => p.trim());
  /** @type {{ u: string; w: number }[]} */
  const out = [];
  for (const p of parts) {
    const bits = p.split(/\s+/);
    const u = bits[0];
    if (!u) continue;
    let w = 0;
    const desc = bits[1] || "";
    const wm = /^(\d+)w$/i.exec(desc);
    if (wm) w = parseInt(wm[1], 10) || 0;
    out.push({ u, w });
  }
  out.sort((a, b) => b.w - a.w);
  return out[0]?.u || "";
}

/**
 * @param {HTMLImageElement} img
 */
function resolveImgUrlDeep(img) {
  if (!(img instanceof HTMLImageElement)) return "";

  const attrCandidates = [
    () => img.currentSrc,
    () => img.getAttribute("src"),
    () => pickLargestSrcFromSrcset(img.getAttribute("srcset")),
    () => img.getAttribute("data-src"),
    () => img.getAttribute("data-delayed-url"),
    () => img.getAttribute("data-image"),
    () => img.getAttribute("data-original"),
    () => img.getAttribute("data-lazy"),
    () => img.getAttribute("data-href"),
    () => img.getAttribute("data-ploi"),
    () => img.getAttribute("data-cdn")
  ];

  for (const get of attrCandidates) {
    let v = "";
    try {
      v = get() || "";
    } catch {
      v = "";
    }
    v = (v || "").trim();
    if (!v) continue;
    if (v.startsWith("data:")) continue;
    if (v.startsWith("blob:")) continue;
    const abs = absolutize(v);
    if (abs.length > 12 && !isDisposableOrTrackingImageUrl(abs)) return abs;
  }

  for (const name of img.getAttributeNames()) {
    if (!name.startsWith("data-")) continue;
    const val = img.getAttribute(name);
    if (!val || val.length < 16) continue;
    const matches = val.match(/https?:\/\/[^\s"'<>]+/g);
    if (!matches) continue;
    for (const m of matches) {
      const abs = absolutize(m.replace(/[),.;]+$/, ""));
      if (abs.startsWith("blob:")) continue;
      if (abs.length > 12 && !isDisposableOrTrackingImageUrl(abs)) return abs;
    }
  }

  return "";
}

/**
 * @param {Element} root
 * @param {Element} target
 * @param {{ resolvedSrc: string; pageUrl: string; el: HTMLImageElement } | null} imageCandidate
 */
function resolveBestImageUrlForStorage(root, target, imageCandidate) {
  const direct =
    imageCandidate?.resolvedSrc &&
    !imageCandidate.resolvedSrc.startsWith("blob:") &&
    !isDisposableOrTrackingImageUrl(imageCandidate.resolvedSrc)
      ? imageCandidate.resolvedSrc
      : "";
  if (direct) return direct;

  const scopes = [root, root.parentElement].filter((n) => n instanceof Element);
  for (const scope of scopes) {
    const bg = pickLargestBackgroundMediaUrl(scope, target);
    if (bg) return bg;
  }
  for (const scope of scopes) {
    const link = pickLargestPhotoOrMediaLink(scope, target);
    if (link) return link;
  }

  return null;
}

/**
 * @param {Element} root
 * @param {Element} target
 */
function pickLargestBackgroundMediaUrl(root, target) {
  /** @type {{ url: string; area: number }[]} */
  const found = [];

  const consider = (el) => {
    if (!(el instanceof HTMLElement)) return;
    let bg = "";
    try {
      bg = el.style?.backgroundImage || "";
      if (!bg || bg === "none") bg = getComputedStyle(el).backgroundImage || "";
    } catch {
      return;
    }
    const url = urlFromBackgroundImage(bg);
    if (!url || isDisposableOrTrackingImageUrl(url)) return;
    if (!/^https?:\/\//i.test(url)) return;
    const rect = el.getBoundingClientRect?.();
    const area = Math.max(0, rect?.width || 0) * Math.max(0, rect?.height || 0);
    if (area < 24 * 24) return;
    found.push({ url, area });
  };

  root
    .querySelectorAll?.(
      '[style*="background"], [class*="image"], [class*="cover"], [class*="img"], [data-imgperflogname]'
    )
    .forEach((el) => consider(el));

  if (target instanceof HTMLElement) {
    let n = target;
    for (let i = 0; i < 14 && n; i++) {
      consider(n);
      n = n.parentElement;
    }
  }

  found.sort((a, b) => b.area - a.area);
  return found[0]?.url || "";
}

/**
 * @param {Element} root
 * @param {Element} target
 */
function pickLargestPhotoOrMediaLink(root, target) {
  const sel =
    'a[href*="photo/?fbid"], a[href*="photo.php"], a[href*="/photos/"], a[href*="/photo"], a[href*="fbcdn.net"], a[href*="fbsbx.com"], a[href*="scontent"]';
  /** @type {{ href: string; area: number }[]} */
  const found = [];

  const collect = (scope) => {
    if (!(scope instanceof Element)) return;
    scope.querySelectorAll?.(sel).forEach((a) => {
      if (!(a instanceof HTMLAnchorElement)) return;
      const href = a.getAttribute("href");
      if (!href || href === "#") return;
      const rect = a.getBoundingClientRect?.();
      const area = Math.max(0, rect?.width || 0) * Math.max(0, rect?.height || 0);
      found.push({ href: absolutize(href), area });
    });
  };

  collect(root);
  if (target instanceof Element) {
    let n = target;
    for (let i = 0; i < 10 && n; i++) {
      collect(n);
      n = n.parentElement;
    }
  }

  found.sort((a, b) => b.area - a.area);
  return found[0]?.href || "";
}

/**
 * @param {Element} root
 * @param {Element} target
 */
function pickLargestVideoLink(root, target) {
  const sel =
    'a[href*="/videos/"], a[href*="/watch/"], a[href*="watch/?v="], a[href*="/reel/"], a[href*="video.php"]';
  /** @type {{ href: string; area: number }[]} */
  const found = [];

  const collect = (scope) => {
    if (!(scope instanceof Element)) return;
    scope.querySelectorAll?.(sel).forEach((a) => {
      if (!(a instanceof HTMLAnchorElement)) return;
      const href = a.getAttribute("href");
      if (!href || href === "#") return;
      const rect = a.getBoundingClientRect?.();
      const area = Math.max(0, rect?.width || 0) * Math.max(0, rect?.height || 0);
      found.push({ href: absolutize(href), area });
    });
  };

  collect(root);
  if (target instanceof Element) {
    let n = target;
    for (let i = 0; i < 10 && n; i++) {
      collect(n);
      n = n.parentElement;
    }
  }

  found.sort((a, b) => b.area - a.area);
  const best = found[0]?.href;
  return normalizeVideoUrl(best);
}

/**
 * @param {string | undefined} url
 */
function normalizeVideoUrl(url) {
  if (!url || url.startsWith("blob:")) return "";
  return absolutize(url);
}

function absolutize(url) {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

/**
 * @param {{ text: string; imageCandidate: { el: HTMLImageElement; resolvedSrc: string; pageUrl: string } | null }} payload
 */
async function writeClipboard(payload) {
  const plain = payload.text || "(no text found)";

  const types = {
    "text/plain": new Blob([plain], { type: "text/plain" })
  };

  const imgInfo = payload.imageCandidate;
  if (imgInfo?.resolvedSrc) {
    const imageBlob = await tryImageBlob(imgInfo);
    if (imageBlob) {
      const mime = imageBlob.type && imageBlob.type.startsWith("image/") ? imageBlob.type : "image/png";
      types[mime] = imageBlob;
    }
  }

  const item = new ClipboardItem(types);
  await navigator.clipboard.write([item]);
}

/**
 * @param {{ resolvedSrc: string; el: HTMLImageElement }} imgInfo
 */
async function tryImageBlob(imgInfo) {
  const { resolvedSrc, el } = imgInfo;

  try {
    const r = await fetch(resolvedSrc, { credentials: "omit", mode: "cors", cache: "no-store" });
    if (r.ok) {
      const b = await r.blob();
      if (b && b.size > 0) return b;
    }
  } catch {
    // fall through
  }

  try {
    const bitmap = await createImageBitmap(el);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob;
  } catch {
    return null;
  }
}

/**
 * @param {{ text?: string; imageUrl?: string | null; videoUrl?: string | null }} post
 */
function composeDraftText(post) {
  const parts = [];
  if (post.text) parts.push(post.text);
  if (post.videoUrl) parts.push("", `Video: ${post.videoUrl}`);
  if (post.imageUrl) parts.push("", `Image: ${post.imageUrl}`);
  return parts.join("\n").trim();
}

/**
 * @param {{ text?: string }} post
 */
function composeBodyTextOnly(post) {
  if (post.text == null) return "";
  return String(post.text).replace(/\r\n/g, "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {Element | null} el
 */
function isElementVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = window.getComputedStyle(el);
  if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return false;
  return true;
}

/**
 * In layout tree (may use pointer-events:none while gray — still useful to detect “waiting on FB”).
 * @param {HTMLElement} el
 */
function isComposerPrimaryActionInDomTree(el) {
  if (!(el instanceof HTMLElement)) return false;
  const rects = el.getClientRects();
  if (!rects.length) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const st = window.getComputedStyle(el);
  if (st.visibility === "hidden" || st.display === "none") return false;
  if (Number(st.opacity) < 0.02) return false;
  return true;
}

/**
 * Visible / hit-testable shell (may still be gray / aria-disabled while media processes).
 * @param {HTMLElement} el
 */
function isComposerPrimaryActionPresent(el) {
  if (!isComposerPrimaryActionInDomTree(el)) return false;
  const st = window.getComputedStyle(el);
  if (st.pointerEvents === "none") return false;
  return true;
}

/**
 * Ready for a real click (not grayed / blocked). FB often keeps Next disabled until upload finishes.
 * @param {HTMLElement} el
 */
function isComposerPrimaryActionEnabled(el) {
  if (!isComposerPrimaryActionPresent(el)) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  if (el.hasAttribute("disabled")) return false;
  if (el.getAttribute("aria-busy") === "true") return false;
  let p = el;
  for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
    if (p instanceof HTMLElement && p.hasAttribute("inert")) return false;
  }
  const st = window.getComputedStyle(el);
  if (st.cursor === "not-allowed") return false;
  return true;
}

/**
 * Programmatic HTMLElement.click() is sometimes ignored; mirror a short pointer + mouse path.
 * Facebook stacks a full-bleed child (data-visualcompletion="ignore", inset:0) above the label;
 * use the same node a real click would hit via elementFromPoint when it stays inside `el`.
 * @param {HTMLElement} el
 */
function synthesizeUserLikePrimaryClick(el) {
  const r = el.getBoundingClientRect();
  const x = r.left + Math.max(1, r.width / 2);
  const y = r.top + Math.max(1, r.height / 2);
  let hit = el;
  try {
    const top = document.elementFromPoint(x, y);
    if (top instanceof HTMLElement && el.contains(top)) hit = top;
  } catch {
    // ignore
  }
  const common = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    view: window
  };
  try {
    el.focus({ preventScroll: true });
  } catch {
    // ignore
  }
  const ptr = { ...common, pointerId: 1, pointerType: "mouse", isPrimary: true };
  hit.dispatchEvent(new PointerEvent("pointerover", { ...ptr }));
  hit.dispatchEvent(new MouseEvent("mouseover", common));
  hit.dispatchEvent(new PointerEvent("pointerdown", { ...ptr, buttons: 1, button: 0 }));
  hit.dispatchEvent(new MouseEvent("mousedown", { ...common, buttons: 1, button: 0 }));
  hit.dispatchEvent(new PointerEvent("pointerup", { ...ptr, buttons: 0, button: 0 }));
  hit.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0, button: 0 }));
  hit.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0, button: 0 }));
  hit.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    })
  );
  const toNativeClick = hit !== el ? hit : el;
  if (typeof toNativeClick.click === "function") toNativeClick.click();
}

/**
 * Next / Post often live in the dialog chrome, outside the inner “Create a post” region.
 * Nested role="dialog" shells can leave the editor in an inner layer while Next sits in an outer dialog.
 * @param {Element | Document | null | undefined} scope
 * @returns {Element | Document}
 */
function expandScopeToComposerDialog(scope) {
  if (scope instanceof Document) return scope;
  if (!(scope instanceof Element)) {
    const r = findCreatePostRegion();
    if (r instanceof HTMLElement) {
      const d = r.closest('[role="dialog"]');
      return d instanceof HTMLElement ? d : r;
    }
    return document.body;
  }
  const inner = scope.closest('[role="dialog"]');
  if (!(inner instanceof HTMLElement)) {
    let cur = scope;
    while (cur instanceof HTMLElement && cur !== document.body) {
      if (cur.querySelector('[role="button"][aria-label="Next"], [role="button"][aria-label="Post"]'))
        return cur;
      cur = cur.parentElement;
    }
    return scope;
  }
  /** @type {HTMLElement} */
  let best = inner;
  let walk = inner.parentElement;
  while (walk) {
    const outer = walk.closest('[role="dialog"]');
    if (!(outer instanceof HTMLElement) || outer === best) break;
    if (
      outer.contains(scope) &&
      outer.querySelector('[role="button"][aria-label="Next"], [role="button"][aria-label="Post"]')
    ) {
      best = outer;
    }
    walk = outer.parentElement;
  }
  return best;
}

/**
 * Find a primary action in the Create post UI by visible label or aria-label (English UI).
 * @param {Element | Document} scope
 * @param {"Next" | "Post"} exactLabel
 * @returns {HTMLElement | null}
 */
function pickBestComposerActionCandidate(hits) {
  if (hits.length <= 1) return hits[0] || null;
  /** @type {HTMLElement | null} */
  let best = null;
  let bestKey = -1;
  for (const h of hits) {
    const r = h.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    const key = r.bottom * 10 + area;
    if (key > bestKey) {
      bestKey = key;
      best = h;
    }
  }
  return best;
}

/**
 * @param {Element | null} scope
 * @param {"Next" | "Post"} exactLabel
 * @param {boolean} [includeDisabled] if true, match gray / aria-disabled controls too (wait-then-click)
 */
function findComposerActionButton(scope, exactLabel, includeDisabled = false) {
  const expanded = expandScopeToComposerDialog(scope instanceof Element ? scope : null);
  const root = expanded instanceof HTMLElement ? expanded : document.body;
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const wantAria = exactLabel.toLowerCase();
  const ok = (/** @type {HTMLElement} */ el) =>
    includeDisabled ? isComposerPrimaryActionInDomTree(el) : isComposerPrimaryActionEnabled(el);

  try {
    const direct = root.querySelector(`[role="button"][aria-label="${CSS.escape(exactLabel)}"]`);
    if (direct instanceof HTMLElement && ok(direct)) return direct;
  } catch {
    // ignore invalid selector edge cases
  }

  /** @type {HTMLElement[]} */
  const hits = [];
  for (const b of root.querySelectorAll('[role="button"]')) {
    if (!(b instanceof HTMLElement)) continue;
    if (!ok(b)) continue;
    const aria = norm(b.getAttribute("aria-label") || "").toLowerCase();
    const t = norm(b.textContent);
    if (t === exactLabel || aria === wantAria) hits.push(b);
  }
  if (hits.length) return pickBestComposerActionCandidate(hits);

  for (const sp of root.querySelectorAll("span")) {
    if (sp.children.length > 0) continue;
    if (norm(sp.textContent) !== exactLabel) continue;
    let node = sp.parentElement;
    for (let d = 0; d < 10 && node; d++, node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      const role = node.getAttribute("role");
      if (role === "button" || node.getAttribute("tabindex") === "0") {
        if (ok(node)) return node;
      }
    }
  }
  return null;
}

/**
 * Last-resort diagnostics when a labeled composer control is never clicked.
 * @param {Element | null} scope
 * @param {"Next" | "Post"} label
 */
function snapshotComposerLabeledControl(scope, label) {
  const sc =
    scope instanceof Element ? scope : findCreatePostRegion() || document.body;
  const expanded = expandScopeToComposerDialog(sc instanceof Element ? sc : null);
  const root = expanded instanceof HTMLElement ? expanded : document.body;
  const present = findComposerActionButton(sc, label, true);
  const enabled = findComposerActionButton(sc, label, false);
  const box = (h) =>
    h instanceof HTMLElement
      ? (() => {
          const r = h.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
        })()
      : null;
  const describe = (h) =>
    h instanceof HTMLElement
      ? {
          tag: h.tagName,
          ariaLabel: (h.getAttribute("aria-label") || "").slice(0, 48),
          ariaDisabled: h.getAttribute("aria-disabled"),
          ariaBusy: h.getAttribute("aria-busy"),
          tabindex: h.getAttribute("tabindex"),
          inDomTree: isComposerPrimaryActionInDomTree(h),
          enabled: isComposerPrimaryActionEnabled(h),
          cursor: typeof getComputedStyle === "function" ? getComputedStyle(h).cursor : "",
          rect: box(h)
        }
      : null;
  let ariaMatchCount = -1;
  try {
    ariaMatchCount = root.querySelectorAll(`[role="button"][aria-label="${CSS.escape(label)}"]`).length;
  } catch {
    ariaMatchCount = -1;
  }
  return {
    label,
    searchScope:
      sc instanceof HTMLElement
        ? { tag: sc.tagName, role: sc.getAttribute("role"), ariaLabel: (sc.getAttribute("aria-label") || "").slice(0, 60) }
        : null,
    expanded:
      expanded instanceof HTMLElement
        ? {
            tag: expanded.tagName,
            role: expanded.getAttribute("role"),
            ariaLabel: (expanded.getAttribute("aria-label") || "").slice(0, 80)
          }
        : { tag: String(expanded) },
    present: describe(present),
    readyToClick: describe(enabled),
    ariaLabelMatchCount: ariaMatchCount
  };
}

/**
 * @param {"Next" | "Post"} label
 * @param {number} attempts
 * @param {Element | null} [preferredScope] dialog or subtree for this composer (avoids wrong Next/Post)
 */
async function clickComposerLabeledButton(label, attempts = 10, preferredScope = null) {
  const regionHint = findCreatePostRegion();
  const isNext = label === "Next";
  for (let i = 0; i < attempts; i++) {
    const scope =
      preferredScope instanceof Element
        ? preferredScope
        : findCreatePostRegion() || regionHint || document.body;
    const ready = findComposerActionButton(scope, label, false);
    if (ready) {
      ready.scrollIntoView({ block: "nearest", behavior: "instant" });
      await sleep(80);
      synthesizeUserLikePrimaryClick(ready);
      postgrabberLog("info", "composer", `${label} click dispatched`, {
        attempt: i + 1,
        ariaDisabled: ready.getAttribute("aria-disabled")
      });
      return true;
    }
    const present = findComposerActionButton(scope, label, true);
    const waitingOnDisabled =
      present instanceof HTMLElement &&
      isComposerPrimaryActionInDomTree(present) &&
      !isComposerPrimaryActionEnabled(present);
    const delay = waitingOnDisabled ? (isNext ? 820 : 560) : isNext ? 420 : 380;
    await sleep(delay);
  }
  postgrabberLog("error", "composer", `${label} was not clicked after ${attempts} attempts`, snapshotComposerLabeledControl(preferredScope, label));
  return false;
}

/**
 * Clicks Next then Post when the multi-step composer is shown; if Next never appears, tries Post only.
 * @param {Element | null} [actionScope] composer dialog (from fill flow) so buttons are found in the same shell
 * @param {{ hadMedia?: boolean }} [opts] when media was attached, Next stays disabled longer while FB processes the file
 * @returns {{ nextClicked: boolean; postClicked: boolean }}
 */
async function composerNextThenPost(actionScope = null, opts = {}) {
  const hadMedia = opts.hadMedia === true;
  postgrabberLog("info", "composer", "composerNextThenPost start", {
    hadMedia,
    scope:
      actionScope instanceof HTMLElement
        ? {
            tag: actionScope.tagName,
            role: actionScope.getAttribute("role"),
            ariaLabel: (actionScope.getAttribute("aria-label") || "").slice(0, 80)
          }
        : null
  });
  await sleep(hadMedia ? 1600 : 750);
  const nextAttempts = hadMedia ? 55 : 26;
  const nextOk = await clickComposerLabeledButton("Next", nextAttempts, actionScope);
  if (nextOk) await sleep(hadMedia ? 1400 : 1100);
  const postOk = await clickComposerLabeledButton("Post", hadMedia ? 36 : 24, actionScope);
  const meta = { nextClicked: nextOk, postClicked: postOk };
  postgrabberLog(nextOk && postOk ? "info" : "warn", "composer", "composerNextThenPost end", meta);
  if (!postOk && !nextOk) {
    return { nextClicked: false, postClicked: false };
  }
  if (!postOk && nextOk) {
    return { nextClicked: true, postClicked: false };
  }
  return { nextClicked: nextOk, postClicked: postOk };
}

/**
 * @param {string} url
 */
function looksLikeDirectImageUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  if (/facebook\.com\/(photo|permalink|story)/i.test(url)) return false;
  return /\.(jpe?g|png|webp|gif|heic|heif)(\?|$)/i.test(url) || /fbcdn\.net|fna\.fbcdn/i.test(url);
}

/**
 * @param {string} url
 */
function looksLikeDirectVideoFileUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  return /\.(mp4|webm|mov|m4v|mkv|avi)(\?|$)/i.test(url);
}

/**
 * @returns {HTMLElement | null}
 */
function findCreatePostRegion() {
  const byLabel = document.querySelector('[role="region"][aria-label="Create a post"]');
  if (byLabel instanceof HTMLElement) return byLabel;
  const dlg = document.querySelector('[role="dialog"]');
  if (dlg instanceof HTMLElement && /create a post/i.test(dlg.getAttribute("aria-label") || "")) return dlg;
  if (dlg instanceof HTMLElement && dlg.querySelector('[data-lexical-editor="true"]')) return dlg;
  return null;
}

/**
 * Same composer surface for caption + file input: anchor to the Lexical editor’s tree,
 * not the first dialog in document order (FB can stack multiple overlays).
 * @param {HTMLElement} editor
 * @returns {HTMLElement}
 */
function resolveComposerScopeFromEditor(editor) {
  if (!(editor instanceof HTMLElement)) return document.body;
  const createDlg = editor.closest('[role="dialog"][aria-label*="Create" i]');
  if (createDlg instanceof HTMLElement) return createDlg;
  const region = editor.closest('[role="region"][aria-label="Create a post"]');
  if (region instanceof HTMLElement) return region;
  const anyDlg = editor.closest('[role="dialog"]');
  if (anyDlg instanceof HTMLElement) return anyDlg;
  const fromFb = findCreatePostRegion();
  if (fromFb instanceof HTMLElement) return fromFb;
  return document.body;
}

/**
 * @param {Element} scope
 * @param {number} [minWidth]
 * @returns {HTMLElement | null}
 */
function findVisibleLexicalEditorInScope(scope, minWidth = 100) {
  if (!(scope instanceof Element)) return findVisibleLexicalEditor(minWidth);
  const nodes = scope.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"]');
  /** @type {HTMLElement | null} */
  let best = null;
  let bestArea = 0;
  for (const el of nodes) {
    if (!(el instanceof HTMLElement)) continue;
    const r = el.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    if (r.width < minWidth && r.height < 40) continue;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

/**
 * @param {Element} scope
 * @param {number} timeoutMs
 * @returns {Promise<HTMLElement | null>}
 */
async function waitForLexicalEditorInScope(scope, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const el = findVisibleLexicalEditorInScope(scope, 120);
    if (el) return el;
    await sleep(120);
  }
  return findVisibleLexicalEditorInScope(scope, 80);
}

/**
 * @param {number} [minWidth]
 * @returns {HTMLElement | null}
 */
function findVisibleLexicalEditor(minWidth = 100) {
  const nodes = document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"]');
  /** @type {HTMLElement | null} */
  let best = null;
  let bestArea = 0;
  for (const el of nodes) {
    if (!(el instanceof HTMLElement)) continue;
    const inCreate = el.closest('[aria-label="Create a post"], [role="dialog"]');
    const r = el.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    if (r.width < minWidth && r.height < 40) continue;
    if (inCreate) return el;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<HTMLElement | null>}
 */
async function waitForLexicalEditor(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const el = findVisibleLexicalEditor(120);
    if (el) return el;
    await sleep(120);
  }
  return findVisibleLexicalEditor(80);
}

async function openComposerIfClosed() {
  if (findVisibleLexicalEditor(120)) return;

  const ariaTriggers = [
    '[aria-label*="What\'s on your mind" i]',
    '[aria-label*="What is on your mind" i]',
    '[data-placeholder*="What\'s on your mind" i]',
    '[aria-placeholder*="What\'s on your mind" i]'
  ];
  for (const sel of ariaTriggers) {
    const el = document.querySelector(sel);
    if (el instanceof HTMLElement) {
      el.click();
      await sleep(550);
      if (findVisibleLexicalEditor(100)) return;
    }
  }

  const btn = Array.from(document.querySelectorAll('[role="button"]')).find((b) => {
    if (!(b instanceof HTMLElement)) return false;
    const a = (b.getAttribute("aria-label") || "").toLowerCase();
    const t = (b.textContent || "").toLowerCase();
    return (
      a.includes("what's on your mind") ||
      a.includes("what is on your mind") ||
      (t.includes("what's on your mind") && t.length < 80)
    );
  });
  if (btn instanceof HTMLElement) {
    btn.click();
    await sleep(650);
  }
}

/**
 * Arabic / Hebrew / Syriac and presentation forms — mixed English in the same string still benefits from `dir="auto"`.
 * @param {string} s
 */
function textContainsStrongRtlScript(s) {
  return typeof s === "string" && /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(s);
}

/**
 * @param {HTMLElement} el
 * @param {string} text
 */
function ensureLexicalEditorDirAuto(el, text) {
  if (!(el instanceof HTMLElement) || !textContainsStrongRtlScript(text)) return;
  el.setAttribute("dir", "auto");
}

/**
 * @param {HTMLElement} el
 * @param {string} text
 */
function insertIntoLexicalEditor(el, text) {
  if (!text) return;
  ensureLexicalEditorDirAuto(el, text);
  el.focus();
  try {
    document.execCommand("selectAll", false, undefined);
  } catch {
    // ignore
  }

  let ok = false;
  try {
    ok = document.execCommand("insertText", false, text);
  } catch {
    ok = false;
  }

  if (!ok) {
    try {
      const parts = escapeHtmlForComposer(text).split("\n");
      const html = parts.map((p) => `<p dir="auto">${p}</p>`).join("");
      document.execCommand("insertHTML", false, html);
      ok = true;
    } catch {
      // ignore
    }
  }

  if (!ok) {
    el.textContent = text;
  }

  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text
    })
  );
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * @param {HTMLElement} el
 * @param {string} text
 */
function appendPlainTextToEditor(el, text) {
  if (!text) return;
  ensureLexicalEditorDirAuto(el, text);
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  try {
    document.execCommand("insertText", false, text);
  } catch {
    el.appendChild(document.createTextNode(text));
  }
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text
    })
  );
}

function escapeHtmlForComposer(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {string} url
 * @returns {Promise<Blob | null>}
 */
async function fetchMediaBlobWithFallback(url) {
  const hint = typeof url === "string" ? url.slice(0, 120) : "";
  // fbcdn often responds with Access-Control-Allow-Origin: * — browsers forbid
  // credentials: "include" with that combination (CORS error).
  try {
    const r = await fetch(url, { credentials: "omit", mode: "cors", cache: "no-store" });
    if (r.ok) {
      const b = await r.blob();
      if (b && b.size > 0) {
        postgrabberLog("debug", "media", "fetchMediaBlob page fetch ok", { hint, bytes: b.size });
        return b;
      }
      postgrabberLog("warn", "media", "fetchMediaBlob page fetch empty body", { hint, type: b?.type });
    } else {
      postgrabberLog("warn", "media", "fetchMediaBlob page fetch HTTP", { hint, status: r.status });
    }
  } catch (e) {
    postgrabberLog("debug", "media", "fetchMediaBlob page fetch threw", {
      hint,
      message: e instanceof Error ? e.message : String(e)
    });
  }

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: "fetchMediaBuffer", url }, (resp) => {
        const le = chrome.runtime.lastError?.message;
        if (le) postgrabberLog("warn", "media", "fetchMediaBuffer extension bridge", { hint, lastError: le });
        if (!resp?.ok || !resp.buffer) {
          postgrabberLog("warn", "media", "fetchMediaBuffer background response", {
            hint,
            ok: resp?.ok,
            error: resp?.error
          });
          resolve(null);
          return;
        }
        try {
          postgrabberLog("debug", "media", "fetchMediaBuffer background ok", { hint, bytes: resp.buffer.byteLength });
          resolve(new Blob([resp.buffer], { type: resp.mime || "application/octet-stream" }));
        } catch (e) {
          postgrabberLog("error", "media", "fetchMediaBuffer Blob construct failed", {
            hint,
            message: e instanceof Error ? e.message : String(e)
          });
          resolve(null);
        }
      });
    } catch (e) {
      postgrabberLog("error", "media", "fetchMediaBuffer sendMessage threw", {
        hint,
        message: e instanceof Error ? e.message : String(e)
      });
      resolve(null);
    }
  });
}

const FB_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const FB_TARGET_PHOTO_BYTES = 9.5 * 1024 * 1024;

/**
 * @param {ArrayBuffer} ab
 */
function sniffImageMimeFromBytes(ab) {
  const u = new Uint8Array(ab.slice(0, 16));
  if (u.length < 3) return "";
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return "image/jpeg";
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return "image/png";
  if (u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) return "image/gif";
  if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) return "image/webp";
  if (u[0] === 0x49 && u[1] === 0x49 && u[2] === 0x2a && u[3] === 0x0) return "image/tiff";
  if (u[0] === 0x4d && u[1] === 0x4d && u[2] === 0x0 && u[3] === 0x2a) return "image/tiff";
  return "";
}

/**
 * Normalize CDN blobs (often octet-stream) into a JPEG File Facebook accepts.
 * @param {Blob} blob
 * @returns {Promise<File | null>}
 */
async function prepareFacebookPhotoFile(blob) {
  if (!blob || blob.size < 32) return null;

  const ab = await blob.arrayBuffer();
  let mime = (blob.type || "").split(";")[0].trim().toLowerCase();
  if (
    !mime ||
    mime === "application/octet-stream" ||
    mime === "binary/octet-stream" ||
    mime === "application/unknown"
  ) {
    mime = sniffImageMimeFromBytes(ab) || "image/jpeg";
  }

  const typedBlob = new Blob([ab], { type: mime });

  /** @type {ImageBitmap | null} */
  let bmp = null;
  try {
    bmp = await createImageBitmap(typedBlob);
  } catch {
    bmp = null;
  }

  if (!bmp) {
    if (blob.size > FB_MAX_PHOTO_BYTES) return null;
    const ext =
      mime === "image/png"
        ? "png"
        : mime === "image/webp"
          ? "webp"
          : mime === "image/gif"
            ? "gif"
            : mime === "image/tiff"
              ? "tiff"
              : "jpg";
    return new File([ab], `postgrabber-photo.${ext}`, { type: mime, lastModified: Date.now() });
  }

  let w = bmp.width;
  let h = bmp.height;
  const maxSide = 4096;
  const s0 = Math.min(1, maxSide / Math.max(w, h, 1));
  w = Math.max(1, Math.round(w * s0));
  h = Math.max(1, Math.round(h * s0));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close?.();
    return null;
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  let quality = 0.9;
  /** @type {Blob | null} */
  let jpegBlob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
  if (!jpegBlob) return null;
  while (jpegBlob.size > FB_TARGET_PHOTO_BYTES && quality > 0.48) {
    quality -= 0.06;
    const next = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (!next) break;
    jpegBlob = next;
  }

  while (jpegBlob.size > FB_TARGET_PHOTO_BYTES && w > 360) {
    w = Math.max(320, Math.round(w * 0.72));
    h = Math.max(320, Math.round(h * 0.72));
    canvas.width = w;
    canvas.height = h;
    const b2 = await createImageBitmap(jpegBlob);
    ctx.drawImage(b2, 0, 0, w, h);
    b2.close();
    quality = 0.82;
    const next = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (!next) break;
    jpegBlob = next;
  }

  if (!jpegBlob || jpegBlob.size === 0 || jpegBlob.size > FB_MAX_PHOTO_BYTES) return null;

  return new File([jpegBlob], "postgrabber-photo.jpg", {
    type: "image/jpeg",
    lastModified: Date.now()
  });
}

/**
 * @param {Blob} blob
 * @param {string} baseName
 */
function blobToFile(blob, baseName) {
  const mime = blob.type || "application/octet-stream";
  let ext = "bin";
  if (mime.includes("jpeg") || mime.includes("jpg")) ext = "jpg";
  else if (mime.includes("png")) ext = "png";
  else if (mime.includes("webp")) ext = "webp";
  else if (mime.includes("gif")) ext = "gif";
  else if (mime.includes("mp4")) ext = "mp4";
  else if (mime.includes("webm")) ext = "webm";
  else if (mime.includes("quicktime") || mime.includes("mov")) ext = "mov";
  return new File([blob], `${baseName}.${ext}`, { type: mime });
}

/**
 * @param {HTMLInputElement} input
 * @param {File} file
 */
function assignFileToInput(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
  if (proto?.set) {
    proto.set.call(input, dt.files);
  } else {
    input.files = dt.files;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * File inputs for photo/video often sit in dialog chrome outside the Lexical subtree.
 * @param {Element} scope
 * @param {"image" | "video"} kind
 */
function findComposerFileInput(scope, kind) {
  /** @type {Element[]} */
  const roots = [];
  const add = (el) => {
    if (el instanceof Element && !roots.includes(el)) roots.push(el);
  };
  if (scope instanceof Element) {
    add(scope);
    const expanded = expandScopeToComposerDialog(scope);
    if (expanded instanceof HTMLElement) add(expanded);
  }
  const region = findCreatePostRegion();
  if (region instanceof HTMLElement) add(region);

  /** @type {HTMLInputElement | null} */
  let any = null;
  for (const root of roots.length ? roots : [document.body]) {
    const inputs = root.querySelectorAll('input[type="file"]');
    for (const inp of inputs) {
      if (!(inp instanceof HTMLInputElement)) continue;
      any = any || inp;
      const acc = (inp.getAttribute("accept") || "").toLowerCase();
      if (kind === "image" && acc.includes("image")) return inp;
      if (kind === "video" && acc.includes("video")) return inp;
      if (acc.includes("image") && acc.includes("video")) return inp;
    }
  }
  return any;
}

/**
 * @param {Element} scope
 * @param {File} file
 * @param {"image" | "video"} kind
 */
async function attachFileToComposer(scope, file, kind) {
  const input = findComposerFileInput(scope, kind);
  if (!input) {
    postgrabberLog("warn", "fill", "attachFileToComposer: no file input (searched scope + dialog + region)", {
      kind,
      scope:
        scope instanceof HTMLElement
          ? { tag: scope.tagName, role: scope.getAttribute("role") }
          : null
    });
    return false;
  }
  assignFileToInput(input, file);
  await sleep(350);
  postgrabberLog("info", "fill", "attachFileToComposer ok", { kind, fileName: file.name, bytes: file.size });
  return true;
}

/**
 * @param {{ text?: string; imageUrl?: string | null; videoUrl?: string | null }} post
 * @param {{ attachMedia?: boolean; autoAdvance?: boolean }} [options]
 */
async function fillComposerWithPost(post, options = {}) {
  const attachMedia = options.attachMedia !== false;
  const autoAdvance = options.autoAdvance === true;
  /** @type {{ text: boolean; image: string; video: string }} */
  const details = { text: false, image: "skipped", video: "skipped" };

  postgrabberLog("info", "fill", "fillComposerWithPost", { attachMedia, autoAdvance });

  await openComposerIfClosed();
  await sleep(200);

  let editor = await waitForLexicalEditor(4200);
  if (!editor) {
    await openComposerIfClosed();
    editor = await waitForLexicalEditor(2000);
  }
  if (!editor) {
    postgrabberLog("error", "fill", "Lexical editor not found", { url: location.href.slice(0, 120) });
    return {
      ok: false,
      error:
        "Could not find the Facebook composer (Lexical). Open “Create post” or click “What’s on your mind?” first, then try again.",
      details
    };
  }

  let composerScope = resolveComposerScopeFromEditor(editor);
  postgrabberLog("info", "fill", "composerScope", {
    tag: composerScope.tagName,
    role: composerScope.getAttribute("role"),
    ariaLabel: (composerScope.getAttribute("aria-label") || "").slice(0, 100)
  });

  // Attach media before caption text: choosing a file often clears the Lexical draft, which caused “image only”.
  if (attachMedia && post.imageUrl && looksLikeDirectImageUrl(post.imageUrl)) {
    try {
      const blob = await fetchMediaBlobWithFallback(post.imageUrl);
      if (blob && blob.size > 0) {
        const file = await prepareFacebookPhotoFile(blob);
        if (file) {
          const ok = await attachFileToComposer(composerScope, file, "image");
          details.image = ok ? "attached" : "input_failed";
        } else {
          details.image = "encode_failed";
        }
      } else {
        details.image = "fetch_failed";
      }
    } catch (e) {
      postgrabberLog("error", "fill", "image attach threw", {
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined
      });
      details.image = "error";
    }
  } else if (post.imageUrl && attachMedia) {
    details.image = "not_direct_url";
  }

  await sleep(attachMedia && post.imageUrl && details.image === "attached" ? 650 : 0);

  const imageAttached = details.image === "attached";
  if (
    attachMedia &&
    !imageAttached &&
    post.videoUrl &&
    looksLikeDirectVideoFileUrl(post.videoUrl)
  ) {
    try {
      const blob = await fetchMediaBlobWithFallback(post.videoUrl);
      if (blob && blob.size > 0) {
        const file = blobToFile(blob, "postgrabber-video");
        const ok = await attachFileToComposer(composerScope, file, "video");
        details.video = ok ? "attached" : "input_failed";
      } else {
        details.video = "fetch_failed";
      }
    } catch (e) {
      postgrabberLog("error", "fill", "video attach threw", {
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined
      });
      details.video = "error";
    }
  } else if (post.videoUrl && attachMedia && !imageAttached) {
    details.video = "not_direct_file_url";
  }

  if (details.video === "attached" || details.image === "attached") {
    await sleep(400);
  }

  let editorAfter =
    (await waitForLexicalEditorInScope(composerScope, 2800)) ||
    findVisibleLexicalEditorInScope(composerScope, 80);
  if (!editorAfter) {
    editorAfter = (await waitForLexicalEditor(1200)) || findVisibleLexicalEditor(80);
  }
  if (editorAfter) {
    editor = editorAfter;
    composerScope = resolveComposerScopeFromEditor(editor);
    postgrabberLog("info", "fill", "composerScope after media", {
      tag: composerScope.tagName,
      role: composerScope.getAttribute("role"),
      ariaLabel: (composerScope.getAttribute("aria-label") || "").slice(0, 100)
    });
  }

  postgrabberLog("info", "fill", "media phase summary", { details });

  const body = composeBodyTextOnly(post);
  const needsCaptionSlot = Boolean(body) || Boolean(post.imageUrl || post.videoUrl);
  const bodyToInsert =
    body || (needsCaptionSlot && (details.image === "attached" || details.video === "attached") ? "\u00a0" : "");
  if (bodyToInsert) {
    insertIntoLexicalEditor(editor, bodyToInsert);
    details.text = true;
  }

  const extraLines = [];
  if (details.image !== "attached" && post.imageUrl) extraLines.push("", `Image: ${post.imageUrl}`);
  if (details.video !== "attached" && post.videoUrl) extraLines.push("", `Video: ${post.videoUrl}`);
  const appendix = extraLines.join("\n").trim();
  if (appendix) {
    appendPlainTextToEditor(editor, `\n\n${appendix}`);
  }

  if (autoAdvance) {
    const hadMedia = details.image === "attached" || details.video === "attached";
    postgrabberLog("info", "fill", "starting autoAdvance (Next + Post)", { hadMedia, details });
    const publishMeta = await composerNextThenPost(composerScope, { hadMedia });
    return {
      ok: true,
      details,
      published: publishMeta.postClicked,
      publishMeta
    };
  }

  postgrabberLog("info", "fill", "Next/Post not run (autoAdvance=false). Use Publish next or Publish entire queue to click Next then Post.", {
    details
  });

  return { ok: true, details };
}
