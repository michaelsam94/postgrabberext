"use strict";

(function (g) {
  const MAX = 200;
  /** @type {string[]} */
  const ring = [];

  function ts() {
    return new Date().toISOString().slice(11, 23);
  }

  /**
   * @param {"debug"|"info"|"warn"|"error"} level
   * @param {string} area
   * @param {string} message
   * @param {unknown} [data]
   */
  function postgrabberLog(level, area, message, data) {
    const head = `[PostGrabber ${ts()}] [${area}] ${message}`;
    let tail = "";
    if (data !== undefined) {
      try {
        tail =
          typeof data === "string"
            ? data
            : JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      } catch {
        tail = String(data);
      }
    }
    const line = tail ? `${head} ${tail}` : head;
    ring.push(line);
    if (ring.length > MAX) ring.splice(0, ring.length - MAX);

    if (level === "error") console.error(head, data !== undefined ? data : "");
    else if (level === "warn") console.warn(head, data !== undefined ? data : "");
    else if (level === "debug") console.debug(head, data !== undefined ? data : "");
    else console.info(head, data !== undefined ? data : "");
  }

  g.postgrabberLog = postgrabberLog;
  g.postgrabberLogCopy = function postgrabberLogCopy() {
    return ring.join("\n");
  };
  g.postgrabberLogClear = function postgrabberLogClear() {
    ring.length = 0;
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
