// MOONDA demo film — the story. Every scene is placed on FILM.master at an absolute time (seconds).
/* global gsap, FILM */
window.buildFilm = async function buildFilm() {
  const { S, master: tl, cue, clip, blurIn, blurOut, h, scene, show, W, H } = FILM;
  const at = (t, fn) => fn(t);
  let SHIFT = 0;     // seconds added by longer chapters (set after the chapters are placed); later scenes move by this much
  const DUR = { stand: 15.0, drive: 10.4, compare: 17.0, ask: 15.4 };

  // ---------- shared looks
  const HORIZON = { a: 1, r: 2700, cx: 960, cy: 1080 + 2700 - 190, yaw: -18, pitch: 62, roll: 0, lx: -0.05, ly: 0.52, lz: -0.86, exp: 2.3, rim: 1.1, glow: 0.75, glowW: 0.016, earthshine: 0.0, warm: 0.2 };
  const horizonTo = (t, dur = 1.6, extra = {}) => tl.to(S.moon, { ...HORIZON, ...extra, duration: dur, ease: 'cineInOut' }, t);

  // =====================================================================================
  // 1 · COLD OPEN  (0 – 10)
  // =====================================================================================
  {
    const sc = scene('s-open');
    const lines = [
      ['The Moon’s south pole.', 0.9, 2.75],
      ['Ice in craters that never see the Sun.', 3.05, 5.0],
      ['Sunlight on the ridges around them.', 5.3, 7.25],
      ['Everyone wants to land there.', 7.55, 9.75],
    ].map(([txt, a, b]) => { const el = h(`<div class="center h-m" style="top:470px">${txt}</div>`); sc.appendChild(el); return [el, a, b]; });
    show(tl, sc, 0, 10.4);
    cue('warp', 0, { d: 9.6, g: 0.25 }); cue('drone', 0, { d: 33.6, g: 0.055, fade: 3 });
    [0.9, 3.05, 5.3, 7.55].forEach(t => cue('tick', t, { g: 0.05 }));
    cue('riser', 7.7, { d: 2.2, g: 0.26 }); cue('impact', 9.9, { g: 0.5 });
    tl.fromTo(S.stars, { a: 0 }, { a: 1, duration: 1.4, ease: 'power1.out' }, 0.05);
    for (const [el, a, b] of lines) { blurIn(tl, el, a, { stagger: 0.022, dur: 0.9 }); blurOut(tl, el, b, { dur: 0.55 }); }
    // the Moon's edge rises at the bottom while the stars slow down
    tl.set(S.moon, { ...HORIZON, a: 0, cy: HORIZON.cy + 520 }, 0);
    tl.to(S.moon, { a: 1, cy: HORIZON.cy, duration: 3.6, ease: 'cine' }, 6.6);
    tl.to(S.stars, { lift: 160, duration: 3.6, ease: 'cine' }, 6.6);
    tl.fromTo(S.cam, { s: 1.06 }, { s: 1, duration: 10, ease: 'none' }, 0);
  }

  // =====================================================================================
  // 2a · THE SUN BARELY RISES  (9.8 – 15.4)
  // =====================================================================================
  {
    const sc = scene('s-low');
    const t1 = h(`<div class="center h-m" style="top:150px">Near the pole, the Sun never climbs high.</div>`);
    const t2 = h(`<div class="center t-l" style="top:250px">It skims the horizon, so every hill throws a long shadow.</div>`);
    const sun = h(`<div class="abs" style="left:0;top:0;width:120px;height:120px;margin:-60px 0 0 -60px">
      <div style="position:absolute;inset:-60px;border-radius:50%;background:radial-gradient(circle, rgba(255,210,140,.55) 0%, rgba(255,170,80,.18) 30%, transparent 62%)"></div>
      <img src="assets/sun.webp" style="position:absolute;left:38px;top:38px;width:44px;height:44px;border-radius:50%;filter:brightness(1.25)"></div>`);
    sc.append(t1, t2, sun);
    show(tl, sc, 9.8, 15.6);
    cue('whoosh', 10.0, { d: 4.8, g: 0.16, p: -0.7 });
    blurIn(tl, t1, 10.0, { stagger: 0.02 });
    blurIn(tl, t2, 10.7, { by: 'words', stagger: 0.05, blur: 10, y: 14 });
    // the Sun slides along just above the Moon's edge; the lit rim follows it
    const path = { a: -0.36 };
    const place = () => {
      const R = S.moon.r + 46, ang = -Math.PI / 2 + path.a;
      gsap.set(sun, { x: S.moon.cx + Math.cos(ang) * R, y: S.moon.cy + Math.sin(ang) * R });
    };
    tl.fromTo(path, { a: -0.36 }, { a: 0.36, duration: 5.6, ease: 'none', onUpdate: place }, 9.8);
    tl.fromTo(sun, { opacity: 0 }, { opacity: 1, duration: 0.8 }, 9.9);
    tl.to(S.moon, { lx: 0.55, duration: 5.6, ease: 'none' }, 9.8);
    blurOut(tl, [t1, t2], 14.9, { dur: 0.5 });
    tl.to(sun, { opacity: 0, duration: 0.5 }, 14.9);
    tl.to(S.moon, { cy: HORIZON.cy + 700, a: 0, duration: 1.0, ease: 'power2.in' }, 14.9);
    tl.to(S.stars, { a: 0.35, duration: 1.0 }, 14.9);
  }

  // =====================================================================================
  // 2b · WHY A HILL MATTERS  (15.3 – 25.6)  — side view drawing
  // =====================================================================================
  {
    const sc = scene('s-diagram');
    const GY = 770;
    // terrain: flat → hill → landing flat → crater rim → crater
    const terr = `M0 ${GY} L380 ${GY} C520 ${GY} 600 548 760 540 C900 534 930 ${GY - 6} 1040 ${GY} L1360 ${GY} C1440 ${GY} 1470 560 1540 552 C1600 548 1620 690 1700 720 C1780 748 1860 742 1920 736`;
    const svg = h(`<svg class="abs" width="1920" height="1080" viewBox="0 0 1920 1080" style="left:0;top:0;overflow:visible">
      <defs>
        <linearGradient id="gfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#15181d"/><stop offset="1" stop-color="#07080a"/></linearGradient>
        <linearGradient id="gshadow" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".0"/><stop offset=".12" stop-color="#000" stop-opacity=".62"/><stop offset="1" stop-color="#000" stop-opacity=".62"/></linearGradient>
        <radialGradient id="gsun"><stop offset="0" stop-color="#fff6e0"/><stop offset=".25" stop-color="#ffd68a"/><stop offset=".55" stop-color="#ffb340" stop-opacity=".35"/><stop offset="1" stop-color="#ffb340" stop-opacity="0"/></radialGradient>
        <radialGradient id="gearth"><stop offset=".55" stop-color="#7fb2ff" stop-opacity=".0"/><stop offset=".62" stop-color="#7fb2ff" stop-opacity=".45"/><stop offset="1" stop-color="#7fb2ff" stop-opacity="0"/></radialGradient>
      </defs>
      <g id="grid" stroke="rgba(255,255,255,.08)" stroke-width="1"></g>
      <g id="ticks"></g>
      <path id="ground" d="${terr} L1920 1080 L0 1080 Z" fill="url(#gfill)" opacity="0"/>
      <path id="shadow" d="M760 540 L1920 ${GY - 120} L1920 1080 L760 1080 Z" fill="url(#gshadow)" opacity="0"/>
      <path id="terr" d="${terr}" fill="none" stroke="#e9eaec" stroke-width="2.4"/>
      <g id="sun" transform="translate(150 560)" opacity="0"><circle r="90" fill="url(#gsun)"/><circle r="22" fill="#fff4dc"/></g>
      <line id="ray" x1="150" y1="560" x2="1190" y2="712" stroke="#ffc35c" stroke-width="3" stroke-linecap="round"/>
      <line id="rayB" x1="150" y1="560" x2="1190" y2="712" stroke="#ff5a4e" stroke-width="2" stroke-dasharray="2 9" stroke-linecap="round" opacity="0"/>
      <g id="hit" opacity="0"><circle r="14" fill="none" stroke="#ff5a4e" stroke-width="3"/><path d="M-7 -7 L7 7 M7 -7 L-7 7" stroke="#ff5a4e" stroke-width="3"/></g>
      <g transform="translate(1190 ${GY})"><g id="lander" opacity="0" stroke="#e9eaec" stroke-width="2.2" fill="none" stroke-linejoin="round">
        <path d="M-34 0 L-22 -26 M34 0 L22 -26 M-40 0 L-28 0 M28 0 L40 0"/>
        <rect x="-26" y="-58" width="52" height="32" rx="3" fill="#0c0e11"/>
        <path id="panel" d="M-26 -50 L-78 -66 L-78 -40 L-26 -34 Z" fill="#203048" stroke="#9fb6d8"/>
        <path d="M14 -58 L14 -80 M14 -80 m-11 -4 a11 11 0 0 0 22 0" />
      </g></g>
      <g id="batt" transform="translate(1290 600)" opacity="0">
        <rect x="0" y="0" width="46" height="96" rx="8" fill="none" stroke="#e9eaec" stroke-width="2.2"/>
        <rect x="15" y="-8" width="16" height="8" rx="2" fill="#e9eaec"/>
        <rect id="battFill" x="6" y="6" width="34" height="84" rx="4" fill="#8be3a8"/>
        <text id="battPct" x="64" y="56" font-size="34" font-weight="500" fill="#f4f3ef">100%</text>
      </g>
      <g id="earth" transform="translate(1800 470)" opacity="0"><circle r="60" fill="url(#gearth)"/><image href="assets/earth.webp" x="-27" y="-27" width="54" height="54"/></g>
      <line id="radio" x1="1204" y1="690" x2="1800" y2="470" stroke="#7fb2ff" stroke-width="3" stroke-dasharray="10 10" stroke-linecap="round"/>
      <g id="hit2" opacity="0"><circle r="14" fill="none" stroke="#ff5a4e" stroke-width="3"/><path d="M-7 -7 L7 7 M7 -7 L-7 7" stroke="#ff5a4e" stroke-width="3"/></g>
      <g id="lab1" opacity="0"><line x1="760" y1="530" x2="760" y2="420" stroke="rgba(255,255,255,.4)"/><text class="lbl" x="772" y="430">HILL BLOCKS THE SUN</text></g>
      <g id="lab2" opacity="0"><line x1="1540" y1="540" x2="1540" y2="380" stroke="rgba(255,255,255,.4)"/><text class="lbl" x="1552" y="390">CRATER RIM HIDES EARTH</text></g>
      <g id="lab3" opacity="0"><text class="lbl" x="1112" y="${GY + 46}">LANDER</text></g>
    </svg>`);
    const capA = h(`<div class="abs" style="left:150px;top:150px"><div class="h-s">No sunlight <span class="dim">→</span> no power.</div></div>`);
    const capB = h(`<div class="abs" style="left:150px;top:222px"><div class="h-s">No Earth in view <span class="dim">→</span> no radio link.</div></div>`);
    const big = h(`<div class="center h-m" style="top:430px">One wrong spot, or one wrong day,<br>and the mission goes dark.</div>`);
    sc.append(svg, capA, capB, big);
    const q = s => svg.querySelector(s);
    // construction grid + distance ticks
    const grid = q('#grid'), ticks = q('#ticks');
    for (let x = 120; x < 1920; x += 120) grid.insertAdjacentHTML('beforeend', `<line x1="${x}" y1="300" x2="${x}" y2="${GY + 140}"/>`);
    for (let y = 360; y <= GY + 120; y += 120) grid.insertAdjacentHTML('beforeend', `<line x1="0" y1="${y}" x2="1920" y2="${y}"/>`);
    for (let i = 0, x = 120; x < 1920; x += 240, i += 2) ticks.insertAdjacentHTML('beforeend', `<text class="lbl" x="${x + 6}" y="${GY + 132}">${i} km</text>`);
    show(tl, sc, 15.2, 25.9);
    cue('tick', 15.3, { g: 0.07 }); cue('whoosh', 15.4, { d: 1.5, g: 0.18 }); cue('blip', 16.5, { f: 2, g: 0.12 }); cue('blip', 16.9, { f: 1.5, g: 0.1 });
    cue('whoosh', 17.5, { d: 0.8, g: 0.16, p: 0.2 }); cue('err', 18.3, { g: 0.2 }); cue('fall', 18.9, { d: 2.2, g: 0.09 });
    cue('blip', 20.9, { f: 2.5, g: 0.11, p: 0.7 }); cue('whoosh', 21.4, { d: 0.7, g: 0.16, p: 0.6 }); cue('err', 22.1, { g: 0.2, p: 0.4 });
    cue('impact', 24.0, { g: 0.35 }); cue('whoosh', 25.0, { d: 0.9, g: 0.22, dir: -1 });
    const T = 15.3;
    tl.fromTo(grid.children, { drawSVG: '50% 50%', opacity: 0 }, { drawSVG: '0% 100%', opacity: 1, duration: 1.2, stagger: 0.02, ease: 'power2.out' }, T);
    tl.fromTo(ticks.children, { opacity: 0 }, { opacity: 1, stagger: 0.04, duration: 0.4 }, T + 0.4);
    tl.fromTo(q('#terr'), { drawSVG: '0%' }, { drawSVG: '100%', duration: 1.5, ease: 'power2.inOut' }, T + 0.1);
    tl.to(q('#ground'), { opacity: 1, duration: 0.8 }, T + 0.9);
    tl.to(q('#sun'), { opacity: 1, duration: 0.6 }, T + 1.2);
    tl.fromTo(q('#sun'), { scale: 0.4, transformOrigin: '50% 50%' }, { scale: 1, duration: 0.9, ease: 'back.out(1.6)' }, T + 1.2);
    tl.fromTo(q('#lander'), { opacity: 0, y: -40 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' }, T + 1.6);
    tl.to(q('#lab3'), { opacity: 1, duration: 0.4 }, T + 2.0);
    // the Sun's ray stops at the hill
    const hx = 690, hy = 560 + (712 - 560) * (hx - 150) / (1190 - 150);
    q('#ray').setAttribute('x2', hx); q('#ray').setAttribute('y2', hy.toFixed(1));
    q('#hit').setAttribute('transform', `translate(${hx} ${hy.toFixed(1)})`);
    tl.fromTo(q('#ray'), { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.8, ease: 'power1.in' }, T + 2.2);
    tl.fromTo(q('#hit'), { opacity: 0, scale: 0.3, transformOrigin: '50% 50%' }, { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(2)' }, T + 3.0);
    tl.to(q('#rayB'), { opacity: 0.6, duration: 0.5 }, T + 3.1);
    tl.to(q('#lab1'), { opacity: 1, duration: 0.5 }, T + 3.2);
    tl.fromTo(q('#shadow'), { opacity: 0 }, { opacity: 1, duration: 1.0, ease: 'power2.out' }, T + 3.2);
    tl.to(q('#panel'), { fill: '#14181f', stroke: '#5a6170', duration: 0.8 }, T + 3.3);
    tl.to(q('#batt'), { opacity: 1, duration: 0.4 }, T + 3.4);
    const batt = { p: 100 };
    tl.to(batt, { p: 4, duration: 2.2, ease: 'power1.in', onUpdate: () => {
      const f = q('#battFill'), hgt = 84 * batt.p / 100;
      f.setAttribute('y', (6 + 84 - hgt).toFixed(1)); f.setAttribute('height', hgt.toFixed(1));
      f.setAttribute('fill', batt.p > 45 ? '#8be3a8' : batt.p > 18 ? '#ffc35c' : '#ff5a4e');
      q('#battPct').textContent = `${Math.round(batt.p)}%`;
    } }, T + 3.6);
    blurIn(tl, capA, T + 3.7, { by: 'words', stagger: 0.06, blur: 10 });
    // Earth hides behind the crater rim
    tl.fromTo(q('#earth'), { opacity: 0, scale: 0.5, transformOrigin: '50% 50%' }, { opacity: 1, scale: 1, duration: 0.8, ease: 'back.out(1.5)' }, T + 5.6);
    const rx = 1532, ry = 690 + (470 - 690) * (rx - 1204) / (1800 - 1204);
    q('#radio').setAttribute('x2', rx); q('#radio').setAttribute('y2', ry.toFixed(1));
    q('#hit2').setAttribute('transform', `translate(${rx} ${ry.toFixed(1)})`);
    tl.fromTo(q('#radio'), { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.7, ease: 'power1.in' }, T + 6.1);
    tl.fromTo(q('#hit2'), { opacity: 0, scale: 0.3, transformOrigin: '50% 50%' }, { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(2)' }, T + 6.8);
    tl.to(q('#lab2'), { opacity: 1, duration: 0.5 }, T + 6.9);
    blurIn(tl, capB, T + 7.0, { by: 'words', stagger: 0.06, blur: 10 });
    // pull back: the drawing dims, the big line lands
    tl.to([svg, capA, capB], { opacity: 0.12, filter: 'blur(6px)', duration: 0.9, ease: 'power2.inOut' }, T + 8.4);
    blurIn(tl, big, T + 8.7, { stagger: 0.018 });
    tl.to([svg, capA, capB, big], { opacity: 0, filter: 'blur(14px)', duration: 0.6, ease: 'power2.in' }, 25.1);
    tl.fromTo(S.cam, { s: 1 }, { s: 1.04, duration: 10.3, ease: 'none' }, 15.3);
    tl.set(S.cam, { s: 1 }, 25.8);
  }

  // =====================================================================================
  // 2c · SAME SPOT, TWO DAYS  (25.7 – 33.0)
  // =====================================================================================
  {
    const sc = scene('s-ab');
    const X0 = 600, X1 = 1440, WD = X1 - X0;
    const xh = hr => X0 + WD * hr / 8;
    const row = (y, name, when, segs, batt, verdict, cls) => `
      <div class="abs" style="left:150px;top:${y - 40}px"><div class="mono" style="color:#cfd2d8;font-size:18px">${name}</div><div class="t-l" style="margin-top:8px;color:#f4f3ef;font-size:36px">${when}</div></div>
      <svg class="abs" width="1920" height="300" viewBox="0 ${y - 150} 1920 300" style="left:0;top:${y - 150}px;overflow:visible">
        ${segs.map(([a, b, sun]) => `<rect class="seg" x="${xh(a) + 1}" y="${y + 28}" width="${xh(b) - xh(a) - 2}" height="22" rx="4" fill="${sun ? '#ffb340' : '#2a2e36'}"/>`).join('')}
        <line x1="${X0}" y1="${y - 110}" x2="${X1}" y2="${y - 110}" stroke="rgba(255,255,255,.08)" stroke-dasharray="3 6"/>
        <line x1="${X0}" y1="${y + 10}" x2="${X1}" y2="${y + 10}" stroke="rgba(255,255,255,.10)"/>
        <path class="batt" d="${batt}" fill="none" stroke="#e9eaec" stroke-width="3" stroke-linejoin="round"/>
        <text class="lbl" x="${X0 - 14}" y="${y - 106}" text-anchor="end">100%</text><text class="lbl" x="${X0 - 14}" y="${y + 14}" text-anchor="end">0%</text>
      </svg>
      <div class="abs verdict ${cls}" style="left:${X1 + 50}px;top:${y - 34}px;font-size:32px;font-weight:500;white-space:nowrap">${verdict}</div>`;
    // teaching example (from the team's mission story): 100 Wh battery, starts at 60 Wh, uses 20 W; panels give 60 W in sunlight
    const by = (y, pct) => (y + 10 - 120 * pct / 100).toFixed(1);
    const A = 450, B = 760;
    const battA = `M${xh(0)} ${by(A, 60)} L${xh(1)} ${by(A, 100)} L${xh(4)} ${by(A, 100)} L${xh(8)} ${by(A, 20)}`;
    const battB = `M${xh(0)} ${by(B, 60)} L${xh(3)} ${by(B, 0)} L${xh(4)} ${by(B, 0)} L${xh(6.5)} ${by(B, 100)} L${xh(8)} ${by(B, 100)}`;
    const box = h(`<div class="abs" style="inset:0">
      <div class="center h-m" style="top:120px">Same spot. Two landing days.</div>
      ${row(A, 'PLAN A', 'Arrive 18 Nov', [[0, 4, 1], [4, 8, 0]], battA, '<span class="ok">✓</span> Powered all 8 hours', '')}
      ${row(B, 'PLAN B', 'Arrive 3 days later', [[0, 4, 0], [4, 8, 1]], battB, '<span class="bad">✗</span> 1 hour with no power', '')}
      <svg class="abs" width="1920" height="1080" style="left:0;top:0;overflow:visible">
        <rect id="out" x="${xh(3)}" y="${B - 114}" width="${xh(4) - xh(3)}" height="170" fill="#ff5a4e" opacity="0"/>
        <line id="ph" x1="${X0}" y1="300" x2="${X0}" y2="${B + 70}" stroke="rgba(255,255,255,.55)" stroke-width="1.5"/>
        ${[0, 2, 4, 6, 8].map(hr => `<text class="lbl" x="${xh(hr)}" y="${B + 100}" text-anchor="middle">${hr} h</text>`).join('')}
        <text class="lbl" x="${(xh(3) + xh(4)) / 2}" y="${B - 126}" text-anchor="middle" id="outLbl" opacity="0" style="fill:#ff7a70">POWER OUT</text>
      </svg>
      <div class="abs mono" style="right:110px;bottom:70px;text-transform:none;letter-spacing:.02em">Illustration · 8-hour mission · sunlight <span style="color:#ffb340">■</span> darkness <span style="color:#5a606b">■</span> battery ━</div>
    </div>`);
    const final = h(`<div class="center h-m" style="top:470px">Where <span class="dim">and</span> when you land<br>changes everything.</div>`);
    sc.append(box, final);
    show(tl, sc, 25.7, 33.2);
    cue('tick', 25.8, { g: 0.06 }); cue('tick', 26.3, { g: 0.05, f: 1.2 }); cue('tick', 26.45, { g: 0.05, f: 1.3 });
    cue('err', 28.2, { g: 0.2 }); cue('blip', 30.3, { f: 3, g: 0.11 }); cue('err', 30.55, { g: 0.16 }); cue('impact', 30.9, { g: 0.3 });
    const T = 25.8;
    const title = box.querySelector('.h-m');
    blurIn(tl, title, T, { stagger: 0.02 });
    tl.fromTo(box.querySelectorAll('.mono, .t-l'), { opacity: 0, x: -20 }, { opacity: 1, x: 0, stagger: 0.08, duration: 0.6, ease: 'power3.out' }, T + 0.4);
    tl.fromTo(box.querySelectorAll('.seg'), { scaleX: 0, transformOrigin: '0% 50%' }, { scaleX: 1, duration: 0.6, stagger: 0.06, ease: 'power3.out' }, T + 0.6);
    const batts = box.querySelectorAll('.batt');
    tl.fromTo(batts, { drawSVG: '0%' }, { drawSVG: '100%', duration: 3.2, ease: 'none' }, T + 1.2);
    tl.fromTo(box.querySelector('#ph'), { attr: { x1: X0, x2: X0 } }, { attr: { x1: X1, x2: X1 }, duration: 3.2, ease: 'none' }, T + 1.2);
    tl.to(box.querySelector('#out'), { opacity: 0.22, duration: 0.3, yoyo: true, repeat: 3 }, T + 1.2 + 3.2 * 3 / 8);
    tl.to(box.querySelector('#out'), { opacity: 0.18, duration: 0.3 }, T + 1.2 + 3.2 * 3 / 8 + 1.2);
    tl.to(box.querySelector('#outLbl'), { opacity: 1, duration: 0.3 }, T + 1.2 + 3.2 * 3 / 8);
    tl.to(batts[1], { stroke: '#ff8a80', duration: 0.3 }, T + 1.2 + 3.2 * 3 / 8);
    tl.fromTo(box.querySelectorAll('.verdict'), { opacity: 0, x: -16, filter: 'blur(8px)' }, { opacity: 1, x: 0, filter: 'blur(0px)', stagger: 0.25, duration: 0.6 }, T + 4.5);
    tl.to(box.querySelector('.abs.mono'), { opacity: 1 }, T);
    tl.to(box, { opacity: 0.1, filter: 'blur(8px)', duration: 0.8 }, 30.6);
    blurIn(tl, final, 30.9, { stagger: 0.02 });
    tl.to(final, { opacity: 0, scale: 0.96, filter: 'blur(12px)', duration: 0.5, ease: 'power2.in' }, 32.6);
    tl.to(box, { opacity: 0, duration: 0.4 }, 32.6);
  }

  // =====================================================================================
  // 3 · LOGO  (32.8 – 40.0)  — paper, dots gather into the Moon, the name arrives
  // =====================================================================================
  {
    const sc = scene('s-logo', 'paper');
    const word = h(`<div class="abs" style="left:900px;top:398px;font-size:148px;font-weight:520;letter-spacing:.11em;color:#121316;line-height:1">MOONDA</div>`);
    const tag = h(`<div class="abs t-l" style="left:906px;top:574px;font-size:34px;color:#3c3d41">Lunar Landing Site Navigator</div>`);
    const meta = h(`<div class="abs mono" style="left:908px;top:640px;font-size:15px">NASA Space Apps Challenge 2026 · Phnom Penh</div>`);
    sc.append(word, tag, meta);
    show(tl, sc, 32.75, 40.0);
    tl.to('#vignette', { opacity: 0.25, duration: 0.4 }, 32.75); tl.to('#vignette', { opacity: 1, duration: 0.3 }, 39.6);
    cue('riser', 31.4, { d: 1.35, g: 0.34 }); cue('impact', 32.75, { g: 0.55 }); cue('shimmer', 32.95, { d: 2.7, n: 120, g: 0.065, swell: 1 });
    cue('whoosh', 35.45, { d: 1.1, g: 0.22, p: -0.4 }); cue('impact', 36.05, { g: 0.3 }); cue('blip', 36.1, { f: 4, g: 0.1 });
    cue('riser', 38.3, { d: 1.7, g: 0.4 }); cue('whoosh', 39.0, { d: 1.0, g: 0.4 }); cue('impact', 40.0, { g: 0.7 });
    tl.fromTo(sc, { opacity: 0 }, { opacity: 1, duration: 0.45, ease: 'power2.out' }, 32.75);
    tl.to(S.stars, { a: 0, duration: 0.3 }, 32.75);
    tl.set(S.half, { p: 0, a: 1, cx: 960, cy: 540, s: 1, ink: 0.07, out: 0 }, 32.8);
    tl.to(S.half, { p: 1.5, duration: 2.8, ease: 'power2.out' }, 33.0);
    tl.to(S.half, { cx: 640, s: 0.66, duration: 1.1, ease: 'cineInOut' }, 35.5);
    blurIn(tl, word, 36.05, { stagger: 0.06, blur: 18, y: 0, scale: 1.0, dur: 1.0 });
    blurIn(tl, tag, 36.75, { by: 'words', stagger: 0.07, blur: 8, y: 10 });
    tl.fromTo(meta, { opacity: 0 }, { opacity: 1, duration: 0.6 }, 37.2);
    tl.fromTo(S.cam, { s: 1 }, { s: 1.035, duration: 4.0, ease: 'none' }, 35.5);
    // dive into the dot-Moon and come out in the dark
    tl.to(S.cam, { s: 5.5, x: (960 - 640) * 4.5, duration: 1.0, ease: 'power3.in' }, 39.0);
    tl.to(S.half, { s: 0.66 * 5.5, cx: 640 + (640 - 960) * 0, duration: 1.0, ease: 'power3.in' }, 39.0);
    tl.to(sc, { backgroundColor: '#040507', duration: 0.6, ease: 'power2.in' }, 39.4);
    tl.to([word, tag, meta], { opacity: 0, duration: 0.45, ease: 'power2.in' }, 39.15);
    tl.to(S.half, { a: 0, duration: 0.35 }, 39.65);
    tl.set(S.cam, { s: 1, x: 0, y: 0 }, 40.0);
    tl.set(S.half, { p: 0 }, 40.05);
  }

  // =====================================================================================
  // 4 · PICK A SPOT, PICK A DAY — the app rises from the Moon  (40 – 53.2)
  // =====================================================================================
  const FEAT_HORIZON = { ...HORIZON, cy: 1080 + 2700 - 150 };
  {
    const sc = scene('s-intro');
    const t1 = h(`<div class="center h-l" style="top:330px">Pick a spot. Pick a day.</div>`);
    const t2 = h(`<div class="center t-l" style="top:452px;font-size:34px">See the sunlight and the Earth link <span style="color:#f4f3ef">before you land.</span></div>`);
    const persp = h(`<div class="persp"></div>`);
    const win = h(`<div class="win" style="left:250px;top:186px;width:1420px;height:799px"><div class="vwrap"><video muted preload="auto" src="footage/explore.mp4"></video></div><div class="glass"></div></div>`);
    persp.appendChild(win); sc.append(persp, t1, t2);
    show(tl, sc, 40.0, 53.4);
    cue('tick', 40.35, { g: 0.06 }); cue('whoosh', 42.6, { d: 1.6, g: 0.45 });
    tl.set(S.moon, { ...FEAT_HORIZON, a: 0, cy: FEAT_HORIZON.cy + 300 }, 40.0);
    tl.to(S.moon, { a: 1, cy: FEAT_HORIZON.cy, duration: 2.0, ease: 'cine' }, 40.0);
    tl.to(S.stars, { a: 0.55, duration: 1.5 }, 40.0);
    blurIn(tl, t1, 40.35, { stagger: 0.03 });
    blurIn(tl, t2, 41.2, { by: 'words', stagger: 0.05, blur: 10, y: 12 });
    tl.to(t1, { y: -262, scale: 0.6, duration: 1.3, ease: 'cineInOut' }, 42.7);
    tl.to(t2, { opacity: 0, filter: 'blur(10px)', duration: 0.5 }, 42.6);
    tl.fromTo(win, { y: 760, rotationX: 34, scale: 0.86, opacity: 0, transformOrigin: '50% 0%' }, { y: 0, rotationX: 0, scale: 1, opacity: 1, duration: 1.7, ease: 'cine' }, 42.7);
    clip(win.querySelector('video'), 43.0, { rate: 1.0, until: 53.4 });
    // gentle push towards the pole once the flight lands
    tl.fromTo(win.querySelector('video'), { scale: 1 }, { scale: 1.12, duration: 3.5, ease: 'power1.inOut' }, 49.2);
    tl.to(t1, { opacity: 0, filter: 'blur(10px)', duration: 0.5 }, 52.4);
    tl.to(win, { opacity: 0, scale: 1.06, filter: 'blur(14px)', duration: 0.7, ease: 'power2.in' }, 52.6);
  }

  // =====================================================================================
  // 5 · FEATURE CHAPTERS
  // =====================================================================================
  let chapter = 0;
  const N_CH = 6;
  function feature(o) {
    const s = o.start, n = ++chapter;
    const sc = scene(`s-f${n}`);
    const big = h(`<div class="center h-xl" style="top:250px">${o.word}</div>`);
    const idx = h(`<div class="center mono" style="top:200px">0${n} / 0${N_CH}</div>`);
    const right = o.side !== 'left';
    const WW = o.ww ?? 1240, WH = WW * 9 / 16;
    const wx = right ? 1920 - WW - 90 : 90, wy = o.wy ?? 192;
    const persp = h(`<div class="persp"></div>`);
    const win = h(`<div class="win" style="left:${wx}px;top:${wy}px;width:${WW}px;height:${WH}px"><div class="vwrap"><video muted preload="auto" src="footage/${o.video}.mp4"></video></div><div class="glass"></div></div>`);
    persp.appendChild(win);
    const cx = right ? 110 : wx + WW + 70;
    const cap = h(`<div class="cap" style="left:${cx}px;top:${o.capY ?? 330}px;width:${right ? wx - 170 : 1920 - cx - 90}px">
      <div class="mono k">0${n} — ${o.word}</div>
      <div class="h-s">${o.title}</div>
      <div class="t-m">${o.sub}</div>
      ${o.small ? `<div class="mono" style="text-transform:none;letter-spacing:.01em;font-size:18px;line-height:1.5;margin-top:28px;color:#9a9ea6">${o.small}</div>` : ''}
    </div>`);
    sc.append(big, idx, persp, cap);
    show(tl, sc, s, s + o.dur + 0.2);
    // big word over the Moon's edge
    tl.fromTo(idx, { opacity: 0 }, { opacity: 1, duration: 0.5 }, s + 0.1);
    blurIn(tl, big, s + 0.05, { stagger: 0.06, blur: 22, y: 30, dur: 1.0 });
    tl.to([big, idx], { opacity: 0, filter: 'blur(16px)', scale: 0.94, duration: 0.7, ease: 'power2.in' }, s + 1.55);
    cue('impact', s + 0.05, { g: 0.32 }); cue('shimmer', s + 0.05, { d: 0.7, n: 18, g: 0.05 });
    cue('whoosh', s + 1.3, { d: 1.2, g: 0.42, p: right ? 0.5 : -0.5 });
    cue('tick', s + 1.95, { g: 0.08 }); cue('tick', s + 2.07, { g: 0.06, f: 1.2 });
    // the app window lands with a slight 3D turn
    tl.fromTo(win, { y: 640, rotationX: 26, rotationY: right ? -16 : 16, scale: 0.84, opacity: 0, transformOrigin: right ? '0% 50%' : '100% 50%' },
      { y: 0, rotationX: 0, rotationY: right ? -5 : 5, scale: 1, opacity: 1, duration: 1.6, ease: 'cine' }, s + 1.45);
    tl.to(win, { rotationY: right ? -1.5 : 1.5, duration: o.dur - 3.2, ease: 'none' }, s + 3.05);
    const capParts = [...cap.children];
    tl.fromTo(capParts, { opacity: 0, x: right ? -24 : 24, filter: 'blur(8px)' }, { opacity: 1, x: 0, filter: 'blur(0px)', duration: 0.9, stagger: 0.12, ease: 'cine' }, s + 1.9);
    const v = win.querySelector('video');
    clip(v, s + (o.vAt ?? 1.3), { rate: o.rate ?? 1, offset: o.offset ?? 0, map: o.map, until: s + o.dur + 0.3 });
    for (const p of o.punch ?? []) {
      tl.to(v, { scale: p.s, xPercent: p.x ?? 0, yPercent: p.y ?? 0, duration: p.d ?? 1.2, ease: 'cineInOut' }, s + p.at);
    }
    if (o.extra) o.extra(sc, s, win, cap);
    // leave
    const e = s + o.dur - 0.55;
    tl.to(win, { opacity: 0, y: -40, scale: 0.97, filter: 'blur(12px)', duration: 0.6, ease: 'power2.in' }, e);
    tl.to(cap, { opacity: 0, filter: 'blur(10px)', duration: 0.5, ease: 'power2.in' }, e);
    return sc;
  }

  // 01 FIND — search a place; the card shows sunlight and Earth for the whole mission
  feature({ start: 53.2, dur: 10.6, word: 'Find', video: 'pin', side: 'right',
    title: 'Find any spot.', sub: 'Search 9,087 official names, or click anywhere on the Moon.',
    small: 'The card answers at once: how much sunlight, the longest darkness, and whether Earth stays in view.',
    punch: [{ at: 7.0, s: 1.55, x: 26, y: 10, d: 1.4 }] });

  // 02 TIME — full-bleed time-lapse of the south pole (14 days)
  {
    const s = 63.8, dur = 11.4;
    const sc = scene('s-time');
    const big = h(`<div class="center h-xl" style="top:250px">Time</div>`);
    const idx = h(`<div class="center mono" style="top:200px">02 / 0${N_CH}</div>`);
    const full = h(`<div class="abs" style="inset:0;overflow:hidden"><video muted preload="auto" src="footage/timelapse.mp4" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:brightness(1.35) contrast(1.06)"></video>
      <div class="abs" style="inset:0;background:linear-gradient(90deg, rgba(4,5,7,.82) 0%, rgba(4,5,7,.25) 38%, transparent 60%), linear-gradient(0deg, rgba(4,5,7,.7), transparent 30%)"></div></div>`);
    const cap = h(`<div class="cap" style="left:110px;top:300px;width:620px">
      <div class="mono k">02 — Time</div>
      <div class="h-s">Watch two weeks pass in seconds.</div>
      <div class="t-m">The Sun circles the pole. Shadows sweep across the craters, from NASA’s own height data.</div></div>`);
    const clock = h(`<div class="abs" style="left:110px;bottom:96px">
      <div class="mono">Day <span id="tday">0.0</span> of 14</div>
      <div style="font-size:84px;font-weight:330;letter-spacing:-.04em;margin-top:8px;font-variant-numeric:tabular-nums" id="tdate">18 Nov 2026</div>
      <div style="width:520px;height:3px;background:rgba(255,255,255,.12);margin-top:18px;border-radius:2px"><div id="tbar" style="height:100%;width:0;background:#ffb340;border-radius:2px"></div></div></div>`);
    sc.append(full, big, idx, cap, clock);
    show(tl, sc, s, s + dur + 0.3);
    tl.fromTo(idx, { opacity: 0 }, { opacity: 1, duration: 0.5 }, s + 0.1);
    blurIn(tl, big, s + 0.05, { stagger: 0.06, blur: 22, y: 30 });
    cue('impact', s + 0.05, { g: 0.32 }); cue('whoosh', s + 1.45, { d: 1.6, g: 0.4 });
    for (let i = 0; i < 15; i++) cue('tick', s + 1.6 + i * 11 / 14, { g: 0.045, f: 1.5 });
    tl.to([big, idx], { opacity: 0, filter: 'blur(16px)', scale: 1.08, duration: 0.7, ease: 'power2.in' }, s + 1.5);
    tl.to(S.moon, { a: 0, duration: 0.8 }, s + 1.5);
    tl.fromTo(full, { opacity: 0, scale: 1.18 }, { opacity: 1, scale: 1, duration: 2.2, ease: 'cine' }, s + 1.5);
    const v = full.querySelector('video');
    clip(v, s + 1.6, { rate: 1.0, until: s + dur + 0.3 });
    tl.fromTo([...cap.children], { opacity: 0, x: -24, filter: 'blur(8px)' }, { opacity: 1, x: 0, filter: 'blur(0px)', duration: 0.9, stagger: 0.12, ease: 'cine' }, s + 2.2);
    tl.fromTo(clock, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.8, ease: 'cine' }, s + 2.4);
    // the date follows the footage: 14 days over its 11 s (smoothstep pacing like the capture used linear time)
    const tt = { p: 0 }, T0 = Date.UTC(2026, 10, 18, 2);
    const fmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    tl.to(tt, { p: 1, duration: 11, ease: 'none', onUpdate: () => {
      sc.querySelector('#tday').textContent = (tt.p * 14).toFixed(1);
      sc.querySelector('#tdate').textContent = fmt.format(new Date(T0 + tt.p * 14 * 86400e3));
      sc.querySelector('#tbar').style.width = `${tt.p * 100}%`;
    } }, s + 1.6);
    tl.to([full, cap, clock], { opacity: 0, filter: 'blur(12px)', duration: 0.6, ease: 'power2.in' }, s + dur - 0.5);
    horizonTo(s + dur - 0.6, 1.2, { cy: FEAT_HORIZON.cy });
  }

  // 03 STAND — on the ground at Malapert: the skyline, the Sun, Earth
  let cur = 75.2;
  feature({ start: cur, dur: DUR.stand, word: 'Stand', video: 'stand', side: 'left', ww: 1260,
    title: 'Stand on the spot.', sub: 'The real skyline, built from NASA laser heights. The Sun and Earth exactly where they will be.',
    small: 'Malapert Massif · 18 Nov 2026, 02:00 UTC',
    punch: [{ at: 4.6, s: 1.22, x: 0, y: 3, d: 2.0 }, { at: 7.4, s: 1.0, x: 0, y: 0, d: 0.9 }, { at: 11.2, s: 1.8, x: 26, y: 14, d: 1.6 }] });
  cur += DUR.stand;

  // 04 DRIVE — MOONDA the robot
  feature({ start: cur, dur: DUR.drive, word: 'Drive', video: 'rover', side: 'right',
    title: 'Drive MOONDA the robot.', sub: 'Six-wheel suspension, dust, wheel tracks and real Sun shadows, in low Moon gravity.',
    small: 'Rocks and soil close to the robot are an artist’s impression.' });
  cur += DUR.drive;

  // 05 COMPARE — plans side by side
  feature({ start: cur, dur: DUR.compare, word: 'Compare', video: 'compare', side: 'left',
    title: 'Compare plans.', sub: 'Up to four spots and landing days. Say what your lander can handle; MOONDA says which plan works.',
    small: 'One click: what changes if we arrive 3 days later?',
    map: [[0, 0], [7.0, 7.4], [9.4, 12.6], [15.1, 18.6]],
    punch: [{ at: 7.0, s: 1.5, x: -25, y: 0, d: 1.2 }, { at: 9.9, s: 1.0, x: 0, y: 0, d: 1.0 }, { at: 13.9, s: 1.5, x: -25, y: 6, d: 1.1 }] });
  cur += DUR.compare;

  // 06 ASK — MOONDA AI
  feature({ start: cur, dur: DUR.ask, word: 'Ask', video: 'ai', side: 'right',
    title: 'Ask in plain words.', sub: 'MOONDA AI runs our own sunlight and Earth-view maths, shows every step, and explains its pick.',
    small: 'Answers come back as tables you can open on the map.',
    map: [[0, 0], [4.0, 4.2], [8.2, 15.6], [10.8, 20.6], [14.6, 24.6]],
    punch: [{ at: 5.6, s: 1.5, x: -25, y: 12, d: 1.2 }, { at: 10.4, s: 1.0, x: 0, y: 0, d: 1.0 }, { at: 12.0, s: 1.6, x: -30, y: 22, d: 1.1 }] });
  cur += DUR.ask;
  SHIFT = cur - 122.2;

  // 07 · two quick extras side by side: flat map + Khmer  (122.2 – 129.6)
  {
    const s = SHIFT + 122.2, dur = 7.4;
    const sc = scene('s-extras');
    const mk = (x, vid, k, t) => h(`<div class="abs" style="left:${x}px;top:250px;width:840px">
      <div class="win" style="position:relative;width:840px;height:472.5px"><div class="vwrap"><video muted preload="auto" src="footage/${vid}.mp4"></video></div><div class="glass"></div></div>
      <div class="mono" style="margin-top:28px">${k}</div><div class="h-s" style="margin-top:10px;font-size:40px">${t}</div></div>`);
    const a = mk(90, 'flatmap', 'Map', 'Globe or flat map.'), b = mk(990, 'khmer', 'Language', 'English or <span class="kh">ខ្មែរ</span>.');
    sc.append(a, b);
    show(tl, sc, s, s + dur + 0.2);
    cue('whoosh', s - 0.1, { d: 1.2, g: 0.4 });
    tl.fromTo([a, b], { opacity: 0, y: 80, filter: 'blur(10px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 1.2, stagger: 0.18, ease: 'cine' }, s);
    clip(a.querySelector('video'), s + 0.3, { until: s + dur + 0.3 });
    clip(b.querySelector('video'), s + 1.6, { until: s + dur + 0.3, offset: 0.2 });
    tl.to([a, b], { opacity: 0, y: -30, filter: 'blur(12px)', duration: 0.6, stagger: 0.08, ease: 'power2.in' }, s + dur - 0.6);
    tl.to(S.moon, { a: 0, cy: FEAT_HORIZON.cy + 400, duration: 1.0, ease: 'power2.in' }, s + dur - 0.7);
  }

  // =====================================================================================
  // 6 · HOW IT WORKS  (129.6 – 150.4)
  // =====================================================================================
  {
    const s = SHIFT + 129.6;
    const sc = scene('s-how');
    const head = h(`<div class="abs" style="left:110px;top:110px"><div class="mono">How it works</div><div class="h-m" style="margin-top:14px">Real NASA data.<br><span class="dim">Our own maths.</span></div></div>`);
    const wrap = h(`<div class="stack-wrap"><div class="stack"></div></div>`);
    const stack = wrap.firstElementChild;
    const LAYERS = [
      ['pole-photo', 'LRO camera', 'Photos of the south pole'],
      ['pole-height', 'LOLA laser altimeter', 'Heights · 80 m per pixel'],
      ['pole-sunlight', 'LOLA illumination', 'How often the Sun shines'],
      ['pole-earth', 'Earth visibility', 'How often Earth is in view'],
      ['pole-ice', 'Permanent shadow', 'Where ice can hide'],
    ];
    const els = LAYERS.map(([img], i) => { const d = h(`<div class="layer3d" style="background-image:url(assets/${img}.jpg)"></div>`); stack.appendChild(d); return d; });
    const tags = LAYERS.map(([, k, t], i) => { const d = h(`<div class="ltag" style="left:1600px;top:0"><div class="mono">${k}</div><div class="t-m">${t}</div></div>`); sc.appendChild(d); return d; });
    sc.prepend(wrap); sc.append(head);
    show(tl, sc, s, s + 9.6);
    cue('impact', s, { g: 0.3 }); cue('whoosh', s + 1.6, { d: 1.6, g: 0.35 }); for (let i = 0; i < 5; i++) cue('tick', s + 2.6 + i * 0.18, { g: 0.05, f: 1 + i * 0.1 });
    tl.to(S.ascii, { a: 1, duration: 1.5 }, s);
    tl.fromTo(S.ascii, { shift: 0 }, { shift: 60, duration: 21, ease: 'none' }, s);
    blurIn(tl, head.querySelector('.h-m'), s + 0.3, { by: 'words', stagger: 0.08 });
    tl.fromTo(head.querySelector('.mono'), { opacity: 0 }, { opacity: 1, duration: 0.6 }, s + 0.2);
    // stacked flat, then fan out in 3D
    els.forEach((el, i) => {
      tl.fromTo(el, { rotationX: 62, rotationZ: -38, z: -i * 2, y: 0, opacity: 0, scale: 0.52 },
        { opacity: 1, duration: 0.8, ease: 'power2.out' }, s + 0.6 + i * 0.08);
      tl.to(el, { y: (i - 2) * -118, duration: 1.8, ease: 'cineInOut' }, s + 1.7);
      tl.to(el, { rotationZ: -30, duration: 7.0, ease: 'none' }, s + 1.7);
    });
    tags.forEach((tg, i) => {
      gsap.set(tg, { top: 600 + (i - 2) * -118 * 0.98 - 22, left: 1480 });
      tl.fromTo(tg, { opacity: 0, x: 30 }, { opacity: 1, x: 0, duration: 0.7, ease: 'cine' }, s + 2.6 + (4 - i) * 0.18);
    });
    tl.to([wrap, ...tags, head], { opacity: 0, filter: 'blur(12px)', duration: 0.7, ease: 'power2.in' }, s + 8.9);
  }
  {
    // skyline: 720 directions around one spot; the Sun's path; blocked or not
    const s = SHIFT + 139.2;
    const sc = scene('s-sky');
    const CX = 1290, CY = 560, R0 = 330;
    const r = FILM.rng(21);
    // a believable skyline: elevation (deg) per direction, smooth noise
    const el = []; const ph = [r() * 6, r() * 6, r() * 6, r() * 6];
    for (let i = 0; i < 720; i++) { const a = i / 720 * Math.PI * 2; el.push(1.6 + 1.2 * Math.sin(a * 2 + ph[0]) + 0.8 * Math.sin(a * 5 + ph[1]) + 0.45 * Math.sin(a * 11 + ph[2]) + 0.22 * Math.sin(a * 23 + ph[3]) + (a > 3.4 && a < 4.5 ? 3.6 * Math.sin((a - 3.4) / 1.1 * Math.PI) : 0)); }
    const rad = e => R0 * (1 - Math.min(8, Math.max(0, e)) / 8 * 0.8);   // horizon at R0, 8° up near the centre (polar sky plot)
    const pt = (i, e) => { const a = i / 720 * Math.PI * 2 - Math.PI / 2; return [CX + Math.cos(a) * rad(e), CY + Math.sin(a) * rad(e)]; };
    let sky = ''; for (let i = 0; i <= 720; i++) { const [x, y] = pt(i % 720, el[i % 720]); sky += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; }
    let rays = ''; for (let i = 0; i < 720; i += 4) { const [x, y] = pt(i, el[i]); rays += `<line x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }
    // the Sun's path: low, about 1.5° high, going all the way round
    const sunE = i => 2.6 + 0.6 * Math.sin(i / 720 * Math.PI * 2 + 1.3);
    let segs = ''; let cur = null, d = '';
    for (let i = 0; i <= 720; i += 2) { const blocked = sunE(i % 720) < el[i % 720]; const [x, y] = pt(i % 720, sunE(i % 720)); if (cur === null || blocked !== cur) { if (d) segs += `<path class="sp ${cur ? 'off' : 'on'}" d="${d}"/>`; d = `M${x.toFixed(1)} ${y.toFixed(1)}`; cur = blocked; } else d += ` L${x.toFixed(1)} ${y.toFixed(1)}`; }
    segs += `<path class="sp ${cur ? 'off' : 'on'}" d="${d}"/>`;
    const svg = h(`<svg class="abs" width="1920" height="1080" style="left:0;top:0;overflow:visible">
      <g stroke="rgba(255,255,255,.08)" fill="none">${[1, 0.75, 0.5, 0.25].map(k => `<circle cx="${CX}" cy="${CY}" r="${R0 * k}"/>`).join('')}</g>
      <g id="rays" stroke="rgba(160,190,255,.22)" stroke-width="1">${rays}</g>
      <path id="ground" d="M${CX - R0 - 2} ${CY} a${R0 + 2} ${R0 + 2} 0 1 0 ${2 * R0 + 4} 0 a${R0 + 2} ${R0 + 2} 0 1 0 ${-2 * R0 - 4} 0 Z ${sky}Z" fill="rgba(120,124,132,.16)" fill-rule="evenodd" opacity="0"/>
      <path id="sky" d="${sky}Z" fill="none" stroke="#f4f3ef" stroke-width="2.4"/>
      <g id="sunpath" fill="none" stroke-width="5" stroke-linecap="round">${segs}</g>
      <circle cx="${CX}" cy="${CY}" r="7" fill="#f4f3ef"/>
      <text class="lbl" x="${CX}" y="${CY - R0 - 22}" text-anchor="middle">N</text><text class="lbl" x="${CX + R0 + 22}" y="${CY + 5}">E</text>
      <text class="lbl" x="${CX}" y="${CY + R0 + 34}" text-anchor="middle">S</text><text class="lbl" x="${CX - R0 - 36}" y="${CY + 5}">W</text>
    </svg>`);
    svg.querySelectorAll('.sp.on').forEach(p => p.setAttribute('stroke', '#ffb340'));
    svg.querySelectorAll('.sp.off').forEach(p => { p.setAttribute('stroke', '#ff5a4e'); p.setAttribute('stroke-dasharray', '2 10'); });
    const steps = [
      ['01', 'Heights', 'NASA’s laser altimeter measured the ground around the spot.'],
      ['02', 'Skyline', 'We walk out in <b>720 directions</b> and keep the highest hill in each. About 15 ms per spot.'],
      ['03', 'Sun & Earth', 'Their positions for any minute, within <b>0.0014°</b> of NASA JPL Horizons.'],
      ['04', 'Blocked or not', 'Below the skyline means hidden. Count it up for the whole mission.'],
    ];
    const list = h(`<div class="abs" style="left:110px;top:250px;width:660px">${steps.map(([n, k, t]) => `<div class="stp" style="display:grid;grid-template-columns:64px 1fr;padding:20px 0;border-top:1px solid rgba(255,255,255,.10)">
      <div class="mono" style="padding-top:6px">${n}</div><div><div style="font-size:32px;font-weight:520;letter-spacing:-.015em">${k}</div><div class="t-m" style="margin-top:6px;font-size:22px">${t}</div></div></div>`).join('')}</div>`);
    let vis = 0; for (let i = 0; i < 720; i++) if (sunE(i) >= el[i]) vis++;
    const sunPct = Math.round(vis / 720 * 100);
    const result = h(`<div class="abs" style="left:${CX - 230}px;top:${CY + R0 + 62}px;width:460px;text-align:center">
      <div class="mono">Example spot · Sun above the skyline</div><div style="font-size:58px;font-weight:350;color:#ffb340;margin-top:4px"><span id="rs">0</span>% <span style="font-size:24px;color:#9a9ea6">of the time</span></div></div>`);
    sc.append(svg, list, result);
    show(tl, sc, s, s + 11.4);
    cue('tick', s + 0.1, { g: 0.05 }); cue('shimmer', s + 1.7, { d: 1.4, n: 60, g: 0.035 }); cue('whoosh', s + 2.1, { d: 1.4, g: 0.2 }); cue('blip', s + 4.6, { f: 3, g: 0.1 }); cue('blip', s + 6.7, { f: 2.5, g: 0.1 });
    const stp = list.querySelectorAll('.stp');
    tl.fromTo(stp, { opacity: 0, y: 24, filter: 'blur(8px)' }, { opacity: 0.32, y: 0, filter: 'blur(0px)', duration: 0.7, stagger: 0.1, ease: 'cine' }, s + 0.1);
    const lit = i => tl.to(stp[i], { opacity: 1, duration: 0.35 }, s + [0.6, 1.6, 4.4, 6.6][i]);
    const dim = i => tl.to(stp[i], { opacity: 0.32, duration: 0.35 }, s + [1.6, 4.4, 6.6, 10.0][i]);
    [0, 1, 2, 3].forEach(i => { lit(i); dim(i); });
    tl.fromTo(svg.querySelectorAll('circle'), { opacity: 0, scale: 0.6, transformOrigin: `${CX}px ${CY}px` }, { opacity: 1, scale: 1, duration: 1.0, stagger: 0.06, ease: 'cine' }, s + 0.4);
    tl.fromTo(svg.querySelectorAll('#rays line'), { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.25, stagger: { each: 0.0075 }, ease: 'none' }, s + 1.7);
    tl.fromTo(svg.querySelector('#sky'), { drawSVG: '0%' }, { drawSVG: '100%', duration: 1.4, ease: 'power1.inOut' }, s + 2.1);
    tl.to(svg.querySelector('#ground'), { opacity: 1, duration: 0.6 }, s + 3.3);
    tl.to(svg.querySelector('#rays'), { opacity: 0.35, duration: 0.6 }, s + 3.6);
    tl.fromTo(svg.querySelectorAll('.sp'), { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.1, stagger: 0.12, ease: 'none' }, s + 4.6);
    tl.fromTo(result, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.6 }, s + 6.6);
    const cnt = { s: 0 };
    tl.to(cnt, { s: sunPct, duration: 1.4, ease: 'power2.out', onUpdate: () => { result.querySelector('#rs').textContent = Math.round(cnt.s); } }, s + 6.8);
    tl.to([svg, list, result], { opacity: 0, filter: 'blur(12px)', duration: 0.6, ease: 'power2.in' }, s + 10.6);
    tl.to(S.ascii, { a: 0, duration: 1.0 }, s + 10.4);
  }
  {
    // checked against places we know
    const s = SHIFT + 150.2;
    const sc = scene('s-checks');
    const head = h(`<div class="abs" style="left:110px;top:140px"><div class="mono">Checked against places we know</div><div class="h-m" style="margin-top:14px">Same answers as the published science.</div></div>`);
    const rows = [
      ['Shackleton crater floor', '0% sunlight', 'Permanent shadow, as expected'],
      ['Connecting Ridge', '≈80% sunlight', 'Published 80–90%'],
      ['Malapert summit', '100% Earth view', 'Faces Earth, as expected'],
      ['Chang’e-4, far side', '0% Earth view', 'Never sees Earth, as expected'],
    ];
    const tbl = h(`<div class="abs" style="left:110px;top:380px;width:1700px">${rows.map(([a, b, c]) => `<div class="row"><div>${a}</div><div class="v" style="color:#f4f3ef">${b}</div><div class="t-m" style="font-size:24px">${c}</div><div class="tick">✓</div></div>`).join('')}</div>`);
    sc.append(head, tbl);
    show(tl, sc, s, s + 6.4);
    for (let i = 0; i < 4; i++) cue('blip', s + 1.4 + i * 0.32, { f: 3 + i * 0.25, g: 0.1 });
    tl.fromTo(head.children, { opacity: 0, y: 16, filter: 'blur(8px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', stagger: 0.12, duration: 0.8, ease: 'cine' }, s);
    tbl.querySelectorAll('.row').forEach((r, i) => {
      tl.fromTo(r, { opacity: 0, x: -30 }, { opacity: 1, x: 0, duration: 0.6, ease: 'cine' }, s + 0.6 + i * 0.32);
      tl.fromTo(r.querySelector('.v'), { scrambleText: { text: ' ', chars: '0123456789%' } }, { scrambleText: { text: rows[i][1], chars: '0123456789%≈', speed: 0.6 }, duration: 0.8 }, s + 0.7 + i * 0.32);
      tl.fromTo(r.querySelector('.tick'), { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(2.5)' }, s + 1.4 + i * 0.32);
    });
    tl.to([head, tbl], { opacity: 0, filter: 'blur(12px)', duration: 0.6, ease: 'power2.in' }, s + 5.8);
  }

  // =====================================================================================
  // 7 · NUMBERS  (156.6 – 163.6)
  // =====================================================================================
  {
    const s = SHIFT + 156.6;
    const sc = scene('s-nums');
    const stats = [[9087, '', 'official place names'], [4224, '', 'sharp south-pole photo tiles'], [8900, '', 'real stars in the sky'], [0, 'Offline', 'works without internet']];
    const box = h(`<div class="abs" style="left:110px;top:330px;width:1700px;display:grid;grid-template-columns:repeat(4,1fr);gap:40px">${stats.map(([n, w, l]) => `<div><div class="num">${w || '0'}</div><div class="t-m" style="margin-top:14px">${l}</div></div>`).join('')}</div>`);
    const chips = ['NASA LRO', 'LOLA', 'LROC', 'Diviner', 'IAU names', 'JPL Horizons', 'Astronomy Engine', 'CesiumJS'];
    const row = h(`<div class="abs" style="left:110px;top:680px;display:flex;gap:14px;flex-wrap:wrap;width:1700px">${chips.map(c => `<div class="chip">${c}</div>`).join('')}</div>`);
    const lab = h(`<div class="abs mono" style="left:110px;top:620px">Built on</div>`);
    sc.append(box, row, lab);
    show(tl, sc, s, s + 7.2);
    for (let i = 0; i < 4; i++) cue('tick', s + 0.2 + i * 0.12, { g: 0.05 }); cue('whoosh', s + 1.45, { d: 1.0, g: 0.2 });
    const nums = box.querySelectorAll('.num');
    tl.fromTo(box.children, { opacity: 0, y: 30, filter: 'blur(10px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.9, stagger: 0.12, ease: 'cine' }, s + 0.1);
    stats.forEach(([n, w], i) => {
      if (w) return;
      const o = { v: 0 };
      tl.to(o, { v: n, duration: 1.6, ease: 'power3.out', onUpdate: () => { nums[i].textContent = Math.round(o.v).toLocaleString('en-US'); } }, s + 0.2 + i * 0.12);
    });
    tl.fromTo(lab, { opacity: 0 }, { opacity: 1, duration: 0.5 }, s + 1.4);
    tl.fromTo(row.children, { opacity: 0, y: 14, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.06, ease: 'back.out(1.6)' }, s + 1.5);
    tl.to([box, row, lab], { opacity: 0, filter: 'blur(12px)', duration: 0.6, ease: 'power2.in' }, s + 6.6);
  }

  // =====================================================================================
  // 8 · TEAM  (163.6 – 171.4)
  // =====================================================================================
  {
    const s = SHIFT + 163.6;
    const sc = scene('s-team');
    const head = h(`<div class="abs" style="left:110px;top:130px"><div class="mono">Team MOONDA</div><div class="h-m" style="margin-top:14px">Six students from Phnom Penh, Cambodia.</div></div>`);
    const people = [
      ['Zhihao Wu', 'App and code'], ['Yuradeth Kdan', 'Science checks'], ['Phen Bun', 'Art and 3D'],
      ['Buy Vong Varo', 'Interface design'], ['Bonnathisak Chuon', 'Testing and slides'], ['Sethsobotra Vich', 'Pitch'],
    ];
    const grid = h(`<div class="abs" style="left:110px;top:380px;width:1700px;display:grid;grid-template-columns:repeat(3,1fr);row-gap:70px">${people.map(([n, r], i) => `<div class="mem"><div class="ix mono">0${i + 1}</div><div style="font-size:44px;font-weight:500;letter-spacing:-.02em;margin-top:12px">${n}</div><div class="t-m" style="margin-top:6px">${r}</div></div>`).join('')}</div>`);
    sc.append(head, grid);
    show(tl, sc, s, s + 7.8);
    cue('whoosh', s, { d: 1.2, g: 0.25 }); for (let i = 0; i < 6; i++) cue('tick', s + 0.65 + i * 0.1, { g: 0.04, f: 1 + i * 0.08 });
    tl.fromTo(head.children, { opacity: 0, y: 16, filter: 'blur(8px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', stagger: 0.12, duration: 0.8, ease: 'cine' }, s);
    tl.fromTo(grid.children, { opacity: 0, y: 34, filter: 'blur(10px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.9, stagger: 0.1, ease: 'cine' }, s + 0.6);
    tl.to(S.stars, { a: 0.6, duration: 1.0 }, s);
    tl.to([head, grid], { opacity: 0, filter: 'blur(12px)', duration: 0.6, ease: 'power2.in' }, s + 7.2);
  }

  // =====================================================================================
  // 9 · END CARD  (171.4 – 181)
  // =====================================================================================
  {
    const s = SHIFT + 171.4;
    const sc = scene('s-end');
    const word = h(`<div class="center" style="top:300px;font-size:132px;font-weight:520;letter-spacing:.12em;line-height:1;padding-left:.12em">MOONDA</div>`);
    const line = h(`<div class="center h-m" style="top:470px;font-size:58px">Know before you land.</div>`);
    const url = h(`<div class="center mono" style="top:570px;font-size:18px;text-transform:none;letter-spacing:.04em;color:#cfd2d8">moonda-lunar-navigator.netlify.app</div>`);
    const credit = h(`<div class="center mono" style="top:1010px;font-size:12px;text-transform:none;letter-spacing:.02em;color:#62666e">NASA Space Apps Challenge 2026 · Lunar Landing Site Navigator · Data: NASA LRO (LOLA, LROC, Diviner), IAU/USGS, JPL · Music: “Cylinder Five” by Chris Zabriskie (CC BY 4.0)</div>`);
    sc.append(word, line, url, credit);
    show(tl, sc, s, s + 9.9);
    cue('riser', s - 1.5, { d: 1.5, g: 0.35 }); cue('impact', s, { g: 0.75 }); cue('shimmer', s + 0.5, { d: 1.6, n: 50, g: 0.05, swell: 1 }); cue('blip', s + 1.5, { f: 2, g: 0.09 });
    // the whole Moon, lit from the side, comes up from below
    tl.set(S.moon, { a: 0, r: 1500, cx: 960, cy: 1080 + 1500 - 330, yaw: -10, pitch: 18, roll: 0, lx: -0.7, ly: 0.55, lz: 0.45, exp: 1.25, rim: 0.25, glow: 0.4, glowW: 0.03, earthshine: 0.025, warm: 0.15 }, s);
    tl.to(S.moon, { a: 1, cy: 1080 + 1500 - 420, duration: 3.0, ease: 'cine' }, s);
    tl.to(S.moon, { yaw: 6, duration: 9.6, ease: 'none' }, s);
    tl.to(S.stars, { a: 0.8, duration: 1.5 }, s);
    blurIn(tl, word, s + 0.5, { stagger: 0.07, blur: 20, y: 0, dur: 1.2 });
    blurIn(tl, line, s + 1.5, { by: 'words', stagger: 0.09, blur: 12 });
    tl.fromTo(url, { opacity: 0 }, { opacity: 1, duration: 0.8 }, s + 2.4);
    tl.fromTo(credit, { opacity: 0 }, { opacity: 1, duration: 0.8 }, s + 2.8);
    tl.to('#stage', { opacity: 1, duration: 0.01 }, s);
    tl.to(['#scenes', '#gl', '#bg'], { opacity: 0, duration: 1.4, ease: 'power1.in' }, s + 8.2);
    tl.set({}, {}, s + 9.8);
  }
};
