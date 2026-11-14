// Clean plate: straight down on the south pole while 14 days pass; shadows swing round the craters.
import { installCam, cam, camGet, cleanUI, setTime, T0, lerp, smooth } from './_lib.mjs';
export const sharp = 2500;
let c;
export async function setup(ctx) {
  await installCam(ctx.page);
  await ctx.setupClick('South Pole');
  await ctx.sleep(4500);
  await cleanUI(ctx.page, true);
  c = await camGet(ctx.page);
  console.log('pole cam', JSON.stringify(c));
  await setTime(ctx.page, T0);
  await cam(ctx.page, c.lon, c.lat, 360000, c.heading, -90);
  await ctx.settle(5000, true);
}
export async function record(ctx) {
  await ctx.frames(11, async p => {
    const s = smooth(p);
    await setTime(ctx.page, T0 + p * 14 * 86400e3);
    await cam(ctx.page, c.lon, c.lat, lerp(360000, 215000, s), c.heading + lerp(0, 14, s), -90);
  });
}
