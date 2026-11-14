// The whole app switches to Khmer and back with one button.
export const sharp = 600;
export async function setup(ctx) {
  await ctx.page.mouse.click(291, 36); await ctx.sleep(300);
  await ctx.page.keyboard.type('Malapert', { delay: 20 }); await ctx.sleep(800); await ctx.page.keyboard.press('Enter');
  await ctx.sleep(5000); await ctx.settle(2500, true);
  ctx.setMouse(1000, 420); await ctx.page.mouse.move(1000, 420);
}
export async function record(ctx) {
  await ctx.hold(0.3);
  await ctx.clickText('ខ្មែរ', { sec: 0.8 });
  await ctx.hold(3.0);
}
