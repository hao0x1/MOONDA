// Stand here on Malapert Massif: drop to the ground, the Sun low in the east, then turn to Earth above the skyline.
export const sharp = 1200;
export async function setup(ctx) {
  await ctx.page.mouse.click(291, 36); await ctx.sleep(300);
  await ctx.page.keyboard.type('Malapert', { delay: 20 }); await ctx.sleep(800); await ctx.page.keyboard.press('Enter');
  await ctx.sleep(5000); await ctx.settle(3000, true);
  ctx.setMouse(400, 330); await ctx.page.mouse.move(400, 330);
}
const heading = page => page.evaluate(() => { try { const l = window.__moonda?.lander; return l && l.active ? l.headingDeg() : null; } catch { return null; } });
export async function record(ctx) {
  const { page } = ctx;
  await ctx.hold(0.3);
  await ctx.clickText('Stand here', { sec: 0.7 });
  await ctx.hold(3.0);
  await ctx.glide(1250, 300, 0.8);
  await ctx.hold(0.6);
  // turn to the north (Earth) with a few real drags, the way a person would look around
  let dir = 1, perPx = 0.05;          // dir 1 = drag towards the right; learnt from the first drag
  for (let k = 0; k < 6; k++) {
    const h = await heading(page);
    console.log('  heading', h);
    if (h === null || h < 14 || h > 300) break;
    const dist = k === 0 ? 420 : Math.min(950, Math.max(200, (h - 6) / perPx));
    const x0 = dir > 0 ? 260 : 1180;
    await ctx.drag([x0, 430], [x0 + dir * dist, 440], k === 0 ? 0.8 : 1.15, { approach: k ? 0.35 : 0.6, hold: 0.12 });
    await ctx.hold(0.35);
    const h2 = await heading(page);
    if (k === 0 && h2 !== null) { const moved = ((h2 - h + 540) % 360) - 180; if (moved > 0) dir = -1; perPx = Math.max(0.02, Math.abs(moved) / dist); console.log('  first drag moved', moved.toFixed(1), 'deg; dir', dir, 'perPx', perPx.toFixed(3)); }
  }
  console.log('  final heading', await heading(page));
  await ctx.glide(1250, 620, 0.9);
  await ctx.hold(2.6);
}
