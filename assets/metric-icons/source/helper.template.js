/* Trailbook Metric Icons — original vector artwork; no external dependencies. */
(function (root) {
 'use strict';
 const bodies=Object.freeze(__BODIES__);
 const keys=Object.freeze(Object.keys(bodies));
 const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const resolve=key=>typeof key==='string'&&Object.prototype.hasOwnProperty.call(bodies,key)?key:'other';
 const preset=size=>Number(size)===32?32:20;
 function render(key,options={}){
  const size=preset(options.size),a11y=options.label?`role="img" aria-label="${escape(options.label)}"`:'aria-hidden="true"';
  return `<svg xmlns="http://www.w3.org/2000/svg" class="tb-metric-icon" viewBox="0 0 24 24" fill="none" stroke="none" width="${size}" height="${size}" style="--tb-metric-size:${size}px" focusable="false" ${a11y}>${bodies[resolve(key)]}</svg>`;
 }
 root.TrailbookMetricIcons=Object.freeze({render,resolve,keys,symbolId:key=>'tbm-'+resolve(key),file:(key,size=20)=>preset(size)+'/'+resolve(key)+'.svg'});
})(globalThis);
