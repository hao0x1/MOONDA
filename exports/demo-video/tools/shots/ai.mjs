// MOONDA AI on the live site: ask a plain question, watch the steps, get a table.
export const sharp = 0;
export const query = '';
export async function setup(ctx) {
  await ctx.sleep(1500);
  ctx.setMouse(700, 420); await ctx.page.mouse.move(700, 420);
}
export async function record(ctx) {
  const { page } = ctx;
  await ctx.hold(0.3);
  await ctx.clickText('AI', { sec: 0.8 });
  await ctx.hold(1.0);
  const ta = await page.evaluate(() => { const t = document.querySelector('textarea'); if (!t) return null; const r = t.getBoundingClientRect(); return [r.x + 40, r.y + r.height / 2]; });
  if (ta) await ctx.click(ta[0], ta[1], { sec: 0.6 });
  await ctx.typeText('Which is better for a solar lander: Malapert Massif or Connecting Ridge?', 1);
  await ctx.hold(0.4);
  await ctx.key('Enter', 0.05);
  await ctx.glide(560, 600, 1.0);
  // wait (frame by frame) until the answer is finished, at most 40 s of video
  let n = 0, quiet = 0;
  while (n < 60 * 40) {
    await ctx.frame(); n++;
    if (n % 10 === 0) {
      const busy = await page.evaluate(() => { const t = document.querySelector('textarea'); return !t || /Working|Stop/i.test(t.placeholder) || [...document.querySelectorAll('button')].some(b => /^Stop$/i.test(b.textContent.trim())); });
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= 3 && n > 120) break;
    }
  }
  console.log('  answer took', (n / 60).toFixed(1), 's of video');
  await ctx.hold(3.0);
}
