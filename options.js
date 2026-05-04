"use strict";

/* global postgrabberLog */

const STORAGE_KEY = "postgrabber_queue";
const OPT_LOAD_AUTO_ADVANCE = "postgrabber_opt_loadAutoAdvance";

const rowsEl = document.getElementById("rows");
const statusEl = document.getElementById("status");

document.getElementById("btnReload").addEventListener("click", () => {
  void refresh();
});
document.getElementById("btnExport").addEventListener("click", () => {
  void exportJson();
});
document.getElementById("btnClear").addEventListener("click", () => {
  void clearAll();
});
document.getElementById("btnLoadNext").addEventListener("click", () => {
  void loadNextIntoComposer(false);
});
document.getElementById("btnLoadNextPop").addEventListener("click", () => {
  void loadNextIntoComposer(true);
});
document.getElementById("btnPublishNextPop").addEventListener("click", () => {
  void publishNextAndRemove();
});
document.getElementById("btnPublishAll").addEventListener("click", () => {
  void publishEntireQueue();
});
document.getElementById("btnOpenFb").addEventListener("click", () => {
  void chrome.tabs.create({ url: "https://www.facebook.com/", active: true });
});

document.getElementById("fileImport").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) void importJsonFile(file);
});

function setStatus(text) {
  statusEl.textContent = text || "";
}

async function getQueue() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [STORAGE_KEY]: queue });
}

async function getLoadAutoAdvance() {
  const data = await chrome.storage.local.get(OPT_LOAD_AUTO_ADVANCE);
  return data[OPT_LOAD_AUTO_ADVANCE] === true;
}

async function setLoadAutoAdvance(on) {
  await chrome.storage.local.set({ [OPT_LOAD_AUTO_ADVANCE]: on === true });
}

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function previewText(t, max = 220) {
  const s = (t || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

async function refresh() {
  const queue = await getQueue();
  rowsEl.innerHTML = "";

  queue.forEach((post, index) => {
    const tr = document.createElement("tr");

    const tdIdx = document.createElement("td");
    tdIdx.textContent = String(index + 1);

    const tdPrev = document.createElement("td");
    tdPrev.className = "preview";
    tdPrev.textContent = previewText(post.text);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = post.sourceUrl ? new URL(post.sourceUrl).hostname : "";
    tdPrev.appendChild(meta);

    const tdMedia = document.createElement("td");
    const bits = [];
    if (post.imageUrl) bits.push("image");
    if (post.videoUrl) bits.push("video");
    tdMedia.textContent = bits.length ? bits.join(", ") : "—";

    const tdWhen = document.createElement("td");
    tdWhen.textContent = formatDate(post.createdAt || 0);

    const tdAct = document.createElement("td");
    tdAct.className = "cell-actions";
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Remove";
    del.addEventListener("click", async () => {
      const q = await getQueue();
      q.splice(index, 1);
      await setQueue(q);
      await refresh();
      setStatus("Removed one item.");
    });
    tdAct.appendChild(del);

    tr.append(tdIdx, tdPrev, tdMedia, tdWhen, tdAct);
    rowsEl.appendChild(tr);
  });

  setStatus(queue.length ? `${queue.length} post(s) in queue.` : "Queue is empty.");
}

async function exportJson() {
  const queue = await getQueue();
  const blob = new Blob([JSON.stringify(queue, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `postgrabber-queue-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Exported JSON.");
}

function normalizeImportedPost(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id:
      typeof raw.id === "string" && raw.id
        ? raw.id
        : typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `pg_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    text: typeof raw.text === "string" ? raw.text : "",
    imageUrl: raw.imageUrl == null ? null : String(raw.imageUrl),
    videoUrl: raw.videoUrl == null ? null : String(raw.videoUrl),
    sourceUrl: raw.sourceUrl == null ? null : String(raw.sourceUrl)
  };
}

async function importJsonFile(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    setStatus("Import failed: invalid JSON.");
    return;
  }

  if (!Array.isArray(parsed)) {
    setStatus("Import failed: JSON must be an array of posts.");
    return;
  }

  const incoming = parsed.map(normalizeImportedPost).filter(Boolean);
  const existing = await getQueue();
  await setQueue(existing.concat(incoming));
  await refresh();
  setStatus(`Appended ${incoming.length} post(s). Queue size is now ${existing.length + incoming.length}.`);
}

async function clearAll() {
  if (!confirm("Remove every saved post from the queue?")) return;
  await setQueue([]);
  await refresh();
  setStatus("Queue cleared.");
}

function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    function listener(id, info) {
      if (id !== tabId) return;
      if (info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
      if (Date.now() - t0 > 20000) {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getOrOpenFacebookTab() {
  const patterns = [
    "*://www.facebook.com/*",
    "*://web.facebook.com/*",
    "*://facebook.com/*",
    "*://m.facebook.com/*"
  ];
  const tabs = await chrome.tabs.query({ url: patterns });
  const existing = tabs.find((t) => typeof t.id === "number");
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }
  const created = await chrome.tabs.create({ url: "https://www.facebook.com/", active: true });
  if (created.id != null) await waitTabComplete(created.id);
  return created;
}

async function sendFillWithRetry(tabId, post, extraOptions = {}) {
  const msg = {
    action: "fillComposerWithPost",
    post,
    options: { attachMedia: true, ...extraOptions }
  };
  postgrabberLog("info", "options", "sendFillWithRetry start", {
    tabId,
    autoAdvance: extraOptions.autoAdvance === true
  });
  for (let i = 0; i < 6; i++) {
    const res = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (r) => {
        if (chrome.runtime.lastError) {
          postgrabberLog("warn", "options", "sendMessage failed", {
            attempt: i + 1,
            message: chrome.runtime.lastError.message
          });
          resolve(null);
        } else resolve(r);
      });
    });
    if (res) {
      postgrabberLog("info", "options", "sendFillWithRetry got response", {
        attempt: i + 1,
        ok: res.ok,
        error: res.error,
        published: res.published,
        publishMeta: res.publishMeta
      });
      return { ok: true, res };
    }
    await new Promise((r) => setTimeout(r, 450));
  }
  postgrabberLog("error", "options", "sendFillWithRetry exhausted retries", { tabId });
  return { ok: false, error: "Could not talk to the Facebook page yet. Wait for it to finish loading, then try again." };
}

async function loadNextIntoComposer(removeAfter) {
  const queue = await getQueue();
  if (!queue.length) {
    setStatus("Queue is empty.");
    return;
  }

  const post = queue[0];
  const tab = await getOrOpenFacebookTab();
  if (tab.id == null) {
    setStatus("No tab id.");
    return;
  }

  await new Promise((r) => setTimeout(r, removeAfter ? 700 : 400));

  const loadAutoAdvance = await getLoadAutoAdvance();
  const out = await sendFillWithRetry(tab.id, post, { autoAdvance: loadAutoAdvance });
  if (!out.ok) {
    setStatus(out.error || "Failed to reach the Facebook tab.");
    return;
  }
  if (!out.res?.ok) {
    setStatus(out.res?.error || "Failed to fill composer.");
    return;
  }

  const d = out.res.details;
  const detailStr =
    d && typeof d === "object"
      ? ` Text: ${d.text ? "yes" : "no"}. Image: ${d.image}. Video: ${d.video}.`
      : "";

  if (loadAutoAdvance && out.res.published !== true) {
    const meta = out.res.publishMeta ? JSON.stringify(out.res.publishMeta) : "";
    setStatus(
      `Composer was filled but Next/Post did not complete; queue unchanged.${detailStr} ${meta}`.trim()
    );
    return;
  }

  const publishHint = loadAutoAdvance
    ? " Next + Post completed (per checkbox)."
    : ' "Load next" only fills the composer unless the checkbox below is on. You can also use "Publish next" or "Publish entire queue".';

  if (removeAfter) {
    queue.shift();
    await setQueue(queue);
    await refresh();
    setStatus(`Loaded next into composer and removed from queue.${detailStr}${publishHint}`);
  } else {
    setStatus(`Loaded next into composer (queue unchanged).${detailStr}${publishHint}`);
  }
}

async function publishNextAndRemove() {
  const ok = window.confirm(
    "Publish the first queued post? PostGrabber will fill the composer, then click “Next” and “Post” in the English Facebook UI. The item is removed from the queue only if the Post step appears to succeed."
  );
  if (!ok) return;

  const queue = await getQueue();
  if (!queue.length) {
    setStatus("Queue is empty.");
    return;
  }

  const post = queue[0];
  const tab = await getOrOpenFacebookTab();
  if (tab.id == null) {
    setStatus("No tab id.");
    return;
  }

  await new Promise((r) => setTimeout(r, 550));
  const out = await sendFillWithRetry(tab.id, post, { autoAdvance: true });
  if (!out.ok) {
    setStatus(out.error || "Failed to reach the Facebook tab.");
    return;
  }
  if (!out.res?.ok) {
    setStatus(out.res?.error || "Failed to fill composer.");
    return;
  }
  if (out.res.published !== true) {
    const meta = out.res.publishMeta ? JSON.stringify(out.res.publishMeta) : "";
    setStatus(
      `Composer was filled but the Post step did not succeed; queue unchanged. ${meta}`.trim()
    );
    return;
  }

  queue.shift();
  await setQueue(queue);
  await refresh();
  setStatus("Published first item (Next + Post) and removed it from the queue.");
}

async function publishEntireQueue() {
  const ok = window.confirm(
    "Publish every post in the queue, in order? For each item: fill composer, click Next, click Post, then remove it. Use only if you trust the content. You can stop by closing Facebook or this page mid-run."
  );
  if (!ok) return;

  let published = 0;
  for (;;) {
    const queue = await getQueue();
    if (!queue.length) break;

    const tab = await getOrOpenFacebookTab();
    if (tab.id == null) {
      setStatus("No tab id.");
      return;
    }

    await new Promise((r) => setTimeout(r, published === 0 ? 550 : 2800));

    const out = await sendFillWithRetry(tab.id, queue[0], { autoAdvance: true });
    if (!out.ok) {
      setStatus(out.error || "Failed to reach the Facebook tab.");
      return;
    }
    if (!out.res?.ok) {
      setStatus(out.res?.error || `Fill failed at item ${published + 1}; queue unchanged.`);
      return;
    }
    if (out.res.published !== true) {
      const meta = out.res.publishMeta ? JSON.stringify(out.res.publishMeta) : "";
      setStatus(
        `Stopped at item ${published + 1}: Post step did not succeed; queue unchanged. ${meta}`.trim()
      );
      return;
    }

    queue.shift();
    await setQueue(queue);
    await refresh();
    published += 1;
    setStatus(`Published ${published} post(s); continuing…`);
  }

  setStatus(published ? `Finished. Published ${published} post(s).` : "Queue was already empty.");
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
    void refresh();
  }
});

const chkLoadAutoAdvance = document.getElementById("chkLoadAutoAdvance");
if (chkLoadAutoAdvance) {
  void (async () => {
    chkLoadAutoAdvance.checked = await getLoadAutoAdvance();
    chkLoadAutoAdvance.addEventListener("change", async () => {
      await setLoadAutoAdvance(chkLoadAutoAdvance.checked);
      setStatus(
        chkLoadAutoAdvance.checked
          ? "Load next will fill the composer, then click Next and Post."
          : "Load next will only fill the composer (no Next/Post)."
      );
    });
  })();
}

void refresh();
