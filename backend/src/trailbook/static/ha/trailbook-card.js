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

// One session and one add-on lookup for every Trailbook card on the page.
let sessionPromise = null;
let addonPromise = null;
let validateTimer = null;

function setCookie(session) {
  const secure = location.protocol === "https:" ? ";Secure" : "";
  document.cookie = `${SESSION_COOKIE}=${session};path=/api/hassio_ingress/;SameSite=Strict${secure}`;
}

async function newSession(hass) {
  const res = await hass.callWS({ type: "supervisor/api", endpoint: "/ingress/session", method: "post" });
  setCookie(res.session);
  return res.session;
}

function ensureSession(hass) {
  if (!sessionPromise) {
    sessionPromise = newSession(hass);
    clearInterval(validateTimer);
    validateTimer = setInterval(async () => {
      try {
        const session = await sessionPromise;
        await hass.callWS({ type: "supervisor/api", endpoint: "/ingress/validate_session", method: "post", data: { session } });
      } catch (e) {
        sessionPromise = newSession(hass).catch(() => null);
      }
    }, VALIDATE_MS);
  }
  return sessionPromise;
}

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
    this._hass = hass;
    if (first) this._build();
  }

  getCardSize() { return Math.ceil((this._height || 300) / 50); }

  getGridOptions() { return { columns: 12, min_columns: 3, min_rows: 2 }; }

  static getStubConfig() { return { card: "" }; }

  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
        :host { display: block; height: 100%; }
        ha-card { height: 100%; overflow: hidden auto; display: flex; flex-direction: column; }
        iframe { border: 0; width: 100%; flex: 1 0 auto; display: block; background: transparent; }
        .msg { padding: 16px; color: var(--secondary-text-color); font-size: 14px; }
      </style><ha-card><div class="msg">Loading…</div><iframe hidden title="Trailbook"></iframe></ha-card>`;
    this._msg = root.querySelector(".msg");
    this._frame = root.querySelector("iframe");
    // The card's page tells its height (all but the map, which fills the card).
    window.addEventListener("message", (e) => {
      if (e.source !== this._frame.contentWindow || e.data?.trailbook !== "size") return;
      this._height = e.data.height;
      this._phone = !!e.data.phone;
      if (e.data.fill) { this._frame.style.height = ""; this._frame.style.minHeight = `${e.data.height}px`; }
      else { this._frame.style.minHeight = ""; this._frame.style.height = `${e.data.height}px`; }
      this._fit();
    });
    new ResizeObserver(() => this._fit()).observe(this);
    this._load();
  }

  // Activity detailed: its page is laid out phone-wide (PHONE_W) and zoomed to a wider card
  // (zoom, not a transform: the frame takes its zoomed size, so nothing is cut off). A card
  // given a fixed height in the dashboard scrolls inside.
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
