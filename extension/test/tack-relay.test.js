import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// The relay is a classic script injected with `files:`; it runs here in its own global,
// against a window double (message listeners + postMessage log) and a fake runtime.
const SRC = readFileSync(fileURLToPath(new URL("../src/tack-relay.js", import.meta.url)), "utf8");

function fakeWindow() {
  const w = {
    listeners: [], // "message"
    hide: [], // "pagehide"
    posted: [],
    addEventListener(type, fn) {
      if (type === "message") w.listeners.push(fn);
      if (type === "pagehide") w.hide.push(fn);
    },
    removeEventListener(type, fn) {
      if (type === "message") w.listeners = w.listeners.filter((l) => l !== fn);
      if (type === "pagehide") w.hide = w.hide.filter((l) => l !== fn);
    },
    postMessage(data) {
      w.posted.push(data);
    },
  };
  return w;
}

function inject(win, runtime) {
  vm.runInNewContext(SRC, { window: win, chrome: { runtime } });
}

function runtime(answer = { ok: true, id: 7 }) {
  return { id: "ext-id", sendMessage: vi.fn(async () => answer) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
function dispatch(win, data, source = win) {
  for (const l of win.listeners) l({ data, source });
}

describe("tack-relay: what passes from the page to the worker", () => {
  it("forwards a Tack send as a rebuilt tack_send and posts the answer under its id", async () => {
    const win = fakeWindow();
    const rt = runtime({ ok: true, id: 7 });
    inject(win, rt);
    const payload = { url: "http://x/a", title: "A", md: "# n", count: 2, extra: "dropped" };
    dispatch(win, { tack: "send", id: "tack-1", payload });
    await flush();
    expect(rt.sendMessage).toHaveBeenCalledWith({
      type: "tack_send", url: "http://x/a", title: "A", md: "# n", count: 2,
    });
    expect(win.posted).toEqual([{ tackReply: { ok: true, id: 7 }, id: "tack-1" }]);
  });

  it("maps the three voice types and nothing else", async () => {
    const win = fakeWindow();
    const rt = runtime({ ok: true });
    inject(win, rt);
    dispatch(win, { tack: "voice-start", id: "a" });
    dispatch(win, { tack: "voice-stop", id: "b" });
    dispatch(win, { tack: "voice-cancel", id: "b2" });
    // Not Tack's: another worker message, a prototype key, a reply, a request without id.
    dispatch(win, { tack: "get_credential", id: "c" });
    dispatch(win, { type: "get_credential", id: "d" });
    dispatch(win, { tack: "toString", id: "e" });
    dispatch(win, { tackReply: { ok: true }, id: "f" });
    dispatch(win, { tack: "send" });
    await flush();
    expect(rt.sendMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: "tack_voice_start" },
      { type: "tack_voice_stop" },
      { type: "tack_voice_cancel" },
    ]);
  });

  it("ignores a message from another window (an iframe posting up)", async () => {
    const win = fakeWindow();
    const rt = runtime();
    inject(win, rt);
    dispatch(win, { tack: "send", id: "x", payload: {} }, { other: true });
    await flush();
    expect(rt.sendMessage).not.toHaveBeenCalled();
  });

  it("answers a failed worker call with {ok:false, error} so Tack is not left waiting", async () => {
    const win = fakeWindow();
    const rt = { id: "ext-id", sendMessage: vi.fn(async () => { throw new Error("no worker"); }) };
    inject(win, rt);
    dispatch(win, { tack: "voice-start", id: "v" });
    await flush();
    expect(win.posted).toEqual([{ tackReply: { ok: false, error: "no worker" }, id: "v" }]);
  });
});

// Tack in a page that is closing or reloading gets no chance to cancel its recording.
describe("tack-relay: a recording left running when the page goes away", () => {
  const sent = (rt) => rt.sendMessage.mock.calls.map((c) => c[0].type);
  const hide = (win) => win.hide.forEach((l) => l({ persisted: false }));

  it("pagehide after a started recording cancels it in the worker", async () => {
    const win = fakeWindow();
    const rt = runtime({ ok: true });
    inject(win, rt);
    dispatch(win, { tack: "voice-start", id: "a" });
    await flush();
    hide(win);
    expect(sent(rt)).toEqual(["tack_voice_start", "tack_voice_cancel"]);
    hide(win); // a second pagehide (bfcache, then unload) does not cancel twice
    expect(sent(rt)).toEqual(["tack_voice_start", "tack_voice_cancel"]);
  });

  it("nothing is cancelled when no recording runs", async () => {
    const win = fakeWindow();
    const refused = runtime({ ok: false, error: "no mic" });
    inject(win, refused);
    dispatch(win, { tack: "voice-start", id: "a" }); // the start was refused
    await flush();
    hide(win);
    expect(sent(refused)).toEqual(["tack_voice_start"]);

    for (const end of ["voice-stop", "voice-cancel"]) {
      const w = fakeWindow();
      const rt = runtime({ ok: true });
      inject(w, rt);
      dispatch(w, { tack: "voice-start", id: "a" });
      await flush();
      dispatch(w, { tack: end, id: "b" }); // stopped or cancelled by Tack itself
      hide(w);
      await flush();
      expect(sent(rt)).toEqual(["tack_voice_start", end === "voice-stop" ? "tack_voice_stop" : "tack_voice_cancel"]);
    }
  });

  it("a start answered after Tack stopped waiting still counts as running", async () => {
    // Tack gives up on voice-start after 10 s and never sends a cancel; the worker's late
    // {ok:true} still marks the recording, so leaving the page stops it.
    const win = fakeWindow();
    let answer;
    const rt = { id: "ext-id", sendMessage: vi.fn(() => new Promise((r) => (answer = r))) };
    inject(win, rt);
    dispatch(win, { tack: "voice-start", id: "late" });
    answer({ ok: true });
    await flush();
    hide(win);
    expect(sent(rt)).toEqual(["tack_voice_start", "tack_voice_cancel"]);
  });

  it("an orphaned copy does nothing on pagehide", async () => {
    const win = fakeWindow();
    const rt = runtime({ ok: true });
    inject(win, rt);
    dispatch(win, { tack: "voice-start", id: "a" });
    await flush();
    delete rt.id; // the extension was reloaded
    expect(() => hide(win)).not.toThrow();
    expect(sent(rt)).toEqual(["tack_voice_start"]);
  });
});

describe("tack-relay: re-injection", () => {
  it("a second injection replaces the listener instead of adding one", async () => {
    const win = fakeWindow();
    const rt = runtime();
    inject(win, rt);
    inject(win, rt);
    expect(win.listeners).toHaveLength(1);
    dispatch(win, { tack: "voice-stop", id: "s" });
    await flush();
    expect(rt.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("a second injection replaces the pagehide listener and still knows the recording", async () => {
    const win = fakeWindow();
    const rt = runtime({ ok: true });
    inject(win, rt);
    dispatch(win, { tack: "voice-start", id: "a" });
    await flush();
    inject(win, rt);
    expect(win.hide).toHaveLength(1);
    win.hide.forEach((l) => l({}));
    expect(rt.sendMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: "tack_voice_start" },
      { type: "tack_voice_cancel" },
    ]);
  });

  it("a copy whose extension was reloaded unhooks itself and stays silent", async () => {
    const win = fakeWindow();
    const dead = { sendMessage: vi.fn() }; // an orphaned content script: runtime.id is gone
    inject(win, dead);
    dispatch(win, { tack: "send", id: "z", payload: {} });
    await flush();
    expect(dead.sendMessage).not.toHaveBeenCalled();
    expect(win.posted).toEqual([]);
    expect(win.listeners).toHaveLength(0);
  });
});
