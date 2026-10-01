// What to add to WordPress so each form sends where the visitor came from.

// Contact Form 7 hidden fields; the tracking snippet fills them in.
export const TRACKING_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
  "landing_page",
  "referrer",
]

export const CF7_HIDDEN_FIELDS = TRACKING_FIELDS.map((name) => `[hidden ${name}]`).join("\n")

// Remembers the UTM tags and ad click id from the address the visitor arrived on (the latest
// visit with tags wins), plus the landing page and referring site, and puts them into any form
// field with the same name, including after Contact Form 7 resets the form.
export const TRACKING_SNIPPET = `<script>
(function () {
  var KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "gbraid", "wbraid", "fbclid", "msclkid"];
  var STORE = "thb_lead_tracking";
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || "{}"); } catch (e) {}
  var params = new URLSearchParams(location.search), fresh = {};
  KEYS.forEach(function (k) { var v = params.get(k); if (v) fresh[k] = v; });
  if (fresh.gbraid || fresh.wbraid) fresh.gclid = fresh.gclid || fresh.gbraid || fresh.wbraid;
  var external = document.referrer && document.referrer.indexOf(location.hostname) === -1;
  if (Object.keys(fresh).length || !saved.landing_page) {
    saved = Object.keys(fresh).length ? fresh : saved;
    saved.landing_page = location.href;
    saved.referrer = external ? document.referrer : (saved.referrer || "");
    try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch (e) {}
  }
  function fill() {
    Object.keys(saved).forEach(function (k) {
      document.querySelectorAll('input[name="' + k + '"]').forEach(function (input) {
        if (!input.value) input.value = saved[k];
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fill); else fill();
  document.addEventListener("wpcf7mailsent", function () { setTimeout(fill, 0); });
  document.addEventListener("wpcf7submit", function () { setTimeout(fill, 0); });
})();
</script>`
