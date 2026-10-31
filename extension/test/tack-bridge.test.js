import { describe, it, expect, vi } from "vitest";
import {
  activateTack,
  handleTackPageMessage,
  isContentScript,
  refusalText,
  tackBridgeOn,
} from "../src/tack-bridge.js";
import { base64, createRecorder } from "../pages/offscreen.js";

const CRED = { serviceUrl: "wss://curator.example/", secret: "raw-secret" };

function resp(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function env(over = {}) {
  return {
    executeScript: vi.fn(async () => [{ result: false }]),
    credential: async () => CRED,
    fetchFn: vi.fn(async () => resp(201, { id: 5 })),
    ensureOffscreen: vi.fn(async () => {}),
    toOffscreen: vi.fn(async () => ({ ok: true })),
    closeOffscreen: vi.fn(async () => {}),
    openPage: vi.fn(async () => {}),
    ...over,
  };
}

describe("isContentScript: who may send tack_* page requests", () => {
  const base = "chrome-extension://abc/";
  it("a website frame is one; the startpage tab and the popup are not", () => {
    expect(isContentScript({ tab: { id: 1 }, url: "http://localhost:5299/" }, base)).toBe(true);
    expect(isContentScript({ tab: { id: 1 }, url: base + "startpage/index.html" }, base)).toBe(false);
    expect(isContentScript({ url: base + "pages/popup.html" }, base)).toBe(false);
  });
});

describe("activateTack", () => {
  it("first time: flag, Tack + resolver in MAIN, relay in ISOLATED, then switch it on", async () => {
    const e = env({
      executeScript: vi
        .fn()
        .mockResolvedValueOnce([{ result: false }]) // no Tack on the page yet
        .mockResolvedValue([{ result: true }]),
    });
    expect(await activateTack(e, 42)).toEqual({ ok: true });
    const calls = e.executeScript.mock.calls.map(([inj]) => ({
      world: inj.world,
      what: inj.files || inj.func.name,
      tabId: inj.target.tabId,
    }));
    expect(calls).toEqual([
      { world: "MAIN", what: "tackBridgeOn", tabId: 42 },
      { world: "MAIN", what: ["vendor/tack/tack-src.js", "vendor/tack/tack.js"], tabId: 42 },
      { world: "ISOLATED", what: ["src/tack-relay.js"], tabId: 42 },
      { world: "MAIN", what: "tackBridgeOn", tabId: 42 },
    ]);
  });

  it("Tack already there: switched back on, not loaded twice — the relay is renewed", async () => {
    const e = env({ executeScript: vi.fn(async () => [{ result: true }]) });
    await activateTack(e, 7);
    const files = e.executeScript.mock.calls.map(([inj]) => inj.files).filter(Boolean);
    expect(files).toEqual([["src/tack-relay.js"]]);
  });

  it("tackBridgeOn sets the flag Tack reads and calls __tack.on() when Tack is present", () => {
    const on = vi.fn();
    globalThis.window = {};
    try {
      expect(tackBridgeOn()).toBe(false);
      expect(window.__tack_bridge).toBe(true);
      window.__tack = { on };
      expect(tackBridgeOn()).toBe(true);
      expect(on).toHaveBeenCalledTimes(1);
    } finally {
      delete globalThis.window;
    }
  });
});

describe("tack_send -> POST /api/page_notes", () => {
  it("posts {url,title,md,count} with the instance Bearer and answers the new id", async () => {
    const e = env();
    const msg = { type: "tack_send", url: "http://x/", title: "X", md: "# Tack", count: 3 };
    expect(await handleTackPageMessage(e, msg)).toEqual({ ok: true, id: 5 });
    const [url, opts] = e.fetchFn.mock.calls[0];
    expect(url).toBe("https://curator.example/api/page_notes");
    expect(opts.headers.Authorization).toBe("Bearer raw-secret");
    expect(JSON.parse(opts.body)).toEqual({ url: "http://x/", title: "X", md: "# Tack", count: 3 });
  });

  it("a refusal comes back as the server's sentence, so Tack keeps the notes and says why", async () => {
    const plain = env({ fetchFn: async () => resp(400, "url must be a non-empty string") });
    expect(await handleTackPageMessage(plain, { type: "tack_send" })).toEqual({
      ok: false,
      error: "HTTP 400: url must be a non-empty string",
    });
    const stopped = env({ fetchFn: async () => resp(423, { error: "stopped", since: 1 }) });
    expect((await handleTackPageMessage(stopped, { type: "tack_send" })).error).toBe("HTTP 423: stopped");
  });

  it("an unenrolled browser is told so instead of posting without a credential", async () => {
    const e = env({ credential: async () => ({ serviceUrl: null, secret: null }) });
    const r = await handleTackPageMessage(e, { type: "tack_send" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not enrolled/);
    expect(e.fetchFn).not.toHaveBeenCalled();
  });
});

// Tack stops waiting after 10 s (send) and 90 s (voice stop); the worker's fetch is cut
// before that, so Tack gets an answer instead of a timeout while the fetch runs on.
describe("service calls are cut before Tack stops waiting", () => {
  const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

  it("each call carries an AbortSignal: 8 s for page_notes, 85 s for transcribe", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const send = env();
      await handleTackPageMessage(send, { type: "tack_send" });
      expect(send.fetchFn.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(timeout).toHaveBeenLastCalledWith(8000);
      const voice = env({
        toOffscreen: async () => ({ ok: true, audio: "AA==", mime: "audio/webm" }),
        fetchFn: vi.fn(async () => resp(200, { text: "x" })),
      });
      await handleTackPageMessage(voice, { type: "tack_voice_stop" });
      expect(voice.fetchFn.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(timeout).toHaveBeenLastCalledWith(85000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("a timed-out call answers {ok:false} saying the service did not answer in time", async () => {
    const send = env({ fetchFn: async () => { throw timeoutError(); } });
    expect(await handleTackPageMessage(send, { type: "tack_send" })).toEqual({
      ok: false,
      error: "the curator service did not answer within 8 s",
    });
    // The signal also covers reading the body.
    const voice = env({
      toOffscreen: async () => ({ ok: true, audio: "AA==", mime: "audio/webm" }),
      fetchFn: async () => ({ ok: true, status: 200, text: async () => { throw timeoutError(); } }),
    });
    expect(await handleTackPageMessage(voice, { type: "tack_voice_stop" })).toEqual({
      ok: false,
      error: "the curator service did not answer within 85 s",
    });
  });

  it("a real AbortSignal.timeout firing is mapped the same way", async () => {
    // fetch rejects with the signal's reason, a DOMException named TimeoutError.
    const hang = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason)));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("timed out", "TimeoutError")), 0);
      return c.signal;
    });
    try {
      const r = await handleTackPageMessage(env({ fetchFn: hang }), { type: "tack_send" });
      expect(r).toEqual({ ok: false, error: "the curator service did not answer within 8 s" });
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("voice: offscreen recorder -> POST /api/transcribe", () => {
  it("start opens the recorder document and starts recording", async () => {
    const e = env();
    expect(await handleTackPageMessage(e, { type: "tack_voice_start" })).toEqual({ ok: true });
    expect(e.ensureOffscreen).toHaveBeenCalled();
    expect(e.toOffscreen).toHaveBeenCalledWith({ type: "start" });
  });

  it("no microphone grant: opens the asking page and tells the human to press 🎤 again", async () => {
    const e = env({ toOffscreen: vi.fn(async () => ({ ok: false, permission: true })) });
    const r = await handleTackPageMessage(e, { type: "tack_voice_start" });
    expect(e.openPage).toHaveBeenCalledWith("pages/mic.html");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/press 🎤 again/) });
  });

  it("stop closes the document, posts the audio, answers the text", async () => {
    const e = env({
      toOffscreen: vi.fn(async () => ({ ok: true, audio: "AAEC", mime: "audio/webm;codecs=opus" })),
      fetchFn: vi.fn(async () => resp(200, { text: "make it bigger" })),
    });
    expect(await handleTackPageMessage(e, { type: "tack_voice_stop" })).toEqual({
      ok: true,
      text: "make it bigger",
    });
    expect(e.closeOffscreen).toHaveBeenCalled();
    const [url, opts] = e.fetchFn.mock.calls[0];
    expect(url).toBe("https://curator.example/api/transcribe");
    expect(JSON.parse(opts.body)).toEqual({ audio: "AAEC", mime: "audio/webm;codecs=opus" });
  });

  it("cancel (the popup closed mid-recording) stops, drops the audio, closes the document", async () => {
    const e = env({ toOffscreen: vi.fn(async () => ({ ok: true, audio: "AAEC", mime: "audio/webm" })) });
    expect(await handleTackPageMessage(e, { type: "tack_voice_cancel" })).toEqual({ ok: true });
    expect(e.toOffscreen).toHaveBeenCalledWith({ type: "stop" });
    expect(e.closeOffscreen).toHaveBeenCalled();
    expect(e.fetchFn).not.toHaveBeenCalled(); // nothing is transcribed
  });

  it("a transcriber failure surfaces its message", async () => {
    const e = env({
      toOffscreen: async () => ({ ok: true, audio: "AA==", mime: "audio/webm" }),
      fetchFn: async () =>
        resp(502, { ok: false, error: "transcribe_failed", message: "Groq 401: invalid key" }),
    });
    expect((await handleTackPageMessage(e, { type: "tack_voice_stop" })).error).toBe(
      "HTTP 502: Groq 401: invalid key",
    );
  });

  it("refusalText falls back to the bare status on an empty body", () => {
    expect(refusalText(503, "")).toBe("HTTP 503");
  });
});

describe("offscreen recorder (pages/offscreen.js)", () => {
  function fakeMedia() {
    const tracks = [{ stop: vi.fn() }];
    const stream = { getTracks: () => tracks };
    class FakeRecorder {
      constructor(s) {
        this.stream = s;
        this.mimeType = "audio/webm;codecs=opus";
        FakeRecorder.last = this;
      }
      start() {
        this.state = "recording";
      }
      stop() {
        // The spec order: the last chunk, then the stop event — to whatever handler is set.
        this.state = "inactive";
        if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array([1, 2, 3])]) });
        if (this.onstop) this.onstop();
      }
    }
    return { tracks, stream, FakeRecorder };
  }

  it("records, then stop hands back pure base64 (no data: prefix) and the recorder's mime", async () => {
    const m = fakeMedia();
    const rec = createRecorder({
      permissionState: async () => "granted",
      getUserMedia: vi.fn(async () => m.stream),
      MediaRecorder: m.FakeRecorder,
    });
    expect(await rec.start()).toEqual({ ok: true });
    expect(await rec.stop()).toEqual({ ok: true, audio: "AQID", mime: "audio/webm;codecs=opus" });
    expect(m.tracks[0].stop).toHaveBeenCalled(); // the microphone is released
    expect(await rec.stop()).toEqual({ ok: false, error: "nothing is being recorded" });
  });

  it("a start over a recording nobody stopped drops it and records afresh", async () => {
    // The tab closed mid-recording, or Tack gave up waiting for the start answer.
    const first = fakeMedia();
    const second = fakeMedia();
    const streams = [first.stream, second.stream];
    const rec = createRecorder({
      permissionState: async () => "granted",
      getUserMedia: vi.fn(async () => streams.shift()),
      MediaRecorder: first.FakeRecorder,
    });
    await rec.start();
    // Audio of the abandoned note, already delivered.
    first.FakeRecorder.last.ondataavailable({ data: new Blob([new Uint8Array([9, 9, 9])]) });
    expect(await rec.start()).toEqual({ ok: true });
    expect(first.tracks[0].stop).toHaveBeenCalled(); // the old microphone is released
    expect(second.tracks[0].stop).not.toHaveBeenCalled();
    // Only the new recording's [1, 2, 3]: neither the 9s nor the old recorder's last chunk.
    expect(await rec.stop()).toEqual({ ok: true, audio: "AQID", mime: "audio/webm;codecs=opus" });
  });

  it("without a grant it does not call getUserMedia (an offscreen document cannot prompt)", async () => {
    const getUserMedia = vi.fn();
    const rec = createRecorder({ permissionState: async () => "prompt", getUserMedia, MediaRecorder: null });
    expect(await rec.start()).toEqual({ ok: false, permission: true });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("base64 of a buffer longer than one chunk matches Node's encoder", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i * 7);
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
