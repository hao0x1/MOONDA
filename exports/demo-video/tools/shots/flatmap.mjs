// The globe unrolls into a flat map (2D button) and rolls back up.
export const sharp = 600;
export async function setup(ctx) { await ctx.settle(2000, true); ctx.setMouse(1000, 500); await ctx.page.mouse.move(1000, 500); }
export async function record(ctx) {
  await ctx.hold(0.3);
  await ctx.clickText('2D', { sec: 0.7 });
  await ctx.hold(3.4);
  await ctx.glide(900, 450, 0.8);
  await ctx.hold(0.6);
  await ctx.clickText('3D', { sec: 0.7 });
  await ctx.hold(3.0);
}
