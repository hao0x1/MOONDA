// Clean plate: the whole Moon turning slowly in space (no buttons).
import { installCam, cleanUI } from './_lib.mjs';
export const sharp = 1500;
export async function setup(ctx) { await installCam(ctx.page); await cleanUI(ctx.page, true); await ctx.settle(2500, true); }
export async function record(ctx) {
  await ctx.frames(11, async p => ctx.page.evaluate(p => { const v = window.__viewer; v.camera.rotateRight(0.0016); v.camera.zoomIn(v.camera.positionCartographic.height * 0.00028); v.scene.requestRender(); }, p));
}
