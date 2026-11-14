/* Trailbook B — original SVG artwork, no dependencies or network requests. */
(function (root) {
  'use strict';
  const bodies = Object.freeze(__BODIES__);
  const keys = Object.freeze(Object.keys(bodies));
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function resolve(key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(bodies, key) ? key : 'other';
  }
  function render(key, options = {}) {
    const id = resolve(key);
    const requested = Number(options.size ?? 20);
    const size = Number.isFinite(requested) ? Math.max(8, Math.min(256, requested)) : 20;
    const a11y = options.label ? `role="img" aria-label="${escape(options.label)}"` : 'aria-hidden="true"';
    return `<svg xmlns="http://www.w3.org/2000/svg" class="tb-activity-icon" viewBox="0 0 24 24" fill="none" stroke="none" width="${size}" height="${size}" style="--tb-icon-size:${size}px" focusable="false" ${a11y}>${bodies[id]}</svg>`;
  }
  root.TrailbookIcons = Object.freeze({
    render, resolve, keys,
    symbolId: key => 'tb-' + resolve(key),
    file: key => 'svg/' + resolve(key) + '.svg'
  });
})(globalThis);
