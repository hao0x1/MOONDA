// helpers shared by shot programs (run inside the MOONDA page)
export const installCam = page => page.evaluate(() => {
  const v = window.__viewer, C3 = v.camera.position.constructor, ell = v.scene.globe.ellipsoid, r = d => d * Math.PI / 180;
  window.__cam = {
    set(lon, lat, h, heading = 0, pitch = -90, roll = 0) {
      v.camera.setView({ destination: C3.fromDegrees(lon, lat, h, ell), orientation: { heading: r(heading), pitch: r(pitch), roll: r(roll) } });
      v.scene.requestRender();
    },
    get() { const c = ell.cartesianToCartographic(v.camera.positionWC); return { lon: c.longitude * 180 / Math.PI, lat: c.latitude * 180 / Math.PI, h: c.height, heading: v.camera.heading * 180 / Math.PI, pitch: v.camera.pitch * 180 / Math.PI }; },
  };
});
export const cam = (page, ...a) => page.evaluate((a) => window.__cam.set(...a), a);
export const camGet = page => page.evaluate(() => window.__cam.get());
// hide the app's buttons and panels (keeps the Moon, the sky and the names)
export const cleanUI = (page, on = true) => page.evaluate(on => {
  let s = document.getElementById('__clean');
  if (!s) { s = document.createElement('style'); s.id = '__clean'; document.head.appendChild(s); }
  s.textContent = on ? '.app > *:not(:first-child){visibility:hidden!important} #__demo_cursor{opacity:0!important}' : '';
}, on);
export const setTime = (page, ms) => page.evaluate(ms => window.__moondaTest.setTime(ms), ms);
export const T0 = Date.UTC(2026, 10, 18, 2, 0);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = t => t * t * (3 - 2 * t);
export const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
