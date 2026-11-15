// A second dev server for timed browser checks: the same app as `vite` on 5190, on port 5194, but a page that
// is open is never reloaded when a source file changes. Several people and agents edit this checkout at once,
// and a hot reload in the middle of a drive test destroys the 3D view that is being measured.
// Start it with the launch configuration "moonda-steady" (.claude/launch.json). A page loads the source as it
// is at that moment; reload the page to pick up later edits.
import { mergeConfig, type UserConfig } from 'vite';
import base from './vite.config';

const shared = (base as unknown as (env: { mode: string; command: 'serve' }) => UserConfig)({ mode: 'development', command: 'serve' });
export default mergeConfig(shared, { cacheDir: 'node_modules/.vite-steady', server: { port: 5194, strictPort: true, hmr: false } });
