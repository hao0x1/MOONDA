// Injected into the MOONDA page before its own scripts. Until __vt.freeze() is called nothing changes.
// After freeze, the page's clock only moves when the recorder calls __vt.step(ms): requestAnimationFrame
// callbacks, performance.now(), event time stamps, CSS transitions/animations (and, if asked, timers)
// all follow that virtual clock, so every recorded frame is exactly 1/60 s after the previous one.
(() => {
  const realNow = performance.now.bind(performance);
  const realRAF = window.requestAnimationFrame.bind(window);
  const realCAF = window.cancelAnimationFrame.bind(window);
  const realST = window.setTimeout.bind(window), realCT = window.clearTimeout.bind(window);
  const realSI = window.setInterval.bind(window), realCI = window.clearInterval.bind(window);
  const vt = {
    on: false, now: 0, offset: 0, raf: new Map(), nextId: 1e9, anims: new Map(), timersOn: false, timers: new Map(), nextT: 2e9,
    freeze(opts = {}) {
      if (this.on) return;
      this.now = realNow(); this.on = true; this.timersOn = !!opts.timers;
    },
    step(ms) {
      this.now += ms;
      // CSS transitions / animations / Web Animations: hold them and move them by the same amount
      for (const a of document.getAnimations()) {
        let ct = this.anims.get(a);
        if (ct === undefined) { ct = typeof a.currentTime === 'number' ? a.currentTime : 0; a.pause(); }
        ct += ms;
        let end = Infinity;
        try { end = a.effect ? a.effect.getComputedTiming().endTime : Infinity; } catch { /* keep */ }
        if (ct >= end && Number.isFinite(end)) { this.anims.delete(a); try { a.finish(); } catch { a.currentTime = end; } }
        else { this.anims.set(a, ct); a.currentTime = ct; }
      }
      // timers due by now
      if (this.timersOn) {
        const due = [...this.timers.entries()].filter(([, t]) => t.at <= this.now).sort((a, b) => a[1].at - b[1].at);
        for (const [id, t] of due) {
          if (!this.timers.has(id)) continue;
          if (t.every) t.at += Math.max(1, t.every); else this.timers.delete(id);
          try { t.fn(...t.args); } catch (e) { console.error(e); }
        }
      }
      const q = [...this.raf.entries()]; this.raf.clear();
      for (const [, cb] of q) { try { cb(this.now); } catch (e) { console.error(e); } }
      return q.length;
    },
  };
  window.__vt = vt;
  performance.now = () => (vt.on ? vt.now : realNow());
  window.requestAnimationFrame = cb => { if (!vt.on) return realRAF(cb); const id = vt.nextId++; vt.raf.set(id, cb); return id; };
  window.cancelAnimationFrame = id => { if (id >= 1e9) vt.raf.delete(id); else realCAF(id); };
  window.setTimeout = (fn, ms = 0, ...args) => {
    if (!vt.on || !vt.timersOn || typeof fn !== 'function') return realST(fn, ms, ...args);
    const id = vt.nextT++; vt.timers.set(id, { at: vt.now + (+ms || 0), fn, args }); return id;
  };
  window.clearTimeout = id => { if (id >= 2e9) vt.timers.delete(id); else realCT(id); };
  window.setInterval = (fn, ms = 0, ...args) => {
    if (!vt.on || !vt.timersOn || typeof fn !== 'function') return realSI(fn, ms, ...args);
    const id = vt.nextT++; vt.timers.set(id, { at: vt.now + (+ms || 0), every: +ms || 1, fn, args }); return id;
  };
  window.clearInterval = id => { if (id >= 2e9) vt.timers.delete(id); else realCI(id); };
  const ts = Object.getOwnPropertyDescriptor(Event.prototype, 'timeStamp');
  Object.defineProperty(Event.prototype, 'timeStamp', { configurable: true, get() { return vt.on ? vt.now : ts.get.call(this); } });
})();
