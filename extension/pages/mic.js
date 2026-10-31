// Asks for the microphone once, on behalf of the offscreen recorder (§16 item 26): an
// offscreen document cannot show the permission prompt, a visible extension page can, and
// the grant then covers the whole extension origin. The service worker opens this tab when
// 🎤 in Tack finds no grant.
const status = document.getElementById("status");
navigator.mediaDevices.getUserMedia({ audio: true }).then(
  (stream) => {
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = "Microphone allowed. Press 🎤 in Tack again.";
    window.close();
  },
  (e) => {
    status.textContent =
      "The microphone was not allowed (" + e.message + "). Allow it for this extension " +
      "in the address bar, reload this tab, then press 🎤 in Tack again.";
  },
);
