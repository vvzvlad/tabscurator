// Offscreen recorder for Tack voice notes (§16 item 26). The page being annotated may be
// plain http, where getUserMedia is not available at all; this hidden extension document
// has a secure origin of its own. The service worker creates it for `start` and closes it
// after `stop`; offscreen documents get only chrome.runtime, so all of it is messaging.
//
// It cannot show the microphone prompt: without a grant `start` answers
// `{ok:false, permission:true}` and the worker opens pages/mic.html to ask once.
//
// Pure parts are exported for unit tests; the listener is wired only in a document.

import { OFFSCREEN_TARGET } from "../src/tack-bridge.js";

// btoa over the whole buffer at once overflows the argument list on a long recording.
export function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// env: {permissionState() -> 'granted'|'prompt'|'denied', getUserMedia, MediaRecorder}
export function createRecorder(env) {
  let rec = null;
  let chunks = [];

  async function start() {
    // A recording nobody stopped — its tab closed or reloaded, or Tack gave up waiting for
    // the start answer — belongs to no note: it is stopped and its audio dropped.
    if (rec) {
      const old = rec;
      rec = null;
      old.ondataavailable = null;
      old.stop();
      old.stream.getTracks().forEach((t) => t.stop());
      chunks = [];
    }
    if ((await env.permissionState()) !== "granted") return { ok: false, permission: true };
    const stream = await env.getUserMedia({ audio: true });
    chunks = [];
    rec = new env.MediaRecorder(stream);
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.start();
    return { ok: true };
  }

  // stop() delivers the last dataavailable before the stop event (MediaRecorder spec).
  async function stop() {
    if (!rec) return { ok: false, error: "nothing is being recorded" };
    const r = rec;
    rec = null;
    await new Promise((resolve) => {
      r.onstop = resolve;
      r.stop();
    });
    r.stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: r.mimeType });
    return { ok: true, audio: base64(new Uint8Array(await blob.arrayBuffer())), mime: r.mimeType };
  }

  return { start, stop };
}

if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.runtime) {
  const recorder = createRecorder({
    permissionState: async () => (await navigator.permissions.query({ name: "microphone" })).state,
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    MediaRecorder,
  });
  const extensionBase = chrome.runtime.getURL("");
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only the worker drives the recorder; a website frame's messages reach every
    // extension context, this one included.
    if (!msg || msg.target !== OFFSCREEN_TARGET || sender.tab) return false;
    if (!String(sender.url || "").startsWith(extensionBase)) return false;
    const run = msg.type === "start" ? recorder.start : recorder.stop;
    run().then(sendResponse, (e) =>
      sendResponse({ ok: false, error: String((e && e.message) || e) }),
    );
    return true; // async response
  });
}
