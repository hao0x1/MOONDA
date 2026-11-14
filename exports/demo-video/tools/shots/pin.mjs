// From the polar view: type a place in search, the map flies there and the info card shows the numbers.
export const sharp = 1500;
export async function setup(ctx) { await ctx.setupClick('South Pole'); await ctx.sleep(4500); await ctx.settle(3000, true); ctx.setMouse(700, 420); await ctx.page.mouse.move(700, 420); }
export async function record(ctx) {
  await ctx.hold(0.3);
  await ctx.click(291, 36, { sec: 0.7 });
  await ctx.hold(0.2);
  await ctx.typeText('Malapert', 5);
  await ctx.hold(0.6);
  await ctx.key('Enter', 0.05);
  await ctx.glide(980, 560, 1.0);
  await ctx.hold(3.6);
  await ctx.glide(320, 330, 1.0);
  await ctx.hold(1.6);
}
