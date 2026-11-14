// MOONDA the robot: camera behind, drive with W, steer with A and D; tracks and dust behind it.
export const sharp = 0;
export async function setup(ctx) {
  await ctx.page.mouse.click(291, 36); await ctx.sleep(300);
  await ctx.page.keyboard.type('Malapert', { delay: 20 }); await ctx.sleep(800); await ctx.page.keyboard.press('Enter');
  await ctx.sleep(5000); await ctx.settle(3000, true);
  await ctx.setupClick('Land here'); await ctx.sleep(7000);
  await ctx.setupClick('Behind'); await ctx.sleep(2500);
  ctx.setMouse(1300, 300); await ctx.page.mouse.move(1300, 300);
}
export async function record(ctx) {
  const { page } = ctx;
  await ctx.hold(0.5);
  await page.keyboard.down('w');
  await ctx.hold(2.2);
  await page.keyboard.down('a'); await ctx.hold(1.1); await page.keyboard.up('a');
  await ctx.hold(1.6);
  await page.keyboard.down('d'); await ctx.hold(1.4); await page.keyboard.up('d');
  await ctx.hold(1.8);
  await page.keyboard.up('w');
  await ctx.hold(1.4);
}
