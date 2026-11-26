// Trailbook dashboard card for Home Assistant (SPEC §12b).
//
//   type: custom:trailbook-card
//   card: heatmap        # the id of a card made in Trailbook › Home Assistant › Cards
//
// The card asks Home Assistant for an Ingress session (as the add-on's own panel does; admin
// users only), finds the Trailbook add-on and shows the card's page (#/embed/<id>) in a frame.
// How the card looks and what it shows is set in Trailbook, not here.

const SESSION_COOKIE = "ingress_session";
const VALIDATE_MS = 60000;
const PHONE_W = 420; // Activity detailed: laid out as on a phone
const MAX_SCALE = 1.6;

const RENEW_TRIES = 3; // a frame refused (401) is loaded again with a checked session

// One session and one add-on lookup for every Trailbook card on the page.
let session = null;
let sessionCheck = null; // one check at a time
let addonPromise = null;
let lastHass = null;
const shown = new Set(); // the cards on the page

function setCookie(session) {
  const secure = location.protocol === "https:" ? ";Secure" : "";
  document.cookie = `${SESSION_COOKIE}=${session};path=/api/hassio_ingress/;SameSite=Strict${secure}`;
}

// Puts a session Home Assistant still takes in the cookie, before every load of a card: Home
// Assistant drops a session not checked for 15 minutes (a sleeping tab or phone), and the
// add-on's own panel or another add-on may have put theirs in the cookie since.
function ensureSession(hass) {
  sessionCheck ??= (async () => {
    if (session) {
      try {
        await hass.callWS({ type: "supervisor/api", endpoint: "/ingress/validate_session", method: "post", data: { session } });
      } catch (e) {
        session = null;
      }
    }
    session ??= (await hass.callWS({ type: "supervisor/api", endpoint: "/ingress/session", method: "post" })).session;
    setCookie(session);
  })().finally(() => { sessionCheck = null; });
  return sessionCheck;
}

// While cards are on the page the session is kept alive, and checked as soon as the page shows
// again after sleeping.
function keepSession() {
  if (shown.size && lastHass) ensureSession(lastHass).catch(() => {});
}
setInterval(keepSession, VALIDATE_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) keepSession(); });

function findAddon(hass) {
  addonPromise ??= (async () => {
    const list = await hass.callWS({ type: "supervisor/api", endpoint: "/addons", method: "get" });
    const addon = (list.addons || []).find((a) => a.slug === "trailbook" || a.slug.endsWith("_trailbook"));
    if (!addon) throw new Error("The Trailbook app is not installed.");
    const info = await hass.callWS({ type: "supervisor/api", endpoint: `/addons/${addon.slug}/info`, method: "get" });
    if (!info.ingress_url) throw new Error("Trailbook is not running.");
    return info.ingress_url.endsWith("/") ? info.ingress_url : info.ingress_url + "/";
  })();
  addonPromise.catch(() => { addonPromise = null; });
  return addonPromise;
}

class TrailbookCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.card) throw new Error("Set `card:` to the id of a card made in Trailbook (Home Assistant › Cards).");
    this._config = config;
    if (this._frame) this._load();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = lastHass = hass;
    if (first) this._build();
  }

  connectedCallback() {
    shown.add(this);
    if (this._away) { this._away = false; this._load(); }
  }

  // A card taken off the page (another view, a closed window) loads again when it is back:
  // putting a frame back reloads it, and that must not happen with an old session.
  disconnectedCallback() {
    shown.delete(this);
    if (this._frame) { this._away = true; this._frame.removeAttribute("src"); }
  }

  getCardSize() { return Math.ceil((this._height || 300) / 50); }

  getGridOptions() { return { columns: 12, min_columns: 3, min_rows: 2 }; }

  static getStubConfig() { return { card: "" }; }

  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
        :host { display: block; height: 100%; }
        ha-card { height: 100%; overflow: hidden auto; display: flex; flex-direction: column; scrollbar-width: none; }
        ha-card::-webkit-scrollbar { display: none; }
        iframe { border: 0; width: 100%; flex: 1 0 auto; display: block; background: transparent; }
        .msg { padding: 16px; color: var(--secondary-text-color); font-size: 14px; }
      </style><ha-card><div class="msg">Loading…</div><iframe hidden title="Trailbook"></iframe></ha-card>`;
    this._msg = root.querySelector(".msg");
    this._frame = root.querySelector("iframe");
    // Ingress answers "401: Unauthorized" in place of the page when it refuses the session.
    this._frame.addEventListener("load", () => {
      let text = "";
      try { text = this._frame.contentDocument?.body?.textContent || ""; } catch (e) { return; }
      if (text.trim().startsWith("401")) this._renew();
    });
    // The card's page tells its height (all but the map, which fills the card), and when one of
    // its requests was refused ("auth").
    window.addEventListener("message", (e) => {
      if (e.source !== this._frame.contentWindow) return;
      if (e.data?.trailbook === "auth") { this._renew(); return; }
      if (e.data?.trailbook !== "size") return;
      if (Date.now() - (this._renewed || 0) > VALIDATE_MS) this._tries = 0;
      this._height = e.data.height;
      this._phone = !!e.data.phone;
      if (e.data.fill) { this._frame.style.height = ""; this._frame.style.minHeight = `${e.data.height}px`; }
      else { this._frame.style.minHeight = ""; this._frame.style.height = `${e.data.height}px`; }
      this._fit();
    });
    new ResizeObserver(() => this._fit()).observe(this);
    this._load();
  }

  // The frame once more with a checked session (a new one from the second try on); a few tries
  // a minute at most.
  async _renew() {
    if (this._renewing) return;
    if (Date.now() - (this._renewed || 0) > VALIDATE_MS) this._tries = 0;
    if (this._tries >= RENEW_TRIES) return;
    this._renewing = true;
    this._tries += 1;
    this._renewed = Date.now();
    try {
      if (this._tries > 1) session = null;
      await ensureSession(this._hass);
      this._frame.contentWindow?.location.reload();
    } catch (e) { /* the next load of the card tries again */ }
    this._renewing = false;
  }

  // Activity detailed: its page is laid out phone-wide (PHONE_W) and zoomed to a wider card
  // (zoom, not a transform: the frame takes its zoomed size, so nothing is cut off). A card
  // given a fixed height in the dashboard scrolls inside, without a scroll bar.
  _fit() {
    const f = this._frame, w = this.clientWidth;
    const scale = this._phone && w > PHONE_W + 40 ? Math.min(w / PHONE_W, MAX_SCALE) : 1;
    f.style.width = scale > 1 ? `${PHONE_W}px` : "";
    f.style.zoom = scale > 1 ? String(scale) : "";
    f.style.marginLeft = scale > 1 ? `${(w - PHONE_W * scale) / 2 / scale}px` : "";
  }

  async _load() {
    try {
      const [base] = await Promise.all([findAddon(this._hass), ensureSession(this._hass)]);
      this._frame.src = `${base}#/embed/${encodeURIComponent(this._config.card)}`;
      this._frame.hidden = false;
      this._msg.hidden = true;
    } catch (e) {
      const admin = this._hass.user && !this._hass.user.is_admin;
      this._msg.textContent = admin ? "Trailbook cards are shown to administrators only." : `Trailbook: ${e.message || e}`;
      this._msg.hidden = false;
      this._frame.hidden = true;
    }
  }
}

if (!customElements.get("trailbook-card")) customElements.define("trailbook-card", TrailbookCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "trailbook-card")) {
  window.customCards.push({ type: "trailbook-card", name: "Trailbook", description: "A card made in Trailbook › Home Assistant › Cards." });
}
