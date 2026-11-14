// The app as people use it: grab the Moon, fling it, then the South Pole button flies down to the pole.
export const sharp = 900;
export async function setup(ctx) { await ctx.settle(2000, true); }
export async function record(ctx) {
  const { W, H } = ctx;
  await ctx.hold(0.4);
  await ctx.drag([W * 0.58, H * 0.52], [W * 0.40, H * 0.47], 0.7, { approach: 0.7 });
  await ctx.hold(1.6);
  await ctx.drag([W * 0.45, H * 0.40], [W * 0.50, H * 0.62], 0.6, { approach: 0.5, hold: 0.25 });
  await ctx.hold(0.5);
  await ctx.clickText('South Pole', { sec: 0.8 });
  await ctx.hold(4.2);
  await ctx.glide(W * 0.62, H * 0.62, 0.8);
  await ctx.hold(0.6);
}
