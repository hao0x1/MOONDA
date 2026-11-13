// Loads @gltf-transform + draco from a scratch tools folder (set GLTF_TOOLS to a folder where they are npm-installed),
// so the app's package.json gets no new dependencies.
import { createRequire } from 'node:module';
const dir = process.env.GLTF_TOOLS;
if (!dir) throw new Error('set GLTF_TOOLS to a folder with @gltf-transform/{core,extensions,functions} and draco3dgltf installed');
const req = createRequire(dir.replace(/\/?$/, '/') + 'package.json');
export const core = req('@gltf-transform/core');
export const ext = req('@gltf-transform/extensions');
export const fn = req('@gltf-transform/functions');
const draco3d = req('draco3dgltf');
export const sharp = (() => { try { return req('sharp'); } catch { return null; } })();
export async function io() {
  return new core.NodeIO().registerExtensions(ext.ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });
}
