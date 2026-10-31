// Page notes — the service-worker half of the Tack fork (§16 item 26).
//
// «📌 Разметить страницу» in the popup sends `tack_activate`: the vendored Tack
// (vendor/tack/) goes into the tab's MAIN world, where SPA history hooks and the
// frameworks' dev fields are visible, and the relay (src/tack-relay.js) into the
// ISOLATED world beside it. From then on the page talks to this worker through the relay
// only: `tack_send` posts the notes to the service, `tack_voice_start` / `tack_voice_stop`
// drive a microphone recording in an offscreen document (pages/offscreen.js) and post it
// for transcription, `tack_voice_cancel` (the note popup closed mid-recording) drops it.
// The service is reached over `/api/*` with the instance secret as the Bearer, the same
// credential as quick links (§6).
//
// Dependency-injected via `env` (see service-worker.js `tackEnv`) so vitest can run it.

import { httpBaseFromServiceUrl } from "./quicklinks.js";

// The only types a website's frame may send to the worker, and it may send nothing else.
export const TACK_PAGE_TYPES = new Set([
  "tack_send",
  "tack_voice_start",
  "tack_voice_stop",
  "tack_voice_cancel",
]);
export const OFFSCREEN_TARGET = "tack-offscreen";
export const OFFSCREEN_URL = "pages/offscreen.html";
export const MIC_PAGE = "pages/mic.html";

const MAIN_FILES = ["vendor/tack/tack-src.js", "vendor/tack/tack.js"];
const RELAY_FILES = ["src/tack-relay.js"];

// A frame of a website (a content script such as the relay) rather than one of the
// extension's own pages: it has a tab, and its URL is not under the extension's origin.
// The startpage also lives in a tab, which is why the URL decides.
export function isContentScript(sender, extensionBase) {
  return Boolean(sender && sender.tab) && !String(sender.url || "").startsWith(extensionBase);
}

// Injected into MAIN (top-level and closure-free, AGENTS.md). Marks the page as bridged
// before tack.js reads the flag, and switches an already-present Tack back on instead of
// loading it twice. true = Tack was there.
export function tackBridgeOn() {
  window.__tack_bridge = true;
  if (!window.__tack) return false;
  window.__tack.on();
  return true;
}

export async function activateTack(env, tabId) {
  const target = { tabId };
  const [probe] = await env.executeScript({ target, world: "MAIN", func: tackBridgeOn });
  const present = Boolean(probe && probe.result);
  if (!present) await env.executeScript({ target, world: "MAIN", files: MAIN_FILES });
  // Always: a relay from before an extension reload is dead (tack-relay.js).
  await env.executeScript({ target, world: "ISOLATED", files: RELAY_FILES });
  if (!present) await env.executeScript({ target, world: "MAIN", func: tackBridgeOn });
  return { ok: true };
}

// The server's own sentence about a refusal: a JSON body names it in `detail`, `message`
// or `error` (a 502 from the transcriber carries `{error, message}`), a plain-text body is
// the sentence itself.
export function refusalText(status, text) {
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (body && typeof body === "object") {
    for (const key of ["detail", "message", "error"]) {
      if (typeof body[key] === "string" && body[key]) return "HTTP " + status + ": " + body[key];
    }
  }
  const t = String(text || "").trim();
  return "HTTP " + status + (t ? ": " + t.slice(0, 300) : "");
}

// Tack waits 10 s for a send and 90 s for a voice stop (tack.js `ask`); the worker gives
// up on the service earlier, so Tack hears «not sent» from the worker instead of timing out
// while a fetch it no longer waits for is still running.
const SEND_MS = 8000;
const TRANSCRIBE_MS = 85000;

async function postApi(env, path, payload, ms) {
  const cred = await env.credential();
  if (!cred || !cred.serviceUrl || !cred.secret) {
    throw new Error("this browser is not enrolled with the curator — open the extension options");
  }
  let resp, text;
  try {
    resp = await env.fetchFn(httpBaseFromServiceUrl(cred.serviceUrl) + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cred.secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ms),
    });
    text = await resp.text(); // the signal covers the body too
  } catch (e) {
    if (e && e.name === "TimeoutError") {
      throw new Error("the curator service did not answer within " + ms / 1000 + " s");
    }
    throw e;
  }
  if (!resp.ok) throw new Error(refusalText(resp.status, text));
  return JSON.parse(text);
}

export async function sendNotes(env, m) {
  const body = await postApi(
    env,
    "/api/page_notes",
    { url: m.url, title: m.title, md: m.md, count: m.count },
    SEND_MS,
  );
  return { ok: true, id: body.id };
}

// The offscreen document cannot show the microphone prompt; when the extension has no
// grant yet, a visible extension page asks once, and the grant covers the whole
// extension origin from then on.
export async function voiceStart(env) {
  await env.ensureOffscreen();
  const r = await env.toOffscreen({ type: "start" });
  if (r && r.ok) return { ok: true };
  if (r && r.permission) {
    await env.openPage(MIC_PAGE);
    return {
      ok: false,
      error: "Allow the microphone in the tab that just opened, then press 🎤 again",
    };
  }
  return { ok: false, error: (r && r.error) || "the recorder did not answer" };
}

export async function voiceStop(env) {
  const r = await env.toOffscreen({ type: "stop" });
  await env.closeOffscreen();
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "the recorder did not answer" };
  const body = await postApi(env, "/api/transcribe", { audio: r.audio, mime: r.mime }, TRANSCRIBE_MS);
  return { ok: true, text: body.text };
}

// The popup closed while recording: stop, throw the audio away, close the document — the
// microphone is released with it.
export async function voiceCancel(env) {
  await env.toOffscreen({ type: "stop" });
  await env.closeOffscreen();
  return { ok: true };
}

// One page request -> one answer, always `{ok, ...}`: Tack waits for it.
export async function handleTackPageMessage(env, message) {
  try {
    if (message.type === "tack_send") return await sendNotes(env, message);
    if (message.type === "tack_voice_start") return await voiceStart(env);
    if (message.type === "tack_voice_cancel") return await voiceCancel(env);
    return await voiceStop(env);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// The real chrome bindings. `credential` comes from the worker's connection (the same
// source get_credential reads).
export function chromeTackEnv(chromeApi, credential, fetchFn) {
  return {
    executeScript: (injection) => chromeApi.scripting.executeScript(injection),
    credential,
    fetchFn,
    ensureOffscreen: async () => {
      const open = await chromeApi.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (open.length) return;
      await chromeApi.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA"],
        justification: "Record a voice note for a page comment",
      });
    },
    toOffscreen: (msg) => chromeApi.runtime.sendMessage({ target: OFFSCREEN_TARGET, ...msg }),
    closeOffscreen: () => chromeApi.offscreen.closeDocument(),
    openPage: (path) => chromeApi.tabs.create({ url: chromeApi.runtime.getURL(path) }),
  };
}
