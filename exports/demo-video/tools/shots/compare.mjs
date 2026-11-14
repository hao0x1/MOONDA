// Compare: the sunniest ridge loses Earth for 44 h; arriving 3 days later is worse; Malapert works.
export const sharp = 900;
const posOf = (page, fn) => page.evaluate(fn);
export async function setup(ctx) {
  const { page } = ctx;
  await page.mouse.click(291, 36); await ctx.sleep(300);
  await page.keyboard.type('Connecting Ridge', { delay: 20 }); await ctx.sleep(900); await page.keyboard.press('Enter');
  await ctx.sleep(5000); await ctx.settle(2500, true);
  await page.mouse.click(1229, 36); await ctx.sleep(1500);
  ctx.setMouse(900, 600); await page.mouse.move(900, 600);
}
export async function record(ctx) {
  const { page } = ctx;
  await ctx.hold(0.4);
  await ctx.clickText('Add the selected spot', { sec: 0.8 });
  await ctx.hold(2.0);
  const row = await posOf(page, () => { const b = document.querySelector('button.cmp-who'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + 60, r.y + r.height / 2]; });
  if (row) await ctx.click(row[0], row[1], { sec: 0.7 });
  await ctx.hold(0.9);
  await ctx.clickText('Try arriving 3 days later', { sec: 0.7 });
  await ctx.hold(2.4);
  const clr = await posOf(page, () => { const i = document.querySelector('input'); const box = i?.closest('header, .search, div'); const b = [...document.querySelectorAll('button')].find(b => { const r = b.getBoundingClientRect(); return r.y < 70 && r.x > 300 && r.x < 420 && r.width > 0; }); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  if (clr) await ctx.click(clr[0], clr[1], { sec: 0.8 });
  await ctx.hold(0.2);
  await ctx.click(291, 36, { sec: 0.4 });
  await ctx.typeText('Malapert', 4);
  await ctx.hold(0.5);
  await ctx.key('Enter', 0.05);
  await ctx.hold(2.2);
  const cmp = await posOf(page, () => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Compare' && b.getBoundingClientRect().x < 700 && b.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  if (cmp) await ctx.click(cmp[0], cmp[1], { sec: 0.8 }); else await ctx.clickText('Add the selected spot', { sec: 0.8 });
  await ctx.hold(1.0);
  await ctx.glide(1150, 300, 1.0);
  await ctx.hold(2.2);
}
