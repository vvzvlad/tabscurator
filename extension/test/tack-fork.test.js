import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

// The fork's own behaviour in vendor/tack/tack.js: Send, 🎤 and Save while recording. Tack
// runs in a happy-dom page with `__tack_bridge` set, as the extension injects it; a fake
// relay on that page answers its window.postMessage requests (src/tack-relay.js is tested
// on its own).
//
// happy-dom: the page's script runs in its own global (`window.eval("window")` is not the
// `window` object here), so the fake relay answers from inside it, where `source: window`
// is the global Tack compares against. Tack's shadow root is closed; attachShadow is
// forced open to reach the toolbar and the popup.
const TACK = readFileSync(fileURLToPath(new URL("../vendor/tack/tack.js", import.meta.url)), "utf8");
const NOANSWER = "No answer from the curator extension — press „📌 Разметить страницу“ again";

let open = [];
afterEach(async () => {
  await Promise.all(open.map((w) => w.happyDOM.close()));
  open = [];
});

// answers: Tack request type -> reply object, or "hold" (the test answers through
// `held[type]`); a type left out is never answered (a dead relay). maxTimeout caps every
// timer of the page, Tack's request deadlines included (happy-dom setting).
function page(answers = {}, maxTimeout) {
  const window = new Window({
    url: "http://localhost:5299/page",
    settings: maxTimeout ? { timer: { maxTimeout } } : {},
  });
  open.push(window);
  window.document.body.innerHTML = '<h1>T</h1><div id="a" class="card">Hello</div><div id="b">World</div>';
  let shadow = null;
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (o) {
    shadow = attach.call(this, { ...o, mode: "open" });
    return shadow;
  };
  window.__tack_bridge = true;
  const posted = [];
  const held = {};
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || !d.tack) return;
    posted.push({ type: d.tack, payload: d.payload });
    const reply = (r) => {
      window.__reply = { tackReply: r, id: d.id };
      window.eval("window.dispatchEvent(new MessageEvent('message', { data: window.__reply, source: window }))");
    };
    const a = answers[d.tack];
    if (a === "hold") held[d.tack] = reply;
    else if (a) setTimeout(() => reply(a), 0);
  });
  window.eval(TACK);
  window.__tack.prefs({ seen: 1 }); // no first-run toast over the ones under test
  window.__tack.on();

  const buttons = (root) => [...(root || shadow).querySelectorAll("button")];
  const pop = () => shadow.querySelector(".pop");
  return {
    window,
    posted,
    held,
    types: () => posted.map((p) => p.type),
    send: () => buttons().find((b) => /^Send \(|^Send$/.test(b.textContent)),
    toast: () => (shadow.querySelector(".tst") || {}).textContent || "",
    undo: () => [...shadow.querySelectorAll(".tst a")].find((a) => a.textContent === "Undo"),
    pop,
    mic: () => pop() && buttons(pop()).find((b) => /^(🎤|⏹|…)$/.test(b.textContent)),
    save: () => pop() && buttons(pop()).find((b) => /^Save/.test(b.textContent)),
    close: () => pop() && buttons(pop()).find((b) => b.textContent === "✕"),
    ta: () => pop() && pop().querySelector("textarea"),
    notes: () => window.__tack.list(),
    last: () => JSON.parse(window.localStorage.getItem("tack_last") || "[]"),
  };
}

async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for " + cond);
    await new Promise((r) => setTimeout(r, 2));
  }
}
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("Tack fork: Send", () => {
  it("ok: posts this page's notes, hands them off with Undo, keeps them in tack_last", async () => {
    const p = page({ send: { ok: true, id: 1 } });
    p.window.__tack.add("#a", "make it red");
    p.window.__tack.add("#b", "bigger");
    expect(p.send().textContent).toBe("Send (2)");
    p.send().click();
    await until(() => /Sent to the agent/.test(p.toast()));
    const [req] = p.posted;
    expect(req.type).toBe("send");
    expect(req.payload).toMatchObject({ url: "http://localhost:5299/page", count: 2 });
    expect(req.payload.md).toContain("make it red");
    expect(req.payload.md).toContain("bigger");
    expect(p.toast()).toMatch(/^Sent to the agent 2 · removed from list/);
    expect(p.notes()).toHaveLength(0);
    expect(p.last().map((n) => n.note)).toEqual(["make it red", "bigger"]);
    p.undo().click();
    expect(p.notes().map((n) => n.note)).toEqual(["make it red", "bigger"]);
  });

  it("Send is disabled while one is in flight, so a second click sends nothing", async () => {
    const p = page({ send: "hold" });
    p.window.__tack.add("#a", "make it red");
    p.send().click();
    await until(() => p.held.send);
    expect(p.send().disabled).toBe(true);
    p.send().click();
    await tick();
    expect(p.types()).toEqual(["send"]);
    p.held.send({ ok: false, error: "HTTP 503: degraded" });
    await until(() => !p.send().disabled);
    expect(p.types()).toEqual(["send"]);
  });

  it("refusal: the notes stay, the server's sentence is shown, Send works again", async () => {
    const p = page({ send: { ok: false, error: "HTTP 423: stopped" } });
    p.window.__tack.add("#a", "make it red");
    p.send().click();
    await until(() => /Not sent/.test(p.toast()));
    expect(p.toast()).toBe("Not sent, notes kept: HTTP 423: stopped");
    expect(p.notes()).toHaveLength(1);
    expect(p.last()).toEqual([]);
    expect(p.send().disabled).toBe(false);
  });

  it("no answer (a dead relay): times out, keeps the notes, says to press the button again", async () => {
    const p = page({}, 100); // Tack's 10 s deadline, capped to 100 ms
    p.window.__tack.add("#a", "make it red");
    p.send().click();
    expect(p.send().disabled).toBe(true);
    await until(() => p.toast() === NOANSWER);
    expect(p.notes()).toHaveLength(1);
    expect(p.send().disabled).toBe(false);
  });
});

describe("Tack fork: 🎤 in the note popup", () => {
  it("start, then stop: the transcript is appended to what was typed", async () => {
    const p = page({ "voice-start": "hold", "voice-stop": "hold" });
    p.window.__tack.open("#a");
    p.ta().value = "typed";
    p.mic().click();
    await until(() => p.held["voice-start"]);
    expect(p.mic().disabled).toBe(true); // no second start while the first is in flight
    p.mic().click();
    p.held["voice-start"]({ ok: true });
    await until(() => p.mic().textContent === "⏹");
    expect(p.mic().disabled).toBe(false);
    p.mic().click();
    await until(() => p.held["voice-stop"]);
    expect([p.mic().textContent, p.mic().disabled]).toEqual(["…", true]);
    p.held["voice-stop"]({ ok: true, text: "make it bigger" });
    await until(() => p.mic().textContent === "🎤");
    expect(p.ta().value).toBe("typed make it bigger");
    expect(p.mic().disabled).toBe(false);
    expect(p.types()).toEqual(["voice-start", "voice-stop"]);
  });

  it("a refused start re-enables 🎤 and shows why", async () => {
    const p = page({ "voice-start": { ok: false, error: "Allow the microphone in the tab that just opened, then press 🎤 again" } });
    p.window.__tack.open("#a");
    p.mic().click();
    await until(() => /Allow the microphone/.test(p.toast()));
    expect([p.mic().textContent, p.mic().disabled]).toEqual(["🎤", false]);
  });

  it("a start nobody answers times out and re-enables 🎤", async () => {
    const p = page({}, 100);
    p.window.__tack.open("#a");
    p.mic().click();
    expect(p.mic().disabled).toBe(true);
    await until(() => p.toast() === NOANSWER);
    expect([p.mic().textContent, p.mic().disabled]).toEqual(["🎤", false]);
  });

  it("a popup closed while the start is pending cancels the recording once it starts", async () => {
    const p = page({ "voice-start": "hold", "voice-cancel": { ok: true } });
    p.window.__tack.open("#a");
    p.mic().click();
    await until(() => p.held["voice-start"]);
    p.close().click();
    expect(p.types()).toEqual(["voice-start"]); // nothing to cancel yet
    p.held["voice-start"]({ ok: true });
    await until(() => p.types().length === 2);
    expect(p.types()).toEqual(["voice-start", "voice-cancel"]);
  });

  it("closing the popup while recording cancels the recording (✕ and Esc)", async () => {
    for (const how of ["x", "esc"]) {
      const p = page({ "voice-start": { ok: true }, "voice-cancel": { ok: true } });
      p.window.__tack.open("#a");
      p.mic().click();
      await until(() => p.mic().textContent === "⏹");
      if (how === "x") p.close().click();
      else p.ta().dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(p.pop()).toBeNull();
      await until(() => p.types().length === 2);
      expect(p.types()).toEqual(["voice-start", "voice-cancel"]);
    }
  });
});

describe("Tack fork: Save while recording", () => {
  async function recording(answers) {
    const p = page({ "voice-start": { ok: true }, "voice-stop": "hold", ...answers });
    p.window.__tack.open("#a");
    p.mic().click();
    await until(() => p.mic().textContent === "⏹");
    p.ta().value = "typed";
    return p;
  }

  it("Save stops the recording, waits for the transcript and saves the note with it", async () => {
    const p = await recording();
    p.save().click();
    await until(() => p.held["voice-stop"]);
    expect(p.pop()).not.toBeNull(); // still open while transcribing
    expect(p.save().disabled).toBe(true);
    p.held["voice-stop"]({ ok: true, text: "make it bigger" });
    await until(() => !p.pop());
    expect(p.notes().map((n) => n.note)).toEqual(["typed make it bigger"]);
    expect(p.types()).toEqual(["voice-start", "voice-stop"]); // stopped, not cancelled
  });

  it("⌘↵ does the same", async () => {
    const p = await recording();
    p.ta().dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    await until(() => p.held["voice-stop"]);
    p.held["voice-stop"]({ ok: true, text: "make it bigger" });
    await until(() => !p.pop());
    expect(p.notes().map((n) => n.note)).toEqual(["typed make it bigger"]);
  });

  it("a popup closed (Esc) during the transcription Save started is not saved", async () => {
    const p = await recording();
    p.save().click();
    await until(() => p.held["voice-stop"]);
    p.ta().dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(p.pop()).toBeNull();
    p.held["voice-stop"]({ ok: true, text: "spoken" });
    await tick();
    await tick();
    expect(p.notes()).toEqual([]);
    expect(p.types()).toEqual(["voice-start", "voice-stop"]);
  });

  it("a failed transcription: toast, the popup stays open with what was typed, nothing saved", async () => {
    const p = await recording();
    p.save().click();
    await until(() => p.held["voice-stop"]);
    p.held["voice-stop"]({ ok: false, error: "HTTP 502: Groq 401: invalid key" });
    await until(() => /Voice note failed/.test(p.toast()));
    expect(p.toast()).toBe("Voice note failed: HTTP 502: Groq 401: invalid key");
    expect(p.pop()).not.toBeNull();
    expect(p.ta().value).toBe("typed");
    expect(p.save().disabled).toBe(false);
    expect([p.mic().textContent, p.mic().disabled]).toEqual(["🎤", false]);
    expect(p.notes()).toEqual([]);
  });
});
