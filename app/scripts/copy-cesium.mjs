// Copy CesiumJS runtime files (web workers, textures, widget CSS) into public/cesium.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const src = 'node_modules/cesium/Build/Cesium';
const version = JSON.parse(readFileSync('node_modules/cesium/package.json', 'utf8')).version;
const stamp = 'public/cesium/.version';
if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) process.exit(0);
for (const dir of ['Workers', 'ThirdParty', 'Assets', 'Widgets']) cpSync(`${src}/${dir}`, `public/cesium/${dir}`, { recursive: true });
writeFileSync(stamp, version);
console.log(`Copied CesiumJS ${version} assets to public/cesium`);
