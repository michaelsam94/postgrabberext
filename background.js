importScripts("logger.js");

const MENU_ROOT = "postgrabber-root";
const MENU_COPY = "postgrabber-copy";
const MENU_SAVE = "postgrabber-save";
const MENU_OPEN = "postgrabber-open";

const STORAGE_KEY = "postgrabber_queue";

function ensureContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ROOT,
      title: "PostGrabber",
      contexts: ["page", "frame", "selection", "link", "image", "video", "audio"],
      documentUrlPatterns: ["*://*.facebook.com/*", "*://facebook.com/*"]
    });
    chrome.contextMenus.create({
      id: MENU_COPY,
      parentId: MENU_ROOT,
      title: "Copy post (text & media)",
      contexts: ["page", "frame", "selection", "link", "image", "video", "audio"],
      documentUrlPatterns: ["*://*.facebook.com/*", "*://facebook.com/*"]
    });
    chrome.contextMenus.create({
      id: MENU_SAVE,
      parentId: MENU_ROOT,
      title: "Save post to queue (JSON cache)",
      contexts: ["page", "frame", "selection", "link", "image", "video", "audio"],
      documentUrlPatterns: ["*://*.facebook.com/*", "*://facebook.com/*"]
    });
    chrome.contextMenus.create({
      id: MENU_OPEN,
      parentId: MENU_ROOT,
      title: "Open queue & tools…",
      contexts: ["page", "frame", "selection", "link", "image", "video", "audio"],
      documentUrlPatterns: ["*://*.facebook.com/*", "*://facebook.com/*"]
    });
  });
}

chrome.runtime.onInstalled.addListener(ensureContextMenu);

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

const MAX_MEDIA_FETCH_BYTES = 48 * 1024 * 1024;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action !== "fetchMediaBuffer") return;

  (async () => {
    try {
      const url = msg.url;
      if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        postgrabberLog("warn", "background", "fetchMediaBuffer bad_url", { url: String(url).slice(0, 120) });
        sendResponse({ ok: false, error: "bad_url" });
        return;
      }
      const r = await fetch(url, { redirect: "follow", credentials: "omit", cache: "no-store" });
      if (!r.ok) {
        postgrabberLog("warn", "background", "fetchMediaBuffer HTTP error", { url, status: r.status });
        sendResponse({ ok: false, error: `http_${r.status}` });
        return;
      }
      const len = r.headers.get("content-length");
      if (len && Number(len) > MAX_MEDIA_FETCH_BYTES) {
        postgrabberLog("warn", "background", "fetchMediaBuffer rejected size (header)", { url, len });
        sendResponse({ ok: false, error: "too_large" });
        return;
      }
      const buf = await r.arrayBuffer();
      if (buf.byteLength > MAX_MEDIA_FETCH_BYTES) {
        postgrabberLog("warn", "background", "fetchMediaBuffer rejected size (body)", {
          url,
          bytes: buf.byteLength
        });
        sendResponse({ ok: false, error: "too_large" });
        return;
      }
      const mime = r.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
      sendResponse({ ok: true, buffer: buf, mime });
    } catch (e) {
      postgrabberLog("error", "background", "fetchMediaBuffer exception", {
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined
      });
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();

  return true;
});

function sendToFrame(tabId, msg, frameId, cb) {
  const opts = typeof frameId === "number" ? { frameId } : {};
  chrome.tabs.sendMessage(tabId, msg, opts, cb);
}

async function appendPostToStorage(record) {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const queue = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  queue.push(record);
  await chrome.storage.local.set({ [STORAGE_KEY]: queue });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id == null) return;

  const frameId = typeof info.frameId === "number" ? info.frameId : undefined;

  if (info.menuItemId === MENU_OPEN) {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (info.menuItemId === MENU_COPY) {
    sendToFrame(tab.id, { action: "copyPost" }, frameId, () => {
      void chrome.runtime.lastError;
    });
    return;
  }

  if (info.menuItemId === MENU_SAVE) {
    sendToFrame(tab.id, { action: "getPostSnapshot" }, frameId, async (res) => {
      if (chrome.runtime.lastError) return;
      if (!res?.ok || !res.record) return;
      try {
        await appendPostToStorage(res.record);
      } catch (e) {
        postgrabberLog("error", "background", "appendPostToStorage failed", {
          message: e instanceof Error ? e.message : String(e)
        });
      }
    });
    return;
  }
});
