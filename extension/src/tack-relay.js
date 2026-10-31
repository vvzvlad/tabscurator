// Tack relay (§16 item 26). Injected by the service worker into the ISOLATED world of the
// top frame, next to the Tack fork in the page's MAIN world (vendor/tack/tack.js). Tack has
// no extension API there, so it posts its requests on window; this relay forwards Tack's
// own request types to the service worker and posts each answer back under the request id.
//
// The page shares that window, so only the four Tack types pass, each rebuilt into a fixed
// service-worker message: nothing the page posts can name another worker message (such as
// get_credential), and the worker serves this frame tack_* types only (tack-bridge.js).
//
// Injected again on every «Разметить страницу», so a second copy replaces the first
// listener instead of adding one. A copy left behind by a reloaded extension has lost its
// runtime (`chrome.runtime.id` is gone); it unhooks itself and stays silent, so the live
// copy's answer is the one Tack gets.
//
// A recording the page started and has not stopped or cancelled is remembered
// (`window.__tackLive`, on the isolated world's window so a re-injected copy knows it
// too); when the page goes away with one running, the relay cancels it itself — Tack in a
// closing page gets no chance to — so the microphone does not stay on.
(function () {
  var TYPES = {
    send: "tack_send",
    "voice-start": "tack_voice_start",
    "voice-stop": "tack_voice_stop",
    "voice-cancel": "tack_voice_cancel",
  };

  function onMessage(e) {
    var d = e.data;
    if (e.source !== window || !d || typeof d.id !== "string") return;
    if (!Object.prototype.hasOwnProperty.call(TYPES, d.tack)) return;
    if (!chrome.runtime || !chrome.runtime.id) {
      window.removeEventListener("message", onMessage);
      return;
    }
    var msg = { type: TYPES[d.tack] };
    if (d.tack === "send") {
      var p = d.payload || {};
      msg.url = p.url;
      msg.title = p.title;
      msg.md = p.md;
      msg.count = p.count;
    }
    var reply = function (r) {
      window.postMessage({ tackReply: r, id: d.id }, "*");
    };
    if (d.tack === "voice-stop" || d.tack === "voice-cancel") window.__tackLive = false;
    chrome.runtime.sendMessage(msg).then(
      function (r) {
        if (d.tack === "voice-start" && r && r.ok) window.__tackLive = true;
        reply(r || { ok: false, error: "the extension did not answer" });
      },
      function (err) {
        reply({ ok: false, error: String((err && err.message) || err) });
      },
    );
  }

  function onPageHide() {
    if (!window.__tackLive || !chrome.runtime || !chrome.runtime.id) return;
    window.__tackLive = false;
    chrome.runtime.sendMessage({ type: "tack_voice_cancel" }).catch(function () {});
  }

  if (window.__tackRelay) window.removeEventListener("message", window.__tackRelay);
  if (window.__tackRelayHide) window.removeEventListener("pagehide", window.__tackRelayHide);
  window.__tackRelay = onMessage;
  window.__tackRelayHide = onPageHide;
  window.addEventListener("message", onMessage);
  window.addEventListener("pagehide", onPageHide);
})();
