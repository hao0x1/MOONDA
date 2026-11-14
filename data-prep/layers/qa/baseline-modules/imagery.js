// Imagery for the 3D Moon: NASA photos and map layers, re-projected into the rotated display frame.
//
// Live sources checked 14 Nov 2026 (curl: real images, 200, Access-Control-Allow-Origin: *):
// - lroc-tiles.quickmap.io/tiles/kag_tc_e_7m/lunar-fulleqc/{z}/{x}/{y}.png?d_val=0,5000&d_opt=wcolut0:
//   global Kaguya evening TC, native 7.4 m; z12 delivery grid 5.2 m (no claim of 5 m real
//   detail). A fixed display range keeps the stretch consistent; WAC anchors broad tone.
//   ISAS/JAXA observation data, credited reuse and display changes allowed; via Lunar QuickMap.
// - trek.nasa.gov/tiles/Moon/EQ/{layer}/1.0.0/default/default028mm/{z}/{y}/{x}.png:
//   Kaguya_TCortho_Mosaic_Global_4096ppd is native 7.4 m but the LIVE service stops at z10,
//   about 20.8 m/pixel. z11/12 are 404: this is the fallback, not the primary global photo.
//   NAC mosaics for all six Apollo sites, Tycho, Chang'e-4, SLIM, IM-1 and Blue Ghost's region
//   reach about 0.3–2.6 m grid spacing; the source itself can be coarser. NASA/GSFC/ASU.
// - lroc-tiles.quickmap.io/tiles/wac_nac_nacroi/lunar-fulleqc/{z}/{x}/{y}.jpg:
//   QuickMap's WAC + NAC strips + ROI basemap. Requested only around recent landers, at close
//   zoom; about 0.5–2 m real NAC detail, not a new global sub-metre survey. Lunar QuickMap
//   (NASA, Intuitive Machines, ACT); live catalogue describes these data as public domain.
// - lroc-tiles.quickmap.io/tiles/lnpole_avg/lunar-sterenp/{z}/{x}/{y}.png?d_val=0,0.5&d_opt=wcolut0:
//   controlled north-pole NAC, 84–90°N, native 1 m, z12 grid 0.888 m. NASA/GSFC/ASU.
//   The public WMS also has a 1 m uncontrolled north mosaic, but its measured 21 s cold renders
//   lose to these cached polar tiles (3.2 s). WMS is tried only after a cached square fails.
//   Existing south stays local first.
// LROC permits credited educational use; do not call all non-PDS products public domain.
// Full layer names, measured responses, terms and modification notice: CREDITS-imagery.md.
//
// Round 2: QuickMap's kag_tc_m_7m Morning product (same URL/grid/range as Evening) is also
// live, public and CORS-enabled; JAXA's sln-l-tc-5-morning-map-v4.0 archive confirms the product.
// Four paired histograms put detail-free shadows in the 0--2 DN spike. Those pixels have a
// six-source-pixel feather BEFORE projection; Morning is requested only where an on-screen
// Evening tile has >0.5% black. WAC fills where both lack ground. This mixes Sun directions;
// it is a readable terrain composite, not a photograph of one moment (see imagery credits).
// Tycho's two brightness boxes were reproduced directly in NASA's raw NAC z12--14 tiles:
// they are joins inside that mosaic. We keep a fixed geographic exposure reference rather
// than inventing per-request corrections that would move the joins as tiles load.
// Sharp photos match exposure against a FIXED coarser source and WAC reference.
// The same true-frame reference at every zoom avoids per-tile mean jumps.
// The west-lit seam fix supplies the reference there. Polar and fallback photos add fine detail
// to the existing broad picture. An NAC mosaic replaces TC inside its feathered footprint.
// These choices happen INSIDE photo / photoFix, with no new ImageryLayer or UI switch. Sharp
// requests only start beyond WAC's z8 and never run in start-up's existing south-pole views.
// Close views keep WAC then request the visible target level, deferring intermediate levels
// without discarding them (a later zoom-out can still use them). Requests nearer the screen
// centre get the next server slot; cancelled consumers also leave that priority queue.
// Retained decoded sources, including masks/local rasters, share an LRU budget per worker:
// 128 + 64 + 32 MiB at most. This is a cache limit, not a bound on the whole browser/GPU.
//
// Cesium asks each imagery provider for 256x256 lon/lat tiles of the DISPLAY frame (see frame.ts:
// the true south pole sits on Cesium's equator, so polar tiles are normal squares, not slivers).
// The pictures themselves are in the TRUE Moon frame, so every tile is re-projected pixel by pixel.
// That work (download, decode, re-project) happens in a small pool of Web Workers
// (imageryWorker.ts); the main thread only does cheap checks and hands finished ImageBitmaps to
// Cesium.
//
// - createBaseMosaicProvider:   the whole-Moon photo stored with the app (public/data/base): the
//                               bottom layer, there at once and with no internet
// - createMoonTrekProvider:     NASA Moon Trek global tiles (photo, LOLA colour heights)
// - createPolarRasterProvider:  one local south-polar picture (polar photo, science maps)
// - createPolarPyramidProvider: sharp south-polar photo squares, down to ~1 m/pixel: read from the
//                               copies stored with the app (public/data/polar/t) where they exist,
//                               from ASU Lunaserv elsewhere
//
// Each provider only covers the part of the Moon it has pictures for (its `rectangle`), and tiles
// that turn out to be empty are answered at once with one shared transparent pixel, so the layers
// underneath show through and nothing smeared is ever left on screen.
//
// Where the data ends, loading ends: a tile that could only repeat its parent (the photos have no
// finer detail there), or whose download failed, is answered "keep showing the parent tile"
// (Cesium's tile-discard mechanism), so nothing is requested for it and no hole appears. After a
// failed download the layer asks Cesium to reload its tiles once the network works again (Cesium
// itself never asks twice for a tile it has received).
import { Cartesian2, Cartesian3, Cartographic, Credit, Event, GeographicTilingScheme, Rectangle, RequestState } from "/node_modules/.vite/deps/cesium.js?v=f79bc84e";
import { MOON_ELLIPSOID } from "/src/moon/ellipsoid.ts";
import { FIX_MIN_TRUE_LAT, NORTH_PHOTO_LAT, POLAR_FEATHER_M, POLAR_LIMIT_DEG, PYRAMID_MAX_K, RETRY_MS, TILE, parsePyramidIndex, pixelDeg, pyramidLevelFor, pyramidParentIsEnough, pyramidSurelyLocal, tileFixRange, tileTrueLatRange, photoMaxLevel, pixelMetres } from "/src/moon/imageryWorker.ts?t=1794657591228";
// ---------------------------------------------------------------------------------------------
// Worker pool. Worker 0 does every polar-raster job, so each big raster is decoded and held
// once. Tiled sources are pinned to one of the other workers, so every source tile is downloaded
// and cached exactly once: all Moon Trek layers share one worker (so its download limit covers
// the whole trek.nasa.gov server), the polar pyramid has its own.
// The science maps use one further worker and a separate memory budget, so preparing them
// never makes the local Moon photo lose its decoded source.
const RASTER_QUEUE = 48;
const TILED_QUEUE = 24;
const LOCAL_QUEUE = 64;
// Reloading tiles that were drawn with holes.
const RELOAD_AFTER_GAPS_MS = RETRY_MS + 5e3;
const RELOAD_AFTER_RECOVERY_MS = 1500;
const RELOAD_MIN_SPACING_MS = 3e4;
const RELOAD_MAX_SPACING_MS = 10 * 6e4;
/**
* Raised after a layer asked the globe to reload tiles that had holes. With requestRenderMode
* the scene only starts loading them on its next frame, so the map view can listen and call
* scene.requestRender().
*/
export const imageryReloaded = new Event();
function onePixel() {
	const c = new OffscreenCanvas(1, 1);
	c.getContext("2d");
	return c.transferToImageBitmap();
}
/** One fully transparent pixel, shared by every empty tile. */
let blank;
const blankTile = () => blank ??= onePixel();
/**
* The answer "nothing new here: keep showing the parent tile". Cesium asks every provider's
* tileDiscardPolicy about each picture it receives; ours recognises this one, so the tile is
* marked as not available and its parent's picture stays on screen (stretched by the GPU).
*/
let parentMark;
const parentMarkBitmap = () => parentMark ??= onePixel();
const discardPolicy = {
	isReady: () => true,
	shouldDiscardImage: (image) => image !== undefined && image === parentMark
};
/**
* WebGL is meant to ignore UNPACK_FLIP_Y for ImageBitmaps; Cesium relies on that (its own tile
* bitmaps are created pre-flipped) and so do we. Check once in this browser by uploading a 1x2
* bitmap, so tiles can never come out upside down. Resolves true if the browser DOES flip.
*/
async function detectBitmapFlip() {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		const gl = canvas.getContext("webgl", {
			antialias: false,
			depth: false,
			stencil: false
		});
		if (!gl) return false;
		const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray([
			255,
			0,
			0,
			255,
			0,
			0,
			255,
			255
		]), 1, 2), { premultiplyAlpha: "none" });
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		const px = new Uint8Array(4);
		gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
		bmp.close();
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return px[2] > px[0];
	} catch {
		return false;
	}
}
class ImageryWorkers {
	workers = [];
	busy = [];
	local = [];
	jobs = new Map();
	/**
	* Counters for the loading screen and for tests. parents = tiles answered "keep the parent";
	* deepest = finest tile level asked of the workers per kind of layer; files/remote/failed =
	* downloads by the workers (files stored with the app / remote servers / failed).
	*/
	stats = {
		asked: 0,
		answered: 0,
		refused: 0,
		deferred: 0,
		cancelled: 0,
		parents: 0,
		slowestMs: 0,
		lastMs: 0,
		totalMs: 0,
		files: 0,
		remote: 0,
		failed: 0,
		decodedBytes: 0,
		decodedImages: 0,
		caches: [],
		deepest: {},
		traffic: {}
	};
	net = [];
	traffic = [];
	flip = detectBitmapFlip();
	routes = new Map();
	/** Layers that drew tiles with holes and are waiting to reload them. */
	gapped = new Set();
	nextId = 1;
	scienceWarm = new Map();
	scienceValues = new Map();
	tiledCount;
	scienceWorker;
	constructor() {
		const cores = navigator.hardwareConcurrency || 4;
		this.tiledCount = cores >= 4 ? 2 : 1;
		this.scienceWorker = this.tiledCount + 1;
		for (let i = 0; i <= this.scienceWorker; i++) {
			const w = new Worker(new URL(/* @vite-ignore */ "/src/moon/imageryWorker.ts?worker_file&type=module", '' + import.meta.url), { type: "module" });
			w.onmessage = (e) => this.finish(e.data, i);
			w.onerror = (e) => this.fail(i, e);
			this.workers.push(w);
			this.busy.push(0);
			this.local.push(0);
			this.net.push([
				0,
				0,
				0
			]);
			// Science maps have their own worker so keeping them ready cannot evict the Moon photo.
			w.postMessage({ cacheBudgetBytes: (i === this.scienceWorker ? 512 : i === 0 ? 128 : i === 1 ? 64 : 32) * 2 ** 20 });
		}
		addEventListener("online", () => {
			const msg = { forgetFailures: true };
			for (const w of this.workers) w?.postMessage(msg);
			for (const p of this.gapped) p.networkBack();
		});
	}
	/** Worker for a tiled source: the same source always goes to the same worker (so its cache is shared). */
	route(source) {
		let w = this.routes.get(source);
		if (w === undefined) this.routes.set(source, w = 1 + this.routes.size % this.tiledCount);
		return w;
	}
	/**
	* Run a job, or return undefined when that worker already has a full queue (Cesium retries next
	* frame). `local` = the job needs no remote download: those have their own, longer queue so
	* they are never stuck behind tiles that wait for a slow server.
	*/
	run(worker, job, owner, local = false, request) {
		const w = this.workers[worker];
		if (!w) return Promise.resolve(blankTile());
		const count = local ? this.local : this.busy;
		if (count[worker] >= (local ? LOCAL_QUEUE : worker === 0 ? RASTER_QUEUE : TILED_QUEUE)) {
			this.stats.refused++;
			return undefined;
		}
		count[worker]++;
		this.stats.asked++;
		this.stats.deepest[job.kind] = Math.max(this.stats.deepest[job.kind] ?? 0, job.level);
		const id = this.nextId++;
		return new Promise((done, reject) => {
			this.jobs.set(id, {
				worker,
				owner,
				done,
				reject,
				request,
				at: performance.now(),
				kind: job.kind,
				local,
				rect: job.rect
			});
			if (request) {
				const previous = request.cancelFunction;
				request.cancelFunction = () => {
					previous?.();
					this.cancel(id);
				};
				// A custom provider does not enter Cesium's URL scheduler, which normally calls
				// cancelFunction. Honour an explicit cancel immediately here too.
				const cancel = request.cancel;
				if (cancel) request.cancel = () => {
					cancel.call(request);
					this.cancel(id);
				};
				if (request.cancelled) this.cancel(id);
			}
			void this.flip.then((flipRows) => {
				if (this.jobs.has(id)) {
					const msg = {
						id,
						job,
						flipRows
					};
					w.postMessage(msg);
				}
			});
		});
	}
	cancel(id) {
		const j = this.jobs.get(id);
		if (!j) return;
		this.jobs.delete(id);
		(j.local ? this.local : this.busy)[j.worker]--;
		this.stats.cancelled++;
		this.workers[j.worker]?.postMessage({ cancel: id });
		if (j.request) {
			// Cesium then returns this tile to UNLOADED, ready to try when it is seen again.
			j.request.state = RequestState.CANCELLED;
			j.reject(new DOMException("Tile left the view", "AbortError"));
		} else j.done(parentMarkBitmap());
	}
	cancelOutside(rectangles) {
		const now = performance.now();
		for (const [id, j] of this.jobs) {
			if (j.kind !== "photo" || now - j.at < 350) continue;
			if (!rectangles.some((r) => rectanglesOverlap(j.rect, r))) this.cancel(id);
		}
	}
	/** Tell one worker something that is not a tile job (e.g. which pyramid squares are stored with the app). */
	tell(worker, msg) {
		this.workers[worker]?.postMessage(msg);
	}
	warmScience(sources, progress) {
		if (!this.workers[this.scienceWorker]) return Promise.resolve(false);
		const warmId = this.nextId++;
		return new Promise((resolve) => {
			this.scienceWarm.set(warmId, {
				resolve,
				progress
			});
			this.tell(this.scienceWorker, {
				warmScience: sources,
				warmId
			});
		});
	}
	scienceValue(source, lat, lon) {
		if (!this.workers[this.scienceWorker]) return Promise.resolve(null);
		const valueId = this.nextId++;
		return new Promise((resolve) => {
			this.scienceValues.set(valueId, resolve);
			this.tell(this.scienceWorker, {
				scienceValue: {
					source,
					lat,
					lon
				},
				valueId
			});
		});
	}
	finish({ id, bitmap, gaps, recovered, parent, net, traffic, cache, warmed, warmFrac, warmOk, valueId, value }, worker) {
		if (cache) {
			this.stats.caches[worker] = cache;
			this.stats.decodedBytes = this.stats.caches.reduce((n, c) => n + (c?.retainedBytes ?? 0), 0);
			this.stats.decodedImages = this.stats.caches.reduce((n, c) => n + (c?.retainedCount ?? 0), 0);
		}
		if (warmed !== undefined) {
			const job = this.scienceWarm.get(warmed);
			job?.progress?.(warmFrac ?? 0);
			if (warmFrac === 1) {
				this.scienceWarm.delete(warmed);
				job?.resolve(warmOk !== false);
			}
			return;
		}
		if (valueId !== undefined) {
			this.scienceValues.get(valueId)?.(value ?? null);
			this.scienceValues.delete(valueId);
			return;
		}
		if (traffic) {
			this.traffic[worker] = traffic;
			const totals = {};
			for (const record of this.traffic) if (record) for (const [site, t] of Object.entries(record)) {
				const s = totals[site] ??= {
					requests: 0,
					bytes: 0
				};
				s.requests += t.requests;
				s.bytes += t.bytes;
			}
			this.stats.traffic = totals;
		}
		if (recovered) {
			for (const p of this.gapped) if (p.worker === worker) p.networkBack();
		}
		if (net) {
			this.net[worker] = net;
			this.stats.files = this.stats.remote = this.stats.failed = 0;
			for (const n of this.net) {
				this.stats.files += n[0];
				this.stats.remote += n[1];
				this.stats.failed += n[2];
			}
		}
		const j = this.jobs.get(id);
		if (!j) {
			bitmap?.close();
			return;
		}
		this.jobs.delete(id);
		(j.local ? this.local : this.busy)[j.worker]--;
		const ms = performance.now() - j.at;
		this.stats.answered++;
		this.stats.lastMs = ms;
		this.stats.totalMs += ms;
		this.stats.slowestMs = Math.max(this.stats.slowestMs, ms);
		if (gaps) {
			this.gapped.add(j.owner);
			j.owner.noteGaps();
			if (j.kind === "base") baseBroke();
			// Failed final tiles walk down their ancestor chain. Let that walk finish, too:
			// deferring an intermediate ancestor offline would keep tilesLoaded false forever.
			if (j.kind === "photo") photoGateBackoffUntil = performance.now() + RETRY_MS;
		}
		if (parent) this.stats.parents++;
		j.done(parent ? parentMarkBitmap() : bitmap ?? blankTile());
	}
	/** Jobs handed to the workers and not answered yet. */
	pending() {
		return this.jobs.size;
	}
	pendingPhotos() {
		let n = 0;
		for (const j of this.jobs.values()) if (j.kind === "photo") n++;
		return n;
	}
	/** For tests: what is waiting, per kind of job, and for how long (ms). */
	waiting() {
		const now = performance.now();
		return [...this.jobs.values()].map((j) => ({
			kind: j.kind,
			worker: j.worker,
			ms: Math.round(now - j.at)
		}));
	}
	/** A layer has reloaded its tiles. */
	settled(p) {
		this.gapped.delete(p);
	}
	/** A worker that crashed or could not start: its tiles (and later ones) come back transparent. */
	fail(worker, e) {
		console.error("Imagery worker stopped:", e.message);
		this.workers[worker]?.terminate();
		this.workers[worker] = null;
		for (const [id, j] of this.jobs) if (j.worker === worker) {
			this.jobs.delete(id);
			j.done(blankTile());
		}
		this.busy[worker] = this.local[worker] = 0;
	}
}
let pool;
const workers = () => pool ??= new ImageryWorkers();
/** Rectangles here are ordinary display-grid tiles; none crosses the date line. */
const rectanglesOverlap = (a, b) => a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;
let photoView;
let savedPreloads;
let photoGateBackoffUntil = 0;
const deferredPhotos = new Map();
const admittedPhotos = new Set();
const viewTiling = new GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID });
const viewPixel = new Cartesian2(), viewHit = new Cartesian3(), viewCartographic = new Cartographic(), distancePoint = new Cartesian3();
const photoKey = (r, level) => `${level}/${r.west}/${r.south}`;
const clampValue = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const levelAtSpacing = (metres) => clampValue(Math.round(Math.log2(pixelMetres(0) / Math.max(.001, metres))), 8, 17);
/** Estimate the photo pixels actually needed by this camera, rather than visiting every
* intermediate resolution on the way down. All coordinates here use Cesium's display frame. */
function updatePhotoView(viewer) {
	const { scene, camera } = viewer, globe = scene.globe;
	const frustum = camera.frustum;
	const fovy = frustum.fovy ?? frustum.fov;
	if (!fovy || !scene.drawingBufferHeight) return;
	viewPixel.x = scene.canvas.clientWidth / 2;
	viewPixel.y = scene.canvas.clientHeight / 2;
	const ray = camera.getPickRay(viewPixel), hit = ray && globe.pick(ray, scene, viewHit);
	const cameraLL = camera.positionCartographic;
	let lon = cameraLL.longitude, lat = cameraLL.latitude;
	let groundHeight = globe.getHeight(cameraLL) ?? 0;
	let distance = Math.max(1, Math.abs(cameraLL.height - groundHeight));
	if (hit) {
		const at = MOON_ELLIPSOID.cartesianToCartographic(hit, viewCartographic);
		if (at) {
			lon = at.longitude;
			lat = at.latitude;
			groundHeight = at.height;
		}
		distance = Math.max(1, Cartesian3.distance(camera.positionWC, hit));
	}
	const metresPerDistance = 2 * Math.tan(fovy / 2) * globe.maximumScreenSpaceError / scene.drawingBufferHeight;
	let level = levelAtSpacing(distance * metresPerDistance);
	const xy = viewTiling.positionToTileXY(new Cartographic(lon, lat), level);
	if (xy) level = Math.min(level, photoMaxLevel(viewTiling.tileXYToRectangle(xy.x, xy.y, level)));
	const old = photoView, now = performance.now();
	const changed = !old || old.level !== level || Cartesian3.distanceSquared(old.camera, camera.positionWC) > Math.max(1, distance * distance * 1e-6) || Math.abs(Math.atan2(Math.sin(lon - old.lon), Math.cos(lon - old.lon))) > pixelDeg(level) * Math.PI / 180 || Math.abs(lat - old.lat) > pixelDeg(level) * Math.PI / 180;
	photoView = {
		lon,
		lat,
		level,
		cameraLon: cameraLL.longitude,
		cameraLat: cameraLL.latitude,
		groundHeight,
		camera: Cartesian3.clone(camera.positionWC),
		metresPerDistance,
		changedAt: changed ? now : old.changedAt
	};
	if (changed) {
		deferredPhotos.clear();
		admittedPhotos.clear();
	}
	pool?.tell(pool.route("trek"), { photoView: {
		lon,
		lat,
		level
	} });
	if (level > 10) {
		if (!savedPreloads || savedPreloads.viewer !== viewer) savedPreloads = {
			viewer,
			ancestors: globe.preloadAncestors,
			siblings: globe.preloadSiblings
		};
		else if (globe.preloadAncestors || globe.preloadSiblings) {
			savedPreloads.ancestors = globe.preloadAncestors;
			savedPreloads.siblings = globe.preloadSiblings;
		}
		globe.preloadAncestors = false;
		globe.preloadSiblings = false;
	} else if (savedPreloads?.viewer === viewer) {
		globe.preloadAncestors = savedPreloads.ancestors;
		globe.preloadSiblings = savedPreloads.siblings;
		savedPreloads = undefined;
		deferredPhotos.clear();
		admittedPhotos.clear();
	}
}
/** Camera-dependent waits stay UNLOADED in Cesium, so a later zoom-out can request them.
* A discard marker would make the same useful tile INVALID until it left the cache. */
function deferPhoto(rect, level) {
	const view = photoView;
	if (!view || view.level <= 10 || level <= 8 || performance.now() < photoGateBackoffUntil) return false;
	const key = photoKey(rect, level);
	if (admittedPhotos.has(key)) return false;
	const middle = (rect.west + rect.east) / 2;
	const cameraLon = middle + Math.atan2(Math.sin(view.cameraLon - middle), Math.cos(view.cameraLon - middle));
	const lon = clampValue(cameraLon, rect.west, rect.east), lat = clampValue(view.cameraLat, rect.south, rect.north);
	Cartesian3.fromRadians(lon, lat, view.groundHeight, MOON_ELLIPSOID, distancePoint);
	const distance = Math.max(1, Cartesian3.distance(view.camera, distancePoint));
	const target = Math.min(view.level, photoMaxLevel(rect), levelAtSpacing(distance * view.metresPerDistance));
	if (level >= target) return false;
	if (!deferredPhotos.has(key)) deferredPhotos.set(key, {
		rect,
		level,
		at: performance.now()
	});
	if (pool) pool.stats.deferred++;
	return true;
}
/**
* Call after a frame while the camera moves. Cesium keeps old terrain tiles in memory,
* but only these tiles are on screen: sharp downloads outside them can stop. The short
* grace period lets the first terrain frame catch up after a camera jump.
*/
export function cancelOffscreenImagery(viewer, cull = true) {
	if (!pool || viewer.isDestroyed()) return;
	updatePhotoView(viewer);
	const surface = viewer.scene.globe._surface;
	const tiles = surface?._tilesToRender;
	if (tiles?.length) {
		if (cull) pool.cancelOutside(tiles.map((tile) => tile.rectangle));
		// Perspective views can genuinely need a coarser tile far from the rover. Once finer
		// work is quiet, admit any such tile STILL being rendered. Ancestors alone stay skipped,
		// so their queues cannot keep tilesLoaded false forever. No cache state is invalidated.
		const now = performance.now();
		if (photoView && now - photoView.changedAt > 400 && pool.pendingPhotos() === 0) {
			for (const tile of tiles) for (const link of tile.data?.imagery ?? []) {
				const loading = link.loadingImagery;
				if (!loading?.rectangle) continue;
				const key = photoKey(loading.rectangle, loading.level), deferred = deferredPhotos.get(key);
				if (deferred && now - deferred.at > 400) {
					admittedPhotos.add(key);
					deferredPhotos.delete(key);
					viewer.scene.requestRender();
				}
			}
		}
	}
}
/** Map pictures asked for and not finished yet, across all layers (0 = nothing is loading). For the loading screen. */
export function imageryPending() {
	return pool ? pool.pending() : 0;
}
// Small test/debug hook (scripts/drive.mjs): what the imagery workers are doing right now.
globalThis.__moondaImagery = {
	pending: imageryPending,
	stats: () => pool ? {
		...pool.stats,
		deepest: { ...pool.stats.deepest }
	} : null,
	waiting: () => pool ? pool.waiting() : [],
	view: () => photoView ? {
		lon: photoView.lon,
		lat: photoView.lat,
		level: photoView.level,
		deferred: deferredPhotos.size,
		admitted: admittedPhotos.size
	} : null
};
export class ReprojectedImageryProvider {
	tilingScheme = new GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID });
	rectangle;
	tileWidth = TILE;
	tileHeight = TILE;
	minimumLevel = 0;
	maximumLevel;
	/** Lets a tile say "keep showing my parent" (see parentMarkBitmap above). */
	tileDiscardPolicy = discardPolicy;
	errorEvent = new Event();
	credit;
	proxy = undefined;
	hasAlphaChannel = true;
	/** Set by Cesium's globe while the layer is shown: drops the layer's tiles and asks for them again. */
	_reload = undefined;
	worker;
	jobFor;
	isLocal;
	gaps = false;
	reloadAt = Infinity;
	reloadTimer;
	lastReload = -Infinity;
	spacing = RELOAD_MIN_SPACING_MS;
	constructor(o) {
		this.rectangle = o.rectangle;
		this.maximumLevel = o.maximumLevel;
		this.credit = new Credit(o.credit);
		this.worker = o.worker;
		this.jobFor = o.jobFor;
		this.isLocal = o.isLocal;
	}
	getTileCredits() {
		return [];
	}
	requestImage(x, y, level, request) {
		const r = this.tilingScheme.tileXYToRectangle(x, y, level);
		const job = this.jobFor({
			west: r.west,
			south: r.south,
			east: r.east,
			north: r.north
		}, level, x, y);
		if (job === "wait") return undefined;
		if (job === "parent") {
			workers().stats.parents++;
			return Promise.resolve(parentMarkBitmap());
		}
		if (job?.kind === "photo" && deferPhoto(job.rect, level)) return undefined;
		return job ? workers().run(this.worker, job, this, this.isLocal?.(job) ?? false, request) : Promise.resolve(blankTile());
	}
	/** Drop this layer's tiles and ask for them again now (used when what the layer should draw has changed). */
	reloadNow() {
		if (!this._reload) return;
		this._reload();
		imageryReloaded.raiseEvent();
	}
	pickFeatures() {
		return undefined;
	}
	/** A tile came back with holes (a download failed): reload once the worker will really try again. */
	noteGaps() {
		this.gaps = true;
		this.scheduleReload(RELOAD_AFTER_GAPS_MS);
	}
	/** The network works again: reload soon if this layer has holes. */
	networkBack() {
		if (this.gaps) this.scheduleReload(RELOAD_AFTER_RECOVERY_MS);
	}
	scheduleReload(delay) {
		const now = performance.now(), at = Math.max(now + delay, this.lastReload + this.spacing);
		if (at >= this.reloadAt) return;
		clearTimeout(this.reloadTimer);
		this.reloadAt = at;
		this.reloadTimer = setTimeout(() => this.reload(), at - now);
	}
	reload() {
		const now = performance.now();
		this.reloadTimer = undefined;
		this.reloadAt = Infinity;
		// Calm since the last reload: start again from the shortest spacing. Holes again soon after
		// (the network is still bad): wait twice as long before the next try.
		this.spacing = now - this.lastReload > 4 * this.spacing ? RELOAD_MIN_SPACING_MS : Math.min(2 * this.spacing, RELOAD_MAX_SPACING_MS);
		this.lastReload = now;
		this.gaps = false;
		workers().settled(this);
		if (!this._reload) return;
		this._reload();
		imageryReloaded.raiseEvent();
	}
}
/**
* Display-frame box around the true south-polar cap south of `clipDeg`. The cap is centred on
* display 0°N 90°E, so a cap of angular radius r spans ±r in display lat and 90°±r in display lon.
* A little extra (0.2°) keeps the soft edge pixels inside. For the default clip this is true lat < -79.8°.
*/
function polarRectangle(clipDeg) {
	const r = Math.min(90, 90 + clipDeg + .2);
	return Rectangle.fromDegrees(90 - r, -r, 90 + r, r);
}
let baseSet;
/** Moon Trek layers that leave the levels the local picture already shows to it. */
const overBase = new Set();
/** The local picture cannot be used after all (file missing or unreadable): the Moon Trek photo takes over its levels. */
function baseBroke() {
	if (!baseSet || baseSet.state === "failed") return;
	baseSet.state = "failed";
	for (const p of overBase) p.reloadNow();
}
function basePictureOf(folder, m, mips) {
	const p = m;
	if (!p || typeof p.file !== "string" || typeof p.width !== "number" || typeof p.height !== "number" || typeof p.west !== "number" || typeof p.north !== "number" || typeof p.level !== "number") return undefined;
	const t = 180 / 2 ** p.level, pic = {
		url: new URL(p.file, folder).href,
		level: p.level,
		ox: (p.west + 180) / t,
		oy: (90 - p.north) / t,
		cols: p.width / TILE,
		rows: p.height / TILE,
		mips: Math.max(0, mips(p.level)),
		poleAware: p.poleAware === true
	};
	return [
		pic.ox,
		pic.oy,
		pic.cols,
		pic.rows,
		pic.level
	].every(Number.isInteger) ? pic : undefined;
}
/** Where display tile x, y of `level` sits inside a local picture, or null if the picture does not hold it. */
function baseCut(p, x, y, level) {
	if (!p || level > p.level) return null;
	const mip = p.level - level, f = 2 ** mip;
	if (p.ox % f || p.oy % f) return null;
	const tx = x - p.ox / f, ty = y - p.oy / f;
	if (tx < 0 || ty < 0 || (tx + 1) * f > p.cols || (ty + 1) * f > p.rows) return null;
	return {
		url: p.url,
		mip,
		px: tx * TILE,
		py: ty * TILE,
		mips: p.mips,
		poleAware: p.poleAware
	};
}
/** The picture of the local set that draws this tile: the whole-Moon one up to its level, the sharper polar ones beyond. */
const baseCutFor = (b, x, y, level) => b.global && level <= b.global.level ? baseCut(b.global, x, y, level) : baseCut(b.south, x, y, level) ?? baseCut(b.north, x, y, level);
/** The seam-fix settings of base.json (v5), with the albedo picture's URL resolved, or undefined. */
function fixOf(folder, m) {
	const f = m;
	const a = f?.albedo, h = f?.hillshade;
	if (!a || !h || typeof a.file !== "string" || typeof f.C !== "number" || typeof f.S0 !== "number") return undefined;
	const num = (v) => typeof v === "number" ? v : NaN;
	const fix = {
		albedo: {
			url: new URL(a.file, folder).href,
			west: num(a.west),
			east: num(a.east),
			north: num(a.north),
			south: num(a.south),
			scale: num(a.scale)
		},
		C: f.C,
		S0: f.S0,
		near: String(h.near),
		far: String(h.far),
		nearMaxLat: num(h.nearMaxLat)
	};
	return Object.values(fix.albedo).every((v) => typeof v === "string" || Number.isFinite(v)) && Number.isFinite(fix.nearMaxLat) ? fix : undefined;
}
/**
* The whole-Moon photo stored with the app, as the bottom layer: on screen at once, sharp for the
* opening view and the "South Pole" view, and still there with no internet. `url` is the folder
* that holds base.json (default ./data/base/), written by data-prep/base_mosaic.py:
*   moon8k.jpg  whole Moon, display tile levels 0-4 (1.3 km per pixel)
*   moon2k.jpg  the same, small: drawn first while the big one is decoded
*   south6.jpg  within 33.75 degrees of the south pole at level 6 (333 m per pixel), if present
* Deeper tiles are answered "keep the parent", so the layer never asks for more than it has.
* Give the layer the same show/alpha as the Moon Trek 'photo' layer above it.
*/
export function createBaseMosaicProvider(o) {
	const folder = new URL(o.url ?? "./data/base/", document.baseURI).href.replace(/\/?$/, "/");
	const set = baseSet = { state: "loading" };
	void fetch(`${folder}base.json`).then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))).then((m) => {
		set.global = basePictureOf(folder, m.pictures?.global, (level) => level);
		set.quick = basePictureOf(folder, m.pictures?.quick, (level) => level);
		// the south picture only draws the levels the whole-Moon picture does not reach
		set.south = set.global && basePictureOf(folder, m.pictures?.south, (level) => level - set.global.level - 1);
		set.north = set.global && basePictureOf(folder, m.pictures?.north, (level) => level - set.global.level - 1);
		set.fix = fixOf(folder, m.fix);
		set.state = set.global ? "ready" : "failed";
	}).catch((e) => {
		console.warn("Local Moon picture not available:", e);
		set.state = "failed";
	});
	return new ReprojectedImageryProvider({
		rectangle: Rectangle.clone(Rectangle.MAX_VALUE),
		maximumLevel: 6,
		credit: o.credit,
		worker: 0,
		isLocal: () => true,
		jobFor: (rect, level, x, y) => {
			if (set.state === "loading") return "wait";
			if (set.state === "failed") return null;
			const cut = baseCutFor(set, x, y, level);
			if (!cut) return "parent";
			return {
				kind: "base",
				rect,
				level,
				cut,
				quick: cut.url === set.global?.url && baseCut(set.quick, x, y, level) || undefined
			};
		}
	});
}
/**
* NASA Moon Trek global tiles (true lon/lat WMTS), re-projected into display tiles. Pixels south
* of `minTrueLat` stay transparent so the polar layers show there instead. Display levels go one
* past `maxSourceLevel` so the deepest tiles are drawn straight from the source at 2x, not
* re-sampled twice.
*
* `overBase` (for the photo that the local whole-Moon picture is made from): the levels that
* picture already shows are left to it (transparent here), so the opening view and the "South
* Pole" view need nothing from the internet. Needs a createBaseMosaicProvider layer underneath;
* without one, or if its files are missing, every level is streamed as before.
*/
export function createMoonTrekProvider(o) {
	const minTrueLat = o.minTrueLat ?? -90;
	const p = new ReprojectedImageryProvider({
		rectangle: Rectangle.clone(Rectangle.MAX_VALUE),
		maximumLevel: o.sharpPhoto ? 17 : o.maxSourceLevel + 1,
		credit: o.credit,
		worker: workers().route("trek"),
		jobFor: (rect, level, x, y) => {
			let northBase;
			if (o.overBase && baseSet) {
				if (baseSet.state === "loading") return "wait";
				if (baseSet.state === "ready" && baseCutFor(baseSet, x, y, level)) return null;
				if (baseSet.state === "ready" && baseSet.fix && seamFixOn && tileFixRange(rect).min >= 1 && !(o.sharpPhoto && level > 8 && tileTrueLatRange(rect).minDeg > NORTH_PHOTO_LAT)) return null;
				if (o.sharpPhoto && level > 8 && tileTrueLatRange(rect).minDeg > NORTH_PHOTO_LAT) {
					const scale = 2 ** Math.max(0, level - 6), px = Math.floor(x / scale), py = Math.floor(y / scale);
					const cut = baseCutFor(baseSet, px, py, 6);
					if (cut) {
						const r = p.tilingScheme.tileXYToRectangle(px, py, 6);
						northBase = {
							cut,
							rect: {
								west: r.west,
								east: r.east,
								south: r.south,
								north: r.north
							}
						};
					}
				}
			}
			return minTrueLat > -90 && tileTrueLatRange(rect).maxDeg < minTrueLat - pixelDeg(level) ? null : o.sharpPhoto && level > photoMaxLevel(rect) ? "parent" : o.sharpPhoto && level > 8 ? {
				kind: "photo",
				rect,
				level,
				layer: o.layer,
				minTrueLat,
				northBase
			} : {
				kind: "trek",
				rect,
				level,
				layer: o.layer,
				ext: o.ext,
				maxSourceLevel: o.maxSourceLevel,
				minTrueLat
			};
		}
	});
	if (o.overBase) overBase.add(p);
	return p;
}
/** False once the seam-fix layer is known to be missing (then the photo must draw everywhere). */
let seamFixOn = false;
/**
* The seam fix above the Moon Trek photo (v5). NASA's WAC global mosaic is lit from the east in true
* lon -180..-90 and from the west everywhere else, so it shows two straight lighting flips (at -90 and
* 180). This layer draws albedo x hillshade there (lit from the west like the rest), see-through where
* the photo is right and cross-fading over -90..-80 and 165..180. The settings come from base.json
* (data-prep/base_mosaic.py bakes the same picture into the local whole-Moon set, so this layer only
* draws levels deeper than that set). Needs a createBaseMosaicProvider layer (v5 folder) underneath and
* the photo layer below it; give it the same show/alpha as the photo.
*/
export function createSeamFixProvider(o) {
	seamFixOn = true;
	return new ReprojectedImageryProvider({
		rectangle: Rectangle.clone(Rectangle.MAX_VALUE),
		maximumLevel: 17,
		credit: o.credit,
		worker: workers().route("trek"),
		jobFor: (rect, level, x, y) => {
			const b = baseSet;
			if (!b || b.state === "loading") return "wait";
			if (b.state === "failed" || !b.fix) return null;
			if (baseCutFor(b, x, y, level)) return null;
			if (tileTrueLatRange(rect).maxDeg < FIX_MIN_TRUE_LAT - pixelDeg(level)) return null;
			if (tileFixRange(rect).max <= 0) return null;
			// The local north-pole picture already includes the seam fix. The photo worker uses
			// that as its brightness reference, avoiding a ring of remote EQ tiles at the pole.
			if (level > 8 && tileTrueLatRange(rect).minDeg > NORTH_PHOTO_LAT) return null;
			if (level > photoMaxLevel(rect)) return "parent";
			if (level > 8) return {
				kind: "photo",
				rect,
				level,
				layer: "LRO_WAC_Mosaic_Global_303ppd_v02",
				minTrueLat: FIX_MIN_TRUE_LAT,
				fix: b.fix
			};
			return {
				kind: "synth",
				rect,
				level,
				fix: b.fix
			};
		}
	});
}
/**
* Get south-polar pictures ready before they are shown: the worker downloads (from the browser's cache, start-up put
* them there) and decodes them now, so the first time a layer is switched on its tiles appear at once.
*/
export function warmPolarRasters(urls) {
	if (!urls.length) return;
	workers().tell(0, { warmRasters: urls.map((u) => new URL(u, document.baseURI).href) });
}
const absoluteScienceSource = (source) => ({
	...source,
	url: new URL(source.url, document.baseURI).href
});
/** Finish decoding before the start screen closes, rather than only filling the HTTP cache. */
export function warmScienceRasters(sources, onProgress) {
	const unique = [...new Map(sources.map((s) => [new URL(s.url, document.baseURI).href, absoluteScienceSource(s)])).values()];
	return workers().warmScience(unique, onProgress);
}
/** Raw byte under a spot; the left panel applies the product's published scale and offset. */
export function scienceRasterValueAt(source, lat, lon) {
	return workers().scienceValue(absoluteScienceSource(source), lat, lon);
}
/** A few ready display tiles make the first painted frame independent of a worker round trip. */
class ScienceRasterProvider extends ReprojectedImageryProvider {
	prepared = new Map();
	requestImage(x, y, level, request) {
		const key = `${level}/${x}/${y}`;
		let picture = this.prepared.get(key);
		if (!picture) {
			const got = super.requestImage(x, y, level, request);
			if (!got) return undefined;
			picture = got;
			this.prepared.set(key, got);
			void got.catch(() => {
				if (this.prepared.get(key) === got) this.prepared.delete(key);
			});
			// 16 MB per provider at most; an old off-screen tile is cheap to draw again from the decoded source.
			while (this.prepared.size > 64) {
				const [old, bitmap] = this.prepared.entries().next().value;
				this.prepared.delete(old);
				void bitmap.then((b) => {
					if (b !== blank && b !== parentMark) setTimeout(() => b.close(), 2e3);
				}).catch(() => {});
			}
		} else {
			this.prepared.delete(key);
			this.prepared.set(key, picture);
		}
		return picture.then((b) => b === parentMark ? b : createImageBitmap(b));
	}
	noteGaps() {
		this.prepared.clear();
		super.noteGaps();
	}
	reloadNow() {
		this.prepared.clear();
		super.reloadNow();
	}
}
/** One switch can combine a global map and sharper maps near either pole. Later sources lie on top. */
export function createScienceRasterProvider(o) {
	const sources = o.sources.map(absoluteScienceSource);
	return new ScienceRasterProvider({
		rectangle: Rectangle.MAX_VALUE,
		maximumLevel: o.maximumLevel ?? 10,
		credit: o.credit,
		worker: workers().scienceWorker,
		isLocal: () => true,
		jobFor: (rect, level) => {
			const range = tileTrueLatRange(rect);
			const touches = sources.some((s) => s.projection === "global" || (s.pole === "north" ? range.maxDeg >= (s.clipTrueLatDeg ?? 80) - pixelDeg(level) : range.minDeg <= (s.clipTrueLatDeg ?? -80) + pixelDeg(level)));
			return touches ? {
				kind: "science",
				rect,
				level,
				sources
			} : null;
		}
	});
}
/**
* One local south-polar-stereographic picture (x = rho·sin(lon), y = rho·cos(lon), ±extentM,
* row 0 = +y). Without `clipTrueLatDeg` (the polar photo) it fades out softly (over 40 km, ending at 80°S) into the
* Moon Trek photo below; with it (science maps) the edge is a crisp line at that latitude.
*/
export function createPolarRasterProvider(o) {
	const clip = o.clipTrueLatDeg ?? POLAR_LIMIT_DEG;
	const featherM = o.clipTrueLatDeg === undefined ? POLAR_FEATHER_M : 0;
	const url = new URL(o.url, document.baseURI).href;
	return new ReprojectedImageryProvider({
		rectangle: polarRectangle(clip),
		maximumLevel: o.maximumLevel ?? 9,
		credit: o.credit,
		worker: 0,
		jobFor: (rect, level) => tileTrueLatRange(rect).minDeg >= clip + pixelDeg(level) ? null : {
			kind: "raster",
			rect,
			level,
			url,
			extentM: o.extentM,
			clipTrueLat: clip,
			featherM
		}
	});
}
/**
* Sharp south-polar photos (the LROC mosaics served by ASU Lunaserv, the server behind QuickMap):
* square polar tiles, level k = the 608 km square split 2^k x 2^k, k up to 10 (~1.2 m per pixel).
* Only tiles that need k >= minK are drawn; coarser views use the local polar photo underneath.
*
* Local first: the squares stored with the app (folder `local`, default ./data/polar/t/, listed
* in its index.json by data-prep/polar_tiles.py) are read from disk; Lunaserv is only asked for
* squares that are not stored. Pass `local: null` to always use the remote server. Where the
* photos have no finer detail (outside 84 deg S only the 100 m WAC mosaic exists) tiles stop at
* the level that shows it all and deeper ones keep their parent.
*/
export function createPolarPyramidProvider(o) {
	let maximumLevel = 0;
	while (pyramidLevelFor(maximumLevel) < PYRAMID_MAX_K) maximumLevel++;
	const worker = workers().route("pyramid");
	// Which squares are stored with the app? Read the list once and hand it to the worker before the first job.
	let local = null, index = null, listed = true;
	if (o.local !== null && typeof document !== "undefined") {
		const folder = local = new URL(o.local ?? "./data/polar/t/", document.baseURI).href.replace(/\/?$/, "/");
		listed = false;
		const read = (triesLeft) => fetch(`${folder}index.json`).then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))).then((json) => {
			const ix = parsePyramidIndex(json);
			if (ix && ix.layers === o.layers) {
				index = ix;
				workers().tell(worker, {
					pyramidIndex: json,
					base: folder
				});
			} else console.warn(`Stored south-pole photos not used: they are for "${ix?.layers ?? "an unknown layer set"}", this layer asks for "${o.layers}".`);
		}).catch((e) => triesLeft > 0 ? new Promise((res) => setTimeout(res, 1500)).then(() => read(triesLeft - 1)) : console.warn("No list of stored south-pole photos, using the remote server only:", e));
		void read(1).finally(() => {
			listed = true;
		});
	}
	return new ReprojectedImageryProvider({
		rectangle: polarRectangle(POLAR_LIMIT_DEG),
		maximumLevel,
		credit: o.credit,
		worker,
		isLocal: (job) => pyramidSurelyLocal(index, job.rect, job.level),
		jobFor: (rect, level) => {
			if (pyramidLevelFor(level) < o.minK || tileTrueLatRange(rect).minDeg >= POLAR_LIMIT_DEG + pixelDeg(level)) return null;
			if (pyramidParentIsEnough(rect, level)) return "parent";
			if (!listed) return "wait";
			return {
				kind: "pyramid",
				rect,
				level,
				layers: o.layers,
				minK: o.minK,
				local
			};
		}
	});
}

//# sourceMappingURL=data:application/json;base64,eyJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBc0VBLFNBQVMsWUFBWSxZQUFZLGNBQWMsUUFBUSxPQUFPLHdCQUF3QixXQUFXLG9CQUFpQztBQUNsSSxTQUFTLHNCQUFzQjtBQUMvQixTQUNFLGtCQUFrQixpQkFBaUIsaUJBQWlCLGlCQUFpQixlQUFlLFVBQVUsTUFBTSxtQkFBbUIsVUFBVSxpQkFBaUIsdUJBQ2xKLG9CQUFvQixjQUFjLGtCQUFrQixlQUFlLG1CQUU5RDs7Ozs7Ozs7QUFXUCxNQUFNLGVBQWU7QUFDckIsTUFBTSxjQUFjO0FBQ3BCLE1BQU0sY0FBYzs7QUFHcEIsTUFBTSx1QkFBdUIsV0FBVztBQUN4QyxNQUFNLDJCQUEyQjtBQUNqQyxNQUFNLHdCQUF3QjtBQUM5QixNQUFNLHdCQUF3QixLQUFLOzs7Ozs7QUFPbkMsT0FBTyxNQUFNLGtCQUFrQixJQUFJLE1BQU07QUFFekMsU0FBUyxXQUF3QjtDQUMvQixNQUFNLElBQUksSUFBSSxnQkFBZ0IsR0FBRyxDQUFDO0NBQ2xDLEVBQUUsV0FBVyxJQUFJO0NBQ2pCLE9BQU8sRUFBRSxzQkFBc0I7QUFDakM7O0FBR0EsSUFBSTtBQUNKLE1BQU0sa0JBQW1CLFVBQVUsU0FBUzs7Ozs7O0FBTzVDLElBQUk7QUFDSixNQUFNLHlCQUEwQixlQUFlLFNBQVM7QUFDeEQsTUFBTSxnQkFBZ0I7Q0FBRSxlQUFlO0NBQU0scUJBQXFCLFVBQW1CLFVBQVUsYUFBYSxVQUFVO0FBQVc7Ozs7OztBQU9qSSxlQUFlLG1CQUFxQztDQUNsRCxJQUFJO0VBQ0YsTUFBTSxTQUFTLFNBQVMsY0FBYyxRQUFRO0VBQzlDLE9BQU8sUUFBUSxPQUFPLFNBQVM7RUFDL0IsTUFBTSxLQUFLLE9BQU8sV0FBVyxTQUFTO0dBQUUsV0FBVztHQUFPLE9BQU87R0FBTyxTQUFTO0VBQU0sQ0FBQztFQUN4RixJQUFJLENBQUMsSUFBSSxPQUFPO0VBQ2hCLE1BQU0sTUFBTSxNQUFNLGtCQUFrQixJQUFJLFVBQVUsSUFBSSxrQkFBa0I7R0FBQztHQUFLO0dBQUc7R0FBRztHQUFLO0dBQUc7R0FBRztHQUFLO0VBQUcsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLEVBQUUsa0JBQWtCLE9BQU8sQ0FBQztFQUM5SSxNQUFNLE1BQU0sR0FBRyxjQUFjO0VBQzdCLEdBQUcsWUFBWSxHQUFHLFlBQVksR0FBRztFQUNqQyxHQUFHLFlBQVksR0FBRyxxQkFBcUIsSUFBSTtFQUMzQyxHQUFHLFdBQVcsR0FBRyxZQUFZLEdBQUcsR0FBRyxNQUFNLEdBQUcsTUFBTSxHQUFHLGVBQWUsR0FBRztFQUN2RSxHQUFHLGNBQWMsR0FBRyxZQUFZLEdBQUcsb0JBQW9CLEdBQUcsT0FBTztFQUNqRSxHQUFHLGdCQUFnQixHQUFHLGFBQWEsR0FBRyxrQkFBa0IsQ0FBQztFQUN6RCxHQUFHLHFCQUFxQixHQUFHLGFBQWEsR0FBRyxtQkFBbUIsR0FBRyxZQUFZLEtBQUssQ0FBQztFQUNuRixNQUFNLEtBQUssSUFBSSxXQUFXLENBQUM7RUFDM0IsR0FBRyxXQUFXLEdBQUcsR0FBRyxHQUFHLEdBQUcsR0FBRyxNQUFNLEdBQUcsZUFBZSxFQUFFO0VBQ3ZELElBQUksTUFBTTtFQUNWLEdBQUcsYUFBYSxvQkFBb0IsQ0FBQyxFQUFFLFlBQVk7RUFDbkQsT0FBTyxHQUFHLEtBQUssR0FBRztDQUNwQixRQUFRO0VBQ04sT0FBTztDQUNUO0FBQ0Y7QUFFQSxNQUFNLGVBQWU7Q0FDbkIsQUFBaUIsVUFBNkIsQ0FBQztDQUMvQyxBQUFpQixPQUFpQixDQUFDO0NBQ25DLEFBQWlCLFFBQWtCLENBQUM7Q0FDcEMsQUFBaUIsT0FBTyxJQUFJLElBQW9OOzs7Ozs7Q0FNaFAsQUFBUyxRQUFRO0VBQUUsT0FBTztFQUFHLFVBQVU7RUFBRyxTQUFTO0VBQUcsVUFBVTtFQUFHLFdBQVc7RUFBRyxTQUFTO0VBQUcsV0FBVztFQUFHLFFBQVE7RUFBRyxTQUFTO0VBQUcsT0FBTztFQUFHLFFBQVE7RUFBRyxRQUFRO0VBQUcsY0FBYztFQUFHLGVBQWU7RUFBRyxRQUFRLENBQUM7RUFBeUMsU0FBUyxDQUFDO0VBQTZCLFNBQVMsQ0FBQztDQUF3QztDQUNoVixBQUFpQixNQUFrQyxDQUFDO0NBQ3BELEFBQWlCLFVBQWdELENBQUM7Q0FDbEUsQUFBaUIsT0FBTyxpQkFBaUI7Q0FDekMsQUFBaUIsU0FBUyxJQUFJLElBQW9COztDQUVsRCxBQUFpQixTQUFTLElBQUksSUFBZ0M7Q0FDOUQsQUFBUSxTQUFTO0NBQ2pCLEFBQWlCLGNBQWMsSUFBSSxJQUFtRjtDQUN0SCxBQUFpQixnQkFBZ0IsSUFBSSxJQUE0QztDQUNqRixBQUFTO0NBQ1QsQUFBUztDQUVULGNBQWM7RUFDWixNQUFNLFFBQVEsVUFBVSx1QkFBdUI7RUFDL0MsS0FBSyxhQUFhLFNBQVMsSUFBSSxJQUFJO0VBQ25DLEtBQUssZ0JBQWdCLEtBQUssYUFBYTtFQUN2QyxLQUFLLElBQUksSUFBSSxHQUFHLEtBQUssS0FBSyxlQUFlLEtBQUs7R0FDNUMsTUFBTSxJQUFJLElBQUksT0FBTyxJQUFJLElBQUksc0JBQXNCLFlBQVksR0FBRyxHQUFHLEVBQUUsTUFBTSxTQUFTLENBQUM7R0FDdkYsRUFBRSxhQUFhLE1BQWdDLEtBQUssT0FBTyxFQUFFLE1BQU0sQ0FBQztHQUNwRSxFQUFFLFdBQVUsTUFBSyxLQUFLLEtBQUssR0FBRyxDQUFDO0dBQy9CLEtBQUssUUFBUSxLQUFLLENBQUM7R0FDbkIsS0FBSyxLQUFLLEtBQUssQ0FBQztHQUNoQixLQUFLLE1BQU0sS0FBSyxDQUFDO0dBQ2pCLEtBQUssSUFBSSxLQUFLO0lBQUM7SUFBRztJQUFHO0dBQUMsQ0FBQzs7R0FFdkIsRUFBRSxZQUFZLEVBQUUsbUJBQW1CLE1BQU0sS0FBSyxnQkFBZ0IsTUFBTSxNQUFNLElBQUksTUFBTSxNQUFNLElBQUksS0FBSyxNQUFNLEtBQUssR0FBRyxDQUFvQjtFQUN2STtFQUNBLGlCQUFpQixnQkFBZ0I7R0FDL0IsTUFBTSxNQUFnQixFQUFFLGdCQUFnQixLQUFLO0dBQzdDLEtBQUssTUFBTSxLQUFLLEtBQUssU0FBUyxHQUFHLFlBQVksR0FBRztHQUNoRCxLQUFLLE1BQU0sS0FBSyxLQUFLLFFBQVEsRUFBRSxZQUFZO0VBQzdDLENBQUM7Q0FDSDs7Q0FHQSxNQUFNLFFBQXdCO0VBQzVCLElBQUksSUFBSSxLQUFLLE9BQU8sSUFBSSxNQUFNO0VBQzlCLElBQUksTUFBTSxXQUFXLEtBQUssT0FBTyxJQUFJLFFBQVEsSUFBSSxJQUFLLEtBQUssT0FBTyxPQUFPLEtBQUssVUFBVztFQUN6RixPQUFPO0NBQ1Q7Ozs7OztDQU9BLElBQUksUUFBZ0IsS0FBVSxPQUFtQyxRQUFRLE9BQU8sU0FBNEQ7RUFDMUksTUFBTSxJQUFJLEtBQUssUUFBUTtFQUN2QixJQUFJLENBQUMsR0FBRyxPQUFPLFFBQVEsUUFBUSxVQUFVLENBQUM7RUFDMUMsTUFBTSxRQUFRLFFBQVEsS0FBSyxRQUFRLEtBQUs7RUFDeEMsSUFBSSxNQUFNLFlBQVksUUFBUSxjQUFjLFdBQVcsSUFBSSxlQUFlLGNBQWM7R0FBRSxLQUFLLE1BQU07R0FBVyxPQUFPO0VBQVc7RUFDbEksTUFBTSxPQUFPO0VBQ2IsS0FBSyxNQUFNO0VBQ1gsS0FBSyxNQUFNLFFBQVEsSUFBSSxRQUFRLEtBQUssSUFBSSxLQUFLLE1BQU0sUUFBUSxJQUFJLFNBQVMsR0FBRyxJQUFJLEtBQUs7RUFDcEYsTUFBTSxLQUFLLEtBQUs7RUFDaEIsT0FBTyxJQUFJLFNBQVMsTUFBTSxXQUFXO0dBQ25DLEtBQUssS0FBSyxJQUFJLElBQUk7SUFBRTtJQUFRO0lBQU87SUFBTTtJQUFRO0lBQVMsSUFBSSxZQUFZLElBQUk7SUFBRyxNQUFNLElBQUk7SUFBTTtJQUFPLE1BQU0sSUFBSTtHQUFLLENBQUM7R0FDeEgsSUFBSSxTQUFTO0lBQ1gsTUFBTSxXQUFXLFFBQVE7SUFDekIsUUFBUSx1QkFBdUI7S0FBRSxXQUFXO0tBQUcsS0FBSyxPQUFPLEVBQUU7SUFBRzs7O0lBR2hFLE1BQU0sU0FBUyxRQUFRO0lBQ3ZCLElBQUksUUFBUSxRQUFRLGVBQWU7S0FBRSxPQUFPLEtBQUssT0FBTztLQUFHLEtBQUssT0FBTyxFQUFFO0lBQUc7SUFDNUUsSUFBSSxRQUFRLFdBQVcsS0FBSyxPQUFPLEVBQUU7R0FDdkM7R0FDQSxLQUFLLEtBQUssS0FBSyxNQUFLLGFBQVk7SUFBRSxJQUFJLEtBQUssS0FBSyxJQUFJLEVBQUUsR0FBRztLQUFFLE1BQU0sTUFBZ0I7TUFBRTtNQUFJO01BQUs7S0FBUztLQUFHLEVBQUUsWUFBWSxHQUFHO0lBQUc7R0FBRSxDQUFDO0VBQ2pJLENBQUM7Q0FDSDtDQUVBLEFBQVEsT0FBTyxJQUFZO0VBQ3pCLE1BQU0sSUFBSSxLQUFLLEtBQUssSUFBSSxFQUFFO0VBQzFCLElBQUksQ0FBQyxHQUFHO0VBQ1IsS0FBSyxLQUFLLE9BQU8sRUFBRTtFQUNuQixDQUFDLEVBQUUsUUFBUSxLQUFLLFFBQVEsS0FBSyxLQUFJLENBQUUsRUFBRSxPQUFPO0VBQzVDLEtBQUssTUFBTTtFQUNYLEtBQUssUUFBUSxFQUFFLE9BQU8sRUFBRSxZQUFZLEVBQUUsUUFBUSxHQUFHLENBQW9CO0VBQ3JFLElBQUksRUFBRSxTQUFTOztHQUViLEVBQUUsUUFBUSxRQUFRLGFBQWE7R0FDL0IsRUFBRSxPQUFPLElBQUksYUFBYSxzQkFBc0IsWUFBWSxDQUFDO0VBQy9ELE9BQU8sRUFBRSxLQUFLLGlCQUFpQixDQUFDO0NBQ2xDO0NBRUEsY0FBYyxZQUE2QjtFQUN6QyxNQUFNLE1BQU0sWUFBWSxJQUFJO0VBQzVCLEtBQUssTUFBTSxDQUFDLElBQUksTUFBTSxLQUFLLE1BQU07R0FDL0IsSUFBSSxFQUFFLFNBQVMsV0FBVyxNQUFNLEVBQUUsS0FBSyxLQUFLO0dBQzVDLElBQUksQ0FBQyxXQUFXLE1BQUssTUFBSyxrQkFBa0IsRUFBRSxNQUFNLENBQUMsQ0FBQyxHQUFHLEtBQUssT0FBTyxFQUFFO0VBQ3pFO0NBQ0Y7O0NBR0EsS0FBSyxRQUFnQixLQUFlO0VBQUUsS0FBSyxRQUFRLE9BQU8sRUFBRSxZQUFZLEdBQUc7Q0FBRztDQUU5RSxZQUFZLFNBQWdDLFVBQXFEO0VBQy9GLElBQUksQ0FBQyxLQUFLLFFBQVEsS0FBSyxnQkFBZ0IsT0FBTyxRQUFRLFFBQVEsS0FBSztFQUNuRSxNQUFNLFNBQVMsS0FBSztFQUNwQixPQUFPLElBQUksU0FBUSxZQUFXO0dBQzVCLEtBQUssWUFBWSxJQUFJLFFBQVE7SUFBRTtJQUFTO0dBQVMsQ0FBQztHQUNsRCxLQUFLLEtBQUssS0FBSyxlQUFlO0lBQUUsYUFBYTtJQUFTO0dBQU8sQ0FBQztFQUNoRSxDQUFDO0NBQ0g7Q0FFQSxhQUFhLFFBQTZCLEtBQWEsS0FBcUM7RUFDMUYsSUFBSSxDQUFDLEtBQUssUUFBUSxLQUFLLGdCQUFnQixPQUFPLFFBQVEsUUFBUSxJQUFJO0VBQ2xFLE1BQU0sVUFBVSxLQUFLO0VBQ3JCLE9BQU8sSUFBSSxTQUFRLFlBQVc7R0FDNUIsS0FBSyxjQUFjLElBQUksU0FBUyxPQUFPO0dBQ3ZDLEtBQUssS0FBSyxLQUFLLGVBQWU7SUFBRSxjQUFjO0tBQUU7S0FBUTtLQUFLO0lBQUk7SUFBRztHQUFRLENBQUM7RUFDL0UsQ0FBQztDQUNIO0NBRUEsQUFBUSxPQUFPLEVBQUUsSUFBSSxRQUFRLE1BQU0sV0FBVyxRQUFRLEtBQUssU0FBUyxPQUFPLFFBQVEsVUFBVSxRQUFRLFNBQVMsU0FBcUIsUUFBZ0I7RUFDakosSUFBSSxPQUFPO0dBQ1QsS0FBSyxNQUFNLE9BQU8sVUFBVTtHQUM1QixLQUFLLE1BQU0sZUFBZSxLQUFLLE1BQU0sT0FBTyxRQUFRLEdBQUcsTUFBTSxLQUFLLEdBQUcsaUJBQWlCLElBQUksQ0FBQztHQUMzRixLQUFLLE1BQU0sZ0JBQWdCLEtBQUssTUFBTSxPQUFPLFFBQVEsR0FBRyxNQUFNLEtBQUssR0FBRyxpQkFBaUIsSUFBSSxDQUFDO0VBQzlGO0VBQ0EsSUFBSSxXQUFXLFdBQVc7R0FDeEIsTUFBTSxNQUFNLEtBQUssWUFBWSxJQUFJLE1BQU07R0FDdkMsS0FBSyxXQUFXLFlBQVksQ0FBQztHQUM3QixJQUFJLGFBQWEsR0FBRztJQUFFLEtBQUssWUFBWSxPQUFPLE1BQU07SUFBRyxLQUFLLFFBQVEsV0FBVyxLQUFLO0dBQUc7R0FDdkY7RUFDRjtFQUNBLElBQUksWUFBWSxXQUFXO0dBQUUsS0FBSyxjQUFjLElBQUksT0FBTyxDQUFDLEdBQUcsU0FBUyxJQUFJO0dBQUcsS0FBSyxjQUFjLE9BQU8sT0FBTztHQUFHO0VBQVE7RUFDM0gsSUFBSSxTQUFTO0dBQ1gsS0FBSyxRQUFRLFVBQVU7R0FDdkIsTUFBTSxTQUE2QyxDQUFDO0dBQ3BELEtBQUssTUFBTSxVQUFVLEtBQUssU0FBUyxJQUFJLFFBQVEsS0FBSyxNQUFNLENBQUMsTUFBTSxNQUFNLE9BQU8sUUFBUSxNQUFNLEdBQUc7SUFDN0YsTUFBTSxJQUFJLE9BQU8sVUFBVTtLQUFFLFVBQVU7S0FBRyxPQUFPO0lBQUU7SUFBRyxFQUFFLFlBQVksRUFBRTtJQUFVLEVBQUUsU0FBUyxFQUFFO0dBQy9GO0dBQ0EsS0FBSyxNQUFNLFVBQVU7RUFDdkI7RUFDQSxJQUFJLFdBQVc7UUFBSyxNQUFNLEtBQUssS0FBSyxRQUFRLElBQUksRUFBRSxXQUFXLFFBQVEsRUFBRSxZQUFZO0VBQUM7RUFDcEYsSUFBSSxLQUFLO0dBQ1AsS0FBSyxJQUFJLFVBQVU7R0FDbkIsS0FBSyxNQUFNLFFBQVEsS0FBSyxNQUFNLFNBQVMsS0FBSyxNQUFNLFNBQVM7R0FDM0QsS0FBSyxNQUFNLEtBQUssS0FBSyxLQUFLO0lBQUUsS0FBSyxNQUFNLFNBQVMsRUFBRTtJQUFJLEtBQUssTUFBTSxVQUFVLEVBQUU7SUFBSSxLQUFLLE1BQU0sVUFBVSxFQUFFO0dBQUk7RUFDOUc7RUFDQSxNQUFNLElBQUksS0FBSyxLQUFLLElBQUksRUFBRTtFQUMxQixJQUFJLENBQUMsR0FBRztHQUFFLFFBQVEsTUFBTTtHQUFHO0VBQVE7RUFDbkMsS0FBSyxLQUFLLE9BQU8sRUFBRTtFQUNuQixDQUFDLEVBQUUsUUFBUSxLQUFLLFFBQVEsS0FBSyxLQUFJLENBQUUsRUFBRSxPQUFPO0VBQzVDLE1BQU0sS0FBSyxZQUFZLElBQUksSUFBSSxFQUFFO0VBQ2pDLEtBQUssTUFBTTtFQUFZLEtBQUssTUFBTSxTQUFTO0VBQUksS0FBSyxNQUFNLFdBQVc7RUFBSSxLQUFLLE1BQU0sWUFBWSxLQUFLLElBQUksS0FBSyxNQUFNLFdBQVcsRUFBRTtFQUNqSSxJQUFJLE1BQU07R0FDUixLQUFLLE9BQU8sSUFBSSxFQUFFLEtBQUs7R0FBRyxFQUFFLE1BQU0sU0FBUztHQUMzQyxJQUFJLEVBQUUsU0FBUyxRQUFRLFVBQVU7OztHQUdqQyxJQUFJLEVBQUUsU0FBUyxTQUFTLHdCQUF3QixZQUFZLElBQUksSUFBSTtFQUN0RTtFQUNBLElBQUksUUFBUSxLQUFLLE1BQU07RUFDdkIsRUFBRSxLQUFLLFNBQVMsaUJBQWlCLElBQUksVUFBVSxVQUFVLENBQUM7Q0FDNUQ7O0NBR0EsVUFBa0I7RUFBRSxPQUFPLEtBQUssS0FBSztDQUFNO0NBRTNDLGdCQUF3QjtFQUFFLElBQUksSUFBSTtFQUFHLEtBQUssTUFBTSxLQUFLLEtBQUssS0FBSyxPQUFPLEdBQUcsSUFBSSxFQUFFLFNBQVMsU0FBUztFQUFLLE9BQU87Q0FBRzs7Q0FHaEgsVUFBMEQ7RUFDeEQsTUFBTSxNQUFNLFlBQVksSUFBSTtFQUM1QixPQUFPLENBQUMsR0FBRyxLQUFLLEtBQUssT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFJLE9BQU07R0FBRSxNQUFNLEVBQUU7R0FBTSxRQUFRLEVBQUU7R0FBUSxJQUFJLEtBQUssTUFBTSxNQUFNLEVBQUUsRUFBRTtFQUFFLEVBQUU7Q0FDMUc7O0NBR0EsUUFBUSxHQUErQjtFQUFFLEtBQUssT0FBTyxPQUFPLENBQUM7Q0FBRzs7Q0FHaEUsQUFBUSxLQUFLLFFBQWdCLEdBQWU7RUFDMUMsUUFBUSxNQUFNLDJCQUEyQixFQUFFLE9BQU87RUFDbEQsS0FBSyxRQUFRLE9BQU8sRUFBRSxVQUFVO0VBQ2hDLEtBQUssUUFBUSxVQUFVO0VBQ3ZCLEtBQUssTUFBTSxDQUFDLElBQUksTUFBTSxLQUFLLE1BQU0sSUFBSSxFQUFFLFdBQVcsUUFBUTtHQUFFLEtBQUssS0FBSyxPQUFPLEVBQUU7R0FBRyxFQUFFLEtBQUssVUFBVSxDQUFDO0VBQUc7RUFDdkcsS0FBSyxLQUFLLFVBQVUsS0FBSyxNQUFNLFVBQVU7Q0FDM0M7QUFDRjtBQUVBLElBQUk7QUFDSixNQUFNLGdCQUFpQixTQUFTLElBQUksZUFBZTs7QUFHbkQsTUFBTSxxQkFBcUIsR0FBUyxNQUFZLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFO0FBT3ZILElBQUk7QUFDSixJQUFJO0FBQ0osSUFBSSx3QkFBd0I7QUFDNUIsTUFBTSxpQkFBaUIsSUFBSSxJQUF1RDtBQUNsRixNQUFNLGlCQUFpQixJQUFJLElBQVk7QUFDdkMsTUFBTSxhQUFhLElBQUksdUJBQXVCLEVBQUUsV0FBVyxlQUFlLENBQUM7QUFDM0UsTUFBTSxZQUFZLElBQUksV0FBVyxHQUFHLFVBQVUsSUFBSSxXQUFXLEdBQUcsbUJBQW1CLElBQUksYUFBYSxHQUFHLGdCQUFnQixJQUFJLFdBQVc7QUFDdEksTUFBTSxZQUFZLEdBQVMsVUFBa0IsR0FBRyxNQUFNLEdBQUcsRUFBRSxLQUFLLEdBQUcsRUFBRTtBQUNyRSxNQUFNLGNBQWMsR0FBVyxJQUFZLE9BQWUsS0FBSyxJQUFJLElBQUksS0FBSyxJQUFJLElBQUksQ0FBQyxDQUFDO0FBQ3RGLE1BQU0sa0JBQWtCLFdBQW1CLFdBQVcsS0FBSyxNQUFNLEtBQUssS0FBSyxZQUFZLENBQUMsSUFBSSxLQUFLLElBQUksTUFBTyxNQUFNLENBQUMsQ0FBQyxHQUFHLEdBQUcsRUFBRTs7O0FBSTVILFNBQVMsZ0JBQWdCLFFBQWdCO0NBQ3ZDLE1BQU0sRUFBRSxPQUFPLFdBQVcsUUFBUSxRQUFRLE1BQU07Q0FDaEQsTUFBTSxVQUFVLE9BQU87Q0FDdkIsTUFBTSxPQUFPLFFBQVEsUUFBUSxRQUFRO0NBQ3JDLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxxQkFBcUI7Q0FDekMsVUFBVSxJQUFJLE1BQU0sT0FBTyxjQUFjO0NBQUcsVUFBVSxJQUFJLE1BQU0sT0FBTyxlQUFlO0NBQ3RGLE1BQU0sTUFBTSxPQUFPLFdBQVcsU0FBUyxHQUFHLE1BQU0sT0FBTyxNQUFNLEtBQUssS0FBSyxPQUFPLE9BQU87Q0FDckYsTUFBTSxXQUFXLE9BQU87Q0FDeEIsSUFBSSxNQUFNLFNBQVMsV0FBVyxNQUFNLFNBQVM7Q0FDN0MsSUFBSSxlQUFlLE1BQU0sVUFBVSxRQUFRLEtBQUs7Q0FDaEQsSUFBSSxXQUFXLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxTQUFTLFNBQVMsWUFBWSxDQUFDO0NBQ25FLElBQUksS0FBSztFQUNQLE1BQU0sS0FBSyxlQUFlLHdCQUF3QixLQUFLLGdCQUFnQjtFQUN2RSxJQUFJLElBQUk7R0FBRSxNQUFNLEdBQUc7R0FBVyxNQUFNLEdBQUc7R0FBVSxlQUFlLEdBQUc7RUFBUTtFQUMzRSxXQUFXLEtBQUssSUFBSSxHQUFHLFdBQVcsU0FBUyxPQUFPLFlBQVksR0FBRyxDQUFDO0NBQ3BFO0NBQ0EsTUFBTSxvQkFBb0IsSUFBSSxLQUFLLElBQUksT0FBTyxDQUFDLElBQUksTUFBTSwwQkFBMEIsTUFBTTtDQUN6RixJQUFJLFFBQVEsZUFBZSxXQUFXLGlCQUFpQjtDQUN2RCxNQUFNLEtBQUssV0FBVyxpQkFBaUIsSUFBSSxhQUFhLEtBQUssR0FBRyxHQUFHLEtBQUs7Q0FDeEUsSUFBSSxJQUFJLFFBQVEsS0FBSyxJQUFJLE9BQU8sY0FBYyxXQUFXLGtCQUFrQixHQUFHLEdBQUcsR0FBRyxHQUFHLEtBQUssQ0FBQyxDQUFDO0NBQzlGLE1BQU0sTUFBTSxXQUFXLE1BQU0sWUFBWSxJQUFJO0NBQzdDLE1BQU0sVUFBVSxDQUFDLE9BQU8sSUFBSSxVQUFVLFNBQVMsV0FBVyxnQkFBZ0IsSUFBSSxRQUFRLE9BQU8sVUFBVSxJQUFJLEtBQUssSUFBSSxHQUFHLFdBQVcsV0FBVyxJQUFRLEtBQ2hKLEtBQUssSUFBSSxLQUFLLE1BQU0sS0FBSyxJQUFJLE1BQU0sSUFBSSxHQUFHLEdBQUcsS0FBSyxJQUFJLE1BQU0sSUFBSSxHQUFHLENBQUMsQ0FBQyxJQUFJLFNBQVMsS0FBSyxJQUFJLEtBQUssS0FBSyxPQUNyRyxLQUFLLElBQUksTUFBTSxJQUFJLEdBQUcsSUFBSSxTQUFTLEtBQUssSUFBSSxLQUFLLEtBQUs7Q0FDM0QsWUFBWTtFQUFFO0VBQUs7RUFBSztFQUFPLFdBQVcsU0FBUztFQUFXLFdBQVcsU0FBUztFQUFVO0VBQzFGLFFBQVEsV0FBVyxNQUFNLE9BQU8sVUFBVTtFQUFHO0VBQW1CLFdBQVcsVUFBVSxNQUFNLElBQUk7Q0FBVTtDQUMzRyxJQUFJLFNBQVM7RUFBRSxlQUFlLE1BQU07RUFBRyxlQUFlLE1BQU07Q0FBRztDQUMvRCxNQUFNLEtBQUssS0FBSyxNQUFNLE1BQU0sR0FBRyxFQUFFLFdBQVc7RUFBRTtFQUFLO0VBQUs7Q0FBTSxFQUFFLENBQUM7Q0FDakUsSUFBSSxRQUFRLElBQUk7RUFDZCxJQUFJLENBQUMsaUJBQWlCLGNBQWMsV0FBVyxRQUFRLGdCQUFnQjtHQUFFO0dBQVEsV0FBVyxNQUFNO0dBQWtCLFVBQVUsTUFBTTtFQUFnQjtPQUUvSSxJQUFJLE1BQU0sb0JBQW9CLE1BQU0saUJBQWlCO0dBQUUsY0FBYyxZQUFZLE1BQU07R0FBa0IsY0FBYyxXQUFXLE1BQU07RUFBaUI7RUFDOUosTUFBTSxtQkFBbUI7RUFBTyxNQUFNLGtCQUFrQjtDQUMxRCxPQUFPLElBQUksZUFBZSxXQUFXLFFBQVE7RUFDM0MsTUFBTSxtQkFBbUIsY0FBYztFQUFXLE1BQU0sa0JBQWtCLGNBQWM7RUFDeEYsZ0JBQWdCO0VBQVcsZUFBZSxNQUFNO0VBQUcsZUFBZSxNQUFNO0NBQzFFO0FBQ0Y7OztBQUlBLFNBQVMsV0FBVyxNQUFZLE9BQXdCO0NBQ3RELE1BQU0sT0FBTztDQUNiLElBQUksQ0FBQyxRQUFRLEtBQUssU0FBUyxNQUFNLFNBQVMsS0FBSyxZQUFZLElBQUksSUFBSSx1QkFBdUIsT0FBTztDQUNqRyxNQUFNLE1BQU0sU0FBUyxNQUFNLEtBQUs7Q0FDaEMsSUFBSSxlQUFlLElBQUksR0FBRyxHQUFHLE9BQU87Q0FDcEMsTUFBTSxVQUFVLEtBQUssT0FBTyxLQUFLLFFBQVE7Q0FDekMsTUFBTSxZQUFZLFNBQVMsS0FBSyxNQUFNLEtBQUssSUFBSSxLQUFLLFlBQVksTUFBTSxHQUFHLEtBQUssSUFBSSxLQUFLLFlBQVksTUFBTSxDQUFDO0NBQzFHLE1BQU0sTUFBTSxXQUFXLFdBQVcsS0FBSyxNQUFNLEtBQUssSUFBSSxHQUFHLE1BQU0sV0FBVyxLQUFLLFdBQVcsS0FBSyxPQUFPLEtBQUssS0FBSztDQUNoSCxXQUFXLFlBQVksS0FBSyxLQUFLLEtBQUssY0FBYyxnQkFBZ0IsYUFBYTtDQUNqRixNQUFNLFdBQVcsS0FBSyxJQUFJLEdBQUcsV0FBVyxTQUFTLEtBQUssUUFBUSxhQUFhLENBQUM7Q0FDNUUsTUFBTSxTQUFTLEtBQUssSUFBSSxLQUFLLE9BQU8sY0FBYyxJQUFJLEdBQUcsZUFBZSxXQUFXLEtBQUssaUJBQWlCLENBQUM7Q0FDMUcsSUFBSSxTQUFTLFFBQVEsT0FBTztDQUM1QixJQUFJLENBQUMsZUFBZSxJQUFJLEdBQUcsR0FBRyxlQUFlLElBQUksS0FBSztFQUFFO0VBQU07RUFBTyxJQUFJLFlBQVksSUFBSTtDQUFFLENBQUM7Q0FDNUYsSUFBSSxNQUFNLEtBQUssTUFBTTtDQUNyQixPQUFPO0FBQ1Q7Ozs7OztBQU9BLE9BQU8sU0FBUyx1QkFBdUIsUUFBZ0IsT0FBTyxNQUFNO0NBQ2xFLElBQUksQ0FBQyxRQUFRLE9BQU8sWUFBWSxHQUFHO0NBQ25DLGdCQUFnQixNQUFNO0NBQ3RCLE1BQU0sVUFBVyxPQUFPLE1BQU0sTUFBK0o7Q0FDN0wsTUFBTSxRQUFRLFNBQVM7Q0FDdkIsSUFBSSxPQUFPLFFBQVE7RUFDakIsSUFBSSxNQUFNLEtBQUssY0FBYyxNQUFNLEtBQUksU0FBUSxLQUFLLFNBQVMsQ0FBQzs7OztFQUk5RCxNQUFNLE1BQU0sWUFBWSxJQUFJO0VBQzVCLElBQUksYUFBYSxNQUFNLFVBQVUsWUFBWSxPQUFPLEtBQUssY0FBYyxNQUFNLEdBQUc7R0FDOUUsS0FBSyxNQUFNLFFBQVEsT0FBTyxLQUFLLE1BQU0sUUFBUSxLQUFLLE1BQU0sV0FBVyxDQUFDLEdBQUc7SUFDckUsTUFBTSxVQUFVLEtBQUs7SUFDckIsSUFBSSxDQUFDLFNBQVMsV0FBVztJQUN6QixNQUFNLE1BQU0sU0FBUyxRQUFRLFdBQVcsUUFBUSxLQUFLLEdBQUcsV0FBVyxlQUFlLElBQUksR0FBRztJQUN6RixJQUFJLFlBQVksTUFBTSxTQUFTLEtBQUssS0FBSztLQUFFLGVBQWUsSUFBSSxHQUFHO0tBQUcsZUFBZSxPQUFPLEdBQUc7S0FBRyxPQUFPLE1BQU0sY0FBYztJQUFHO0dBQ2hJO0VBQ0Y7Q0FDRjtBQUNGOztBQUdBLE9BQU8sU0FBUyxpQkFBeUI7Q0FBRSxPQUFPLE9BQU8sS0FBSyxRQUFRLElBQUk7QUFBRzs7QUFHN0UsQUFBQyxXQUE2QyxrQkFBa0I7Q0FDOUQsU0FBUztDQUNULGFBQWMsT0FBTztFQUFFLEdBQUcsS0FBSztFQUFPLFNBQVMsRUFBRSxHQUFHLEtBQUssTUFBTSxRQUFRO0NBQUUsSUFBSTtDQUM3RSxlQUFnQixPQUFPLEtBQUssUUFBUSxJQUFJLENBQUM7Q0FDekMsWUFBYSxZQUFZO0VBQUUsS0FBSyxVQUFVO0VBQUssS0FBSyxVQUFVO0VBQUssT0FBTyxVQUFVO0VBQU8sVUFBVSxlQUFlO0VBQU0sVUFBVSxlQUFlO0NBQUssSUFBSTtBQUM5SjtBQXNCQSxPQUFPLE1BQU0sMkJBQTJCO0NBQ3RDLEFBQVMsZUFBZSxJQUFJLHVCQUF1QixFQUFFLFdBQVcsZUFBZSxDQUFDO0NBQ2hGLEFBQVM7Q0FDVCxBQUFTLFlBQVk7Q0FDckIsQUFBUyxhQUFhO0NBQ3RCLEFBQVMsZUFBZTtDQUN4QixBQUFTOztDQUVULEFBQVMsb0JBQW9CO0NBQzdCLEFBQVMsYUFBYSxJQUFJLE1BQU07Q0FDaEMsQUFBUztDQUNULEFBQVMsUUFBUTtDQUNqQixBQUFTLGtCQUFrQjs7Q0FFM0IsVUFBb0M7Q0FDcEMsQUFBUztDQUNULEFBQWlCO0NBQ2pCLEFBQWlCO0NBQ2pCLEFBQVEsT0FBTztDQUNmLEFBQVEsV0FBVztDQUNuQixBQUFRO0NBQ1IsQUFBUSxhQUFhLENBQUM7Q0FDdEIsQUFBUSxVQUFVO0NBRWxCLFlBQVksR0FBb0I7RUFDOUIsS0FBSyxZQUFZLEVBQUU7RUFDbkIsS0FBSyxlQUFlLEVBQUU7RUFDdEIsS0FBSyxTQUFTLElBQUksT0FBTyxFQUFFLE1BQU07RUFDakMsS0FBSyxTQUFTLEVBQUU7RUFDaEIsS0FBSyxTQUFTLEVBQUU7RUFDaEIsS0FBSyxVQUFVLEVBQUU7Q0FDbkI7Q0FFQSxpQkFBMkI7RUFBRSxPQUFPLENBQUM7Q0FBRztDQUV4QyxhQUFhLEdBQVcsR0FBVyxPQUFlLFNBQTREO0VBQzVHLE1BQU0sSUFBSSxLQUFLLGFBQWEsa0JBQWtCLEdBQUcsR0FBRyxLQUFLO0VBQ3pELE1BQU0sTUFBTSxLQUFLLE9BQU87R0FBRSxNQUFNLEVBQUU7R0FBTSxPQUFPLEVBQUU7R0FBTyxNQUFNLEVBQUU7R0FBTSxPQUFPLEVBQUU7RUFBTSxHQUFHLE9BQU8sR0FBRyxDQUFDO0VBQ25HLElBQUksUUFBUSxRQUFRLE9BQU87RUFDM0IsSUFBSSxRQUFRLFVBQVU7R0FBRSxRQUFRLENBQUMsQ0FBQyxNQUFNO0dBQVcsT0FBTyxRQUFRLFFBQVEsaUJBQWlCLENBQUM7RUFBRztFQUMvRixJQUFJLEtBQUssU0FBUyxXQUFXLFdBQVcsSUFBSSxNQUFNLEtBQUssR0FBRyxPQUFPO0VBQ2pFLE9BQU8sTUFBTSxRQUFRLENBQUMsQ0FBQyxJQUFJLEtBQUssUUFBUSxLQUFLLE1BQU0sS0FBSyxVQUFVLEdBQUcsS0FBSyxPQUFPLE9BQU8sSUFBSSxRQUFRLFFBQVEsVUFBVSxDQUFDO0NBQ3pIOztDQUdBLFlBQVk7RUFDVixJQUFJLENBQUMsS0FBSyxTQUFTO0VBQ25CLEtBQUssUUFBUTtFQUNiLGdCQUFnQixXQUFXO0NBQzdCO0NBRUEsZUFBMEI7RUFBRSxPQUFPO0NBQVc7O0NBRzlDLFdBQVc7RUFDVCxLQUFLLE9BQU87RUFDWixLQUFLLGVBQWUsb0JBQW9CO0NBQzFDOztDQUdBLGNBQWM7RUFDWixJQUFJLEtBQUssTUFBTSxLQUFLLGVBQWUsd0JBQXdCO0NBQzdEO0NBRUEsQUFBUSxlQUFlLE9BQWU7RUFDcEMsTUFBTSxNQUFNLFlBQVksSUFBSSxHQUFHLEtBQUssS0FBSyxJQUFJLE1BQU0sT0FBTyxLQUFLLGFBQWEsS0FBSyxPQUFPO0VBQ3hGLElBQUksTUFBTSxLQUFLLFVBQVU7RUFDekIsYUFBYSxLQUFLLFdBQVc7RUFDN0IsS0FBSyxXQUFXO0VBQ2hCLEtBQUssY0FBYyxpQkFBaUIsS0FBSyxPQUFPLEdBQUcsS0FBSyxHQUFHO0NBQzdEO0NBRUEsQUFBUSxTQUFTO0VBQ2YsTUFBTSxNQUFNLFlBQVksSUFBSTtFQUM1QixLQUFLLGNBQWM7RUFDbkIsS0FBSyxXQUFXOzs7RUFHaEIsS0FBSyxVQUFVLE1BQU0sS0FBSyxhQUFhLElBQUksS0FBSyxVQUFVLHdCQUF3QixLQUFLLElBQUksSUFBSSxLQUFLLFNBQVMscUJBQXFCO0VBQ2xJLEtBQUssYUFBYTtFQUNsQixLQUFLLE9BQU87RUFDWixRQUFRLENBQUMsQ0FBQyxRQUFRLElBQUk7RUFDdEIsSUFBSSxDQUFDLEtBQUssU0FBUztFQUNuQixLQUFLLFFBQVE7RUFDYixnQkFBZ0IsV0FBVztDQUM3QjtBQUNGOzs7Ozs7QUFPQSxTQUFTLGVBQWUsU0FBNEI7Q0FDbEQsTUFBTSxJQUFJLEtBQUssSUFBSSxJQUFJLEtBQUssVUFBVSxFQUFHO0NBQ3pDLE9BQU8sVUFBVSxZQUFZLEtBQUssR0FBRyxDQUFDLEdBQUcsS0FBSyxHQUFHLENBQUM7QUFDcEQ7QUFVQSxJQUFJOztBQUVKLE1BQU0sV0FBVyxJQUFJLElBQWdDOztBQUdyRCxTQUFTLFlBQVk7Q0FDbkIsSUFBSSxDQUFDLFdBQVcsUUFBUSxVQUFVLFVBQVU7Q0FDNUMsUUFBUSxRQUFRO0NBQ2hCLEtBQUssTUFBTSxLQUFLLFVBQVUsRUFBRSxVQUFVO0FBQ3hDO0FBRUEsU0FBUyxjQUFjLFFBQWdCLEdBQVksTUFBMEQ7Q0FDM0csTUFBTSxJQUFJO0NBQ1YsSUFBSSxDQUFDLEtBQUssT0FBTyxFQUFFLFNBQVMsWUFBWSxPQUFPLEVBQUUsVUFBVSxZQUFZLE9BQU8sRUFBRSxXQUFXLFlBQVksT0FBTyxFQUFFLFNBQVMsWUFBWSxPQUFPLEVBQUUsVUFBVSxZQUFZLE9BQU8sRUFBRSxVQUFVLFVBQVUsT0FBTztDQUN4TSxNQUFNLElBQUksTUFBTSxLQUFLLEVBQUUsT0FBTyxNQUFNO0VBQUUsS0FBSyxJQUFJLElBQUksRUFBRSxNQUFNLE1BQU0sQ0FBQyxDQUFDO0VBQU0sT0FBTyxFQUFFO0VBQU8sS0FBSyxFQUFFLE9BQU8sT0FBTztFQUFHLEtBQUssS0FBSyxFQUFFLFNBQVM7RUFBRyxNQUFNLEVBQUUsUUFBUTtFQUFNLE1BQU0sRUFBRSxTQUFTO0VBQU0sTUFBTSxLQUFLLElBQUksR0FBRyxLQUFLLEVBQUUsS0FBSyxDQUFDO0VBQUcsV0FBVyxFQUFFLGNBQWM7Q0FBSztDQUN4UCxPQUFPO0VBQUMsSUFBSTtFQUFJLElBQUk7RUFBSSxJQUFJO0VBQU0sSUFBSTtFQUFNLElBQUk7Q0FBSyxDQUFDLENBQUMsTUFBTSxPQUFPLFNBQVMsSUFBSSxNQUFNO0FBQ3pGOztBQUdBLFNBQVMsUUFBUSxHQUE0QixHQUFXLEdBQVcsT0FBK0I7Q0FDaEcsSUFBSSxDQUFDLEtBQUssUUFBUSxFQUFFLE9BQU8sT0FBTztDQUNsQyxNQUFNLE1BQU0sRUFBRSxRQUFRLE9BQU8sSUFBSSxLQUFLO0NBQ3RDLElBQUksRUFBRSxLQUFLLEtBQUssRUFBRSxLQUFLLEdBQUcsT0FBTztDQUNqQyxNQUFNLEtBQUssSUFBSSxFQUFFLEtBQUssR0FBRyxLQUFLLElBQUksRUFBRSxLQUFLO0NBQ3pDLElBQUksS0FBSyxLQUFLLEtBQUssTUFBTSxLQUFLLEtBQUssSUFBSSxFQUFFLFNBQVMsS0FBSyxLQUFLLElBQUksRUFBRSxNQUFNLE9BQU87Q0FDL0UsT0FBTztFQUFFLEtBQUssRUFBRTtFQUFLO0VBQUssSUFBSSxLQUFLO0VBQU0sSUFBSSxLQUFLO0VBQU0sTUFBTSxFQUFFO0VBQU0sV0FBVyxFQUFFO0NBQVU7QUFDL0Y7O0FBR0EsTUFBTSxjQUFjLEdBQVksR0FBVyxHQUFXLFVBQ3BELEVBQUUsVUFBVSxTQUFTLEVBQUUsT0FBTyxRQUFRLFFBQVEsRUFBRSxRQUFRLEdBQUcsR0FBRyxLQUFLLElBQUksUUFBUSxFQUFFLE9BQU8sR0FBRyxHQUFHLEtBQUssS0FBSyxRQUFRLEVBQUUsT0FBTyxHQUFHLEdBQUcsS0FBSzs7QUFHdEksU0FBUyxNQUFNLFFBQWdCLEdBQW1DO0NBQ2hFLE1BQU0sSUFBSTtDQUNWLE1BQU0sSUFBSSxHQUFHLFFBQVEsSUFBSSxHQUFHO0NBQzVCLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxPQUFPLEVBQUUsU0FBUyxZQUFZLE9BQU8sRUFBRSxNQUFNLFlBQVksT0FBTyxFQUFFLE9BQU8sVUFBVSxPQUFPO0NBQzFHLE1BQU0sT0FBTyxNQUFnQixPQUFPLE1BQU0sV0FBVyxJQUFJO0NBQ3pELE1BQU0sTUFBaUI7RUFDckIsUUFBUTtHQUFFLEtBQUssSUFBSSxJQUFJLEVBQUUsTUFBTSxNQUFNLENBQUMsQ0FBQztHQUFNLE1BQU0sSUFBSSxFQUFFLElBQUk7R0FBRyxNQUFNLElBQUksRUFBRSxJQUFJO0dBQUcsT0FBTyxJQUFJLEVBQUUsS0FBSztHQUFHLE9BQU8sSUFBSSxFQUFFLEtBQUs7R0FBRyxPQUFPLElBQUksRUFBRSxLQUFLO0VBQUU7RUFDakosR0FBRyxFQUFFO0VBQUcsSUFBSSxFQUFFO0VBQUksTUFBTSxPQUFPLEVBQUUsSUFBSTtFQUFHLEtBQUssT0FBTyxFQUFFLEdBQUc7RUFBRyxZQUFZLElBQUksRUFBRSxVQUFVO0NBQzFGO0NBQ0EsT0FBTyxPQUFPLE9BQU8sSUFBSSxNQUFNLENBQUMsQ0FBQyxPQUFNLE1BQUssT0FBTyxNQUFNLFlBQVksT0FBTyxTQUFTLENBQUMsQ0FBQyxLQUFLLE9BQU8sU0FBUyxJQUFJLFVBQVUsSUFBSSxNQUFNO0FBQ3RJOzs7Ozs7Ozs7OztBQVlBLE9BQU8sU0FBUyx5QkFBeUIsR0FBaUU7Q0FDeEcsTUFBTSxTQUFTLElBQUksSUFBSSxFQUFFLE9BQU8sZ0JBQWdCLFNBQVMsT0FBTyxDQUFDLENBQUMsS0FBSyxRQUFRLFFBQVEsR0FBRztDQUMxRixNQUFNLE1BQWdCLFVBQVUsRUFBRSxPQUFPLFVBQVU7Q0FDbkQsS0FBSyxNQUFNLEdBQUcsT0FBTyxVQUFVLENBQUMsQ0FBQyxNQUFLLE1BQU0sRUFBRSxLQUFLLEVBQUUsS0FBSyxJQUFJLFFBQVEsT0FBTyxJQUFJLE1BQU0sT0FBTyxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUUsQ0FBQyxDQUFDLE1BQU0sTUFBNkQ7RUFDN0ssSUFBSSxTQUFTLGNBQWMsUUFBUSxFQUFFLFVBQVUsU0FBUSxVQUFTLEtBQUs7RUFDckUsSUFBSSxRQUFRLGNBQWMsUUFBUSxFQUFFLFVBQVUsUUFBTyxVQUFTLEtBQUs7O0VBRW5FLElBQUksUUFBUSxJQUFJLFVBQVUsY0FBYyxRQUFRLEVBQUUsVUFBVSxRQUFPLFVBQVMsUUFBUSxJQUFJLE9BQVEsUUFBUSxDQUFDO0VBQ3pHLElBQUksUUFBUSxJQUFJLFVBQVUsY0FBYyxRQUFRLEVBQUUsVUFBVSxRQUFPLFVBQVMsUUFBUSxJQUFJLE9BQVEsUUFBUSxDQUFDO0VBQ3pHLElBQUksTUFBTSxNQUFNLFFBQVMsRUFBd0IsR0FBRztFQUNwRCxJQUFJLFFBQVEsSUFBSSxTQUFTLFVBQVU7Q0FDckMsQ0FBQyxDQUFDLENBQUMsT0FBTyxNQUFlO0VBQUUsUUFBUSxLQUFLLHFDQUFxQyxDQUFDO0VBQUcsSUFBSSxRQUFRO0NBQVUsQ0FBQztDQUN4RyxPQUFPLElBQUksMkJBQTJCO0VBQ3BDLFdBQVcsVUFBVSxNQUFNLFVBQVUsU0FBUztFQUM5QyxjQUFjO0VBQ2QsUUFBUSxFQUFFO0VBQ1YsUUFBUTtFQUNSLGVBQWU7RUFDZixTQUFTLE1BQU0sT0FBTyxHQUFHLE1BQU07R0FDN0IsSUFBSSxJQUFJLFVBQVUsV0FBVyxPQUFPO0dBQ3BDLElBQUksSUFBSSxVQUFVLFVBQVUsT0FBTztHQUNuQyxNQUFNLE1BQU0sV0FBVyxLQUFLLEdBQUcsR0FBRyxLQUFLO0dBQ3ZDLElBQUksQ0FBQyxLQUFLLE9BQU87R0FDakIsT0FBTztJQUFFLE1BQU07SUFBUTtJQUFNO0lBQU87SUFBSyxPQUFRLElBQUksUUFBUSxJQUFJLFFBQVEsT0FBTyxRQUFRLElBQUksT0FBTyxHQUFHLEdBQUcsS0FBSyxLQUFNO0dBQVU7RUFDaEk7Q0FDRixDQUFDO0FBQ0g7Ozs7Ozs7Ozs7OztBQWFBLE9BQU8sU0FBUyx1QkFBdUIsR0FBc0s7Q0FDM00sTUFBTSxhQUFhLEVBQUUsY0FBYyxDQUFDO0NBQ3BDLE1BQU0sSUFBSSxJQUFJLDJCQUEyQjtFQUN2QyxXQUFXLFVBQVUsTUFBTSxVQUFVLFNBQVM7RUFDOUMsY0FBYyxFQUFFLGFBQWEsS0FBSyxFQUFFLGlCQUFpQjtFQUNyRCxRQUFRLEVBQUU7RUFDVixRQUFRLFFBQVEsQ0FBQyxDQUFDLE1BQU0sTUFBTTtFQUM5QixTQUFTLE1BQU0sT0FBTyxHQUFHLE1BQU07R0FDN0IsSUFBSTtHQUNKLElBQUksRUFBRSxZQUFZLFNBQVM7SUFDekIsSUFBSSxRQUFRLFVBQVUsV0FBVyxPQUFPO0lBQ3hDLElBQUksUUFBUSxVQUFVLFdBQVcsV0FBVyxTQUFTLEdBQUcsR0FBRyxLQUFLLEdBQUcsT0FBTztJQUMxRSxJQUFJLFFBQVEsVUFBVSxXQUFXLFFBQVEsT0FBTyxhQUFhLGFBQWEsSUFBSSxDQUFDLENBQUMsT0FBTyxLQUNsRixFQUFFLEVBQUUsY0FBYyxRQUFRLEtBQUssaUJBQWlCLElBQUksQ0FBQyxDQUFDLFNBQVMsa0JBQWtCLE9BQU87SUFDN0YsSUFBSSxFQUFFLGNBQWMsUUFBUSxLQUFLLGlCQUFpQixJQUFJLENBQUMsQ0FBQyxTQUFTLGlCQUFpQjtLQUNoRixNQUFNLFFBQVEsS0FBSyxLQUFLLElBQUksR0FBRyxRQUFRLENBQUMsR0FBRyxLQUFLLEtBQUssTUFBTSxJQUFJLEtBQUssR0FBRyxLQUFLLEtBQUssTUFBTSxJQUFJLEtBQUs7S0FDaEcsTUFBTSxNQUFNLFdBQVcsU0FBUyxJQUFJLElBQUksQ0FBQztLQUN6QyxJQUFJLEtBQUs7TUFDUCxNQUFNLElBQUksRUFBRSxhQUFhLGtCQUFrQixJQUFJLElBQUksQ0FBQztNQUNwRCxZQUFZO09BQUU7T0FBSyxNQUFNO1FBQUUsTUFBTSxFQUFFO1FBQU0sTUFBTSxFQUFFO1FBQU0sT0FBTyxFQUFFO1FBQU8sT0FBTyxFQUFFO09BQU07TUFBRTtLQUMxRjtJQUNGO0dBQ0Y7R0FDQSxPQUFPLGFBQWEsQ0FBQyxNQUFNLGlCQUFpQixJQUFJLENBQUMsQ0FBQyxTQUFTLGFBQWEsU0FBUyxLQUFLLElBQ2xGLE9BQ0EsRUFBRSxjQUFjLFFBQVEsY0FBYyxJQUFJLElBQUksV0FDOUMsRUFBRSxjQUFjLFFBQVEsSUFBSTtJQUFFLE1BQU07SUFBUztJQUFNO0lBQU8sT0FBTyxFQUFFO0lBQU87SUFBWTtHQUFVLElBQ2hHO0lBQUUsTUFBTTtJQUFRO0lBQU07SUFBTyxPQUFPLEVBQUU7SUFBTyxLQUFLLEVBQUU7SUFBSyxnQkFBZ0IsRUFBRTtJQUFnQjtHQUFXO0VBQzVHO0NBQ0YsQ0FBQztDQUNELElBQUksRUFBRSxVQUFVLFNBQVMsSUFBSSxDQUFDO0NBQzlCLE9BQU87QUFDVDs7QUFHQSxJQUFJLFlBQVk7Ozs7Ozs7Ozs7QUFXaEIsT0FBTyxTQUFTLHNCQUFzQixHQUFtRDtDQUN2RixZQUFZO0NBQ1osT0FBTyxJQUFJLDJCQUEyQjtFQUNwQyxXQUFXLFVBQVUsTUFBTSxVQUFVLFNBQVM7RUFDOUMsY0FBYztFQUNkLFFBQVEsRUFBRTtFQUNWLFFBQVEsUUFBUSxDQUFDLENBQUMsTUFBTSxNQUFNO0VBQzlCLFNBQVMsTUFBTSxPQUFPLEdBQUcsTUFBTTtHQUM3QixNQUFNLElBQUk7R0FDVixJQUFJLENBQUMsS0FBSyxFQUFFLFVBQVUsV0FBVyxPQUFPO0dBQ3hDLElBQUksRUFBRSxVQUFVLFlBQVksQ0FBQyxFQUFFLEtBQUssT0FBTztHQUMzQyxJQUFJLFdBQVcsR0FBRyxHQUFHLEdBQUcsS0FBSyxHQUFHLE9BQU87R0FDdkMsSUFBSSxpQkFBaUIsSUFBSSxDQUFDLENBQUMsU0FBUyxtQkFBbUIsU0FBUyxLQUFLLEdBQUcsT0FBTztHQUMvRSxJQUFJLGFBQWEsSUFBSSxDQUFDLENBQUMsT0FBTyxHQUFHLE9BQU87OztHQUd4QyxJQUFJLFFBQVEsS0FBSyxpQkFBaUIsSUFBSSxDQUFDLENBQUMsU0FBUyxpQkFBaUIsT0FBTztHQUN6RSxJQUFJLFFBQVEsY0FBYyxJQUFJLEdBQUcsT0FBTztHQUN4QyxJQUFJLFFBQVEsR0FBRyxPQUFPO0lBQUUsTUFBTTtJQUFTO0lBQU07SUFBTyxPQUFPO0lBQW9DLFlBQVk7SUFBa0IsS0FBSyxFQUFFO0dBQUk7R0FDeEksT0FBTztJQUFFLE1BQU07SUFBUztJQUFNO0lBQU8sS0FBSyxFQUFFO0dBQUk7RUFDbEQ7Q0FDRixDQUFDO0FBQ0g7Ozs7O0FBTUEsT0FBTyxTQUFTLGlCQUFpQixNQUFnQjtDQUMvQyxJQUFJLENBQUMsS0FBSyxRQUFRO0NBQ2xCLFFBQVEsQ0FBQyxDQUFDLEtBQUssR0FBRyxFQUFFLGFBQWEsS0FBSyxLQUFJLE1BQUssSUFBSSxJQUFJLEdBQUcsU0FBUyxPQUFPLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUNyRjtBQUVBLE1BQU0seUJBQXlCLFlBQXNEO0NBQUUsR0FBRztDQUFRLEtBQUssSUFBSSxJQUFJLE9BQU8sS0FBSyxTQUFTLE9BQU8sQ0FBQyxDQUFDO0FBQUs7O0FBR2xKLE9BQU8sU0FBUyxtQkFBbUIsU0FBZ0MsWUFBdUQ7Q0FDeEgsTUFBTSxTQUFTLENBQUMsR0FBRyxJQUFJLElBQUksUUFBUSxLQUFJLE1BQUssQ0FBQyxJQUFJLElBQUksRUFBRSxLQUFLLFNBQVMsT0FBTyxDQUFDLENBQUMsTUFBTSxzQkFBc0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDO0NBQ3hILE9BQU8sUUFBUSxDQUFDLENBQUMsWUFBWSxRQUFRLFVBQVU7QUFDakQ7O0FBR0EsT0FBTyxTQUFTLHFCQUFxQixRQUE2QixLQUFhLEtBQXFDO0NBQ2xILE9BQU8sUUFBUSxDQUFDLENBQUMsYUFBYSxzQkFBc0IsTUFBTSxHQUFHLEtBQUssR0FBRztBQUN2RTs7QUFHQSxNQUFNLDhCQUE4QiwyQkFBMkI7Q0FDN0QsQUFBaUIsV0FBVyxJQUFJLElBQWtDO0NBRWxFLEFBQVMsYUFBYSxHQUFXLEdBQVcsT0FBZSxTQUE0RDtFQUNySCxNQUFNLE1BQU0sR0FBRyxNQUFNLEdBQUcsRUFBRSxHQUFHO0VBQzdCLElBQUksVUFBVSxLQUFLLFNBQVMsSUFBSSxHQUFHO0VBQ25DLElBQUksQ0FBQyxTQUFTO0dBQ1osTUFBTSxNQUFNLE1BQU0sYUFBYSxHQUFHLEdBQUcsT0FBTyxPQUFPO0dBQ25ELElBQUksQ0FBQyxLQUFLLE9BQU87R0FDakIsVUFBVTtHQUNWLEtBQUssU0FBUyxJQUFJLEtBQUssR0FBRztHQUMxQixLQUFLLElBQUksWUFBWTtJQUFFLElBQUksS0FBSyxTQUFTLElBQUksR0FBRyxNQUFNLEtBQUssS0FBSyxTQUFTLE9BQU8sR0FBRztHQUFHLENBQUM7O0dBRXZGLE9BQU8sS0FBSyxTQUFTLE9BQU8sSUFBSTtJQUM5QixNQUFNLENBQUMsS0FBSyxVQUFVLEtBQUssU0FBUyxRQUFRLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNyRCxLQUFLLFNBQVMsT0FBTyxHQUFHO0lBQ3hCLEtBQUssT0FBTyxNQUFLLE1BQUs7S0FBRSxJQUFJLE1BQU0sU0FBUyxNQUFNLFlBQVksaUJBQWlCLEVBQUUsTUFBTSxHQUFHLEdBQUk7SUFBRyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQztHQUNuSDtFQUNGLE9BQU87R0FBRSxLQUFLLFNBQVMsT0FBTyxHQUFHO0dBQUcsS0FBSyxTQUFTLElBQUksS0FBSyxPQUFPO0VBQUc7RUFDckUsT0FBTyxRQUFRLE1BQUssTUFBSyxNQUFNLGFBQWEsSUFBSSxrQkFBa0IsQ0FBQyxDQUFDO0NBQ3RFO0NBRUEsQUFBUyxXQUFXO0VBQUUsS0FBSyxTQUFTLE1BQU07RUFBRyxNQUFNLFNBQVM7Q0FBRztDQUMvRCxBQUFTLFlBQVk7RUFBRSxLQUFLLFNBQVMsTUFBTTtFQUFHLE1BQU0sVUFBVTtDQUFHO0FBQ25FOztBQUdBLE9BQU8sU0FBUyw0QkFBNEIsR0FBMEc7Q0FDcEosTUFBTSxVQUFVLEVBQUUsUUFBUSxJQUFJLHFCQUFxQjtDQUNuRCxPQUFPLElBQUksc0JBQXNCO0VBQy9CLFdBQVcsVUFBVTtFQUNyQixjQUFjLEVBQUUsZ0JBQWdCO0VBQ2hDLFFBQVEsRUFBRTtFQUNWLFFBQVEsUUFBUSxDQUFDLENBQUM7RUFDbEIsZUFBZTtFQUNmLFNBQVMsTUFBTSxVQUFVO0dBQ3ZCLE1BQU0sUUFBUSxpQkFBaUIsSUFBSTtHQUNuQyxNQUFNLFVBQVUsUUFBUSxNQUFLLE1BQUssRUFBRSxlQUFlLGFBQWEsRUFBRSxTQUFTLFVBQ3ZFLE1BQU0sV0FBVyxFQUFFLGtCQUFrQixNQUFNLFNBQVMsS0FBSyxJQUN6RCxNQUFNLFdBQVcsRUFBRSxrQkFBa0IsQ0FBQyxNQUFNLFNBQVMsS0FBSyxFQUFFO0dBQ2hFLE9BQU8sVUFBVTtJQUFFLE1BQU07SUFBVztJQUFNO0lBQU87R0FBUSxJQUFJO0VBQy9EO0NBQ0YsQ0FBQztBQUNIOzs7Ozs7QUFPQSxPQUFPLFNBQVMsMEJBQTBCLEdBQWlJO0NBQ3pLLE1BQU0sT0FBTyxFQUFFLGtCQUFrQjtDQUNqQyxNQUFNLFdBQVcsRUFBRSxtQkFBbUIsWUFBWSxrQkFBa0I7Q0FDcEUsTUFBTSxNQUFNLElBQUksSUFBSSxFQUFFLEtBQUssU0FBUyxPQUFPLENBQUMsQ0FBQztDQUM3QyxPQUFPLElBQUksMkJBQTJCO0VBQ3BDLFdBQVcsZUFBZSxJQUFJO0VBQzlCLGNBQWMsRUFBRSxnQkFBZ0I7RUFDaEMsUUFBUSxFQUFFO0VBQ1YsUUFBUTtFQUNSLFNBQVMsTUFBTSxVQUNiLGlCQUFpQixJQUFJLENBQUMsQ0FBQyxVQUFVLE9BQU8sU0FBUyxLQUFLLElBQUksT0FBTztHQUFFLE1BQU07R0FBVTtHQUFNO0dBQU87R0FBSyxTQUFTLEVBQUU7R0FBUyxhQUFhO0dBQU07RUFBUztDQUN6SixDQUFDO0FBQ0g7Ozs7Ozs7Ozs7OztBQWFBLE9BQU8sU0FBUywyQkFBMkIsR0FBd0c7Q0FDakosSUFBSSxlQUFlO0NBQ25CLE9BQU8sZ0JBQWdCLFlBQVksSUFBSSxlQUFlO0NBQ3RELE1BQU0sU0FBUyxRQUFRLENBQUMsQ0FBQyxNQUFNLFNBQVM7O0NBRXhDLElBQUksUUFBdUIsTUFBTSxRQUE2QixNQUFNLFNBQVM7Q0FDN0UsSUFBSSxFQUFFLFVBQVUsUUFBUSxPQUFPLGFBQWEsYUFBYTtFQUN2RCxNQUFNLFNBQVUsUUFBUSxJQUFJLElBQUksRUFBRSxTQUFTLG1CQUFtQixTQUFTLE9BQU8sQ0FBQyxDQUFDLEtBQUssUUFBUSxRQUFRLEdBQUc7RUFDeEcsU0FBUztFQUNULE1BQU0sUUFBUSxjQUNaLE1BQU0sR0FBRyxPQUFPLFdBQVcsQ0FBQyxDQUFDLE1BQUssTUFBTSxFQUFFLEtBQUssRUFBRSxLQUFLLElBQUksUUFBUSxPQUFPLElBQUksTUFBTSxPQUFPLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBRSxDQUFDLENBQUMsTUFBTSxTQUFrQjtHQUM5SCxNQUFNLEtBQUssa0JBQWtCLElBQUk7R0FDakMsSUFBSSxNQUFNLEdBQUcsV0FBVyxFQUFFLFFBQVE7SUFBRSxRQUFRO0lBQUksUUFBUSxDQUFDLENBQUMsS0FBSyxRQUFRO0tBQUUsY0FBYztLQUFNLE1BQU07SUFBTyxDQUFDO0dBQUcsT0FDekcsUUFBUSxLQUFLLG9EQUFvRCxJQUFJLFVBQVUsdUJBQXVCLDBCQUEwQixFQUFFLE9BQU8sR0FBRztFQUNuSixDQUFDLENBQUMsQ0FBQyxPQUFPLE1BQWdCLFlBQVksSUFBSSxJQUFJLFNBQWMsUUFBTyxXQUFXLEtBQUssSUFBSSxDQUFDLENBQUMsQ0FBQyxXQUFXLEtBQUssWUFBWSxDQUFDLENBQUMsSUFBSSxRQUFRLEtBQUssc0VBQXNFLENBQUMsQ0FBRTtFQUNwTixLQUFLLEtBQUssQ0FBQyxDQUFDLENBQUMsY0FBYztHQUFFLFNBQVM7RUFBTSxDQUFDO0NBQy9DO0NBQ0EsT0FBTyxJQUFJLDJCQUEyQjtFQUNwQyxXQUFXLGVBQWUsZUFBZTtFQUN6QztFQUNBLFFBQVEsRUFBRTtFQUNWO0VBQ0EsVUFBUyxRQUFPLG1CQUFtQixPQUFPLElBQUksTUFBTSxJQUFJLEtBQUs7RUFDN0QsU0FBUyxNQUFNLFVBQVU7R0FDdkIsSUFBSSxnQkFBZ0IsS0FBSyxJQUFJLEVBQUUsUUFBUSxpQkFBaUIsSUFBSSxDQUFDLENBQUMsVUFBVSxrQkFBa0IsU0FBUyxLQUFLLEdBQUcsT0FBTztHQUNsSCxJQUFJLHNCQUFzQixNQUFNLEtBQUssR0FBRyxPQUFPO0dBQy9DLElBQUksQ0FBQyxRQUFRLE9BQU87R0FDcEIsT0FBTztJQUFFLE1BQU07SUFBVztJQUFNO0lBQU8sUUFBUSxFQUFFO0lBQVEsTUFBTSxFQUFFO0lBQU07R0FBTTtFQUMvRTtDQUNGLENBQUM7QUFDSCIsIm5hbWVzIjpbXSwic291cmNlcyI6WyJpbWFnZXJ5LnRzIl0sInZlcnNpb24iOjMsInNvdXJjZXNDb250ZW50IjpbIi8vIEltYWdlcnkgZm9yIHRoZSAzRCBNb29uOiBOQVNBIHBob3RvcyBhbmQgbWFwIGxheWVycywgcmUtcHJvamVjdGVkIGludG8gdGhlIHJvdGF0ZWQgZGlzcGxheSBmcmFtZS5cbi8vXG4vLyBMaXZlIHNvdXJjZXMgY2hlY2tlZCAxNCBOb3YgMjAyNiAoY3VybDogcmVhbCBpbWFnZXMsIDIwMCwgQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luOiAqKTpcbi8vIC0gbHJvYy10aWxlcy5xdWlja21hcC5pby90aWxlcy9rYWdfdGNfZV83bS9sdW5hci1mdWxsZXFjL3t6fS97eH0ve3l9LnBuZz9kX3ZhbD0wLDUwMDAmZF9vcHQ9d2NvbHV0MDpcbi8vICAgZ2xvYmFsIEthZ3V5YSBldmVuaW5nIFRDLCBuYXRpdmUgNy40IG07IHoxMiBkZWxpdmVyeSBncmlkIDUuMiBtIChubyBjbGFpbSBvZiA1IG0gcmVhbFxuLy8gICBkZXRhaWwpLiBBIGZpeGVkIGRpc3BsYXkgcmFuZ2Uga2VlcHMgdGhlIHN0cmV0Y2ggY29uc2lzdGVudDsgV0FDIGFuY2hvcnMgYnJvYWQgdG9uZS5cbi8vICAgSVNBUy9KQVhBIG9ic2VydmF0aW9uIGRhdGEsIGNyZWRpdGVkIHJldXNlIGFuZCBkaXNwbGF5IGNoYW5nZXMgYWxsb3dlZDsgdmlhIEx1bmFyIFF1aWNrTWFwLlxuLy8gLSB0cmVrLm5hc2EuZ292L3RpbGVzL01vb24vRVEve2xheWVyfS8xLjAuMC9kZWZhdWx0L2RlZmF1bHQwMjhtbS97en0ve3l9L3t4fS5wbmc6XG4vLyAgIEthZ3V5YV9UQ29ydGhvX01vc2FpY19HbG9iYWxfNDA5NnBwZCBpcyBuYXRpdmUgNy40IG0gYnV0IHRoZSBMSVZFIHNlcnZpY2Ugc3RvcHMgYXQgejEwLFxuLy8gICBhYm91dCAyMC44IG0vcGl4ZWwuIHoxMS8xMiBhcmUgNDA0OiB0aGlzIGlzIHRoZSBmYWxsYmFjaywgbm90IHRoZSBwcmltYXJ5IGdsb2JhbCBwaG90by5cbi8vICAgTkFDIG1vc2FpY3MgZm9yIGFsbCBzaXggQXBvbGxvIHNpdGVzLCBUeWNobywgQ2hhbmcnZS00LCBTTElNLCBJTS0xIGFuZCBCbHVlIEdob3N0J3MgcmVnaW9uXG4vLyAgIHJlYWNoIGFib3V0IDAuM+KAkzIuNiBtIGdyaWQgc3BhY2luZzsgdGhlIHNvdXJjZSBpdHNlbGYgY2FuIGJlIGNvYXJzZXIuIE5BU0EvR1NGQy9BU1UuXG4vLyAtIGxyb2MtdGlsZXMucXVpY2ttYXAuaW8vdGlsZXMvd2FjX25hY19uYWNyb2kvbHVuYXItZnVsbGVxYy97en0ve3h9L3t5fS5qcGc6XG4vLyAgIFF1aWNrTWFwJ3MgV0FDICsgTkFDIHN0cmlwcyArIFJPSSBiYXNlbWFwLiBSZXF1ZXN0ZWQgb25seSBhcm91bmQgcmVjZW50IGxhbmRlcnMsIGF0IGNsb3NlXG4vLyAgIHpvb207IGFib3V0IDAuNeKAkzIgbSByZWFsIE5BQyBkZXRhaWwsIG5vdCBhIG5ldyBnbG9iYWwgc3ViLW1ldHJlIHN1cnZleS4gTHVuYXIgUXVpY2tNYXBcbi8vICAgKE5BU0EsIEludHVpdGl2ZSBNYWNoaW5lcywgQUNUKTsgbGl2ZSBjYXRhbG9ndWUgZGVzY3JpYmVzIHRoZXNlIGRhdGEgYXMgcHVibGljIGRvbWFpbi5cbi8vIC0gbHJvYy10aWxlcy5xdWlja21hcC5pby90aWxlcy9sbnBvbGVfYXZnL2x1bmFyLXN0ZXJlbnAve3p9L3t4fS97eX0ucG5nP2RfdmFsPTAsMC41JmRfb3B0PXdjb2x1dDA6XG4vLyAgIGNvbnRyb2xsZWQgbm9ydGgtcG9sZSBOQUMsIDg04oCTOTDCsE4sIG5hdGl2ZSAxIG0sIHoxMiBncmlkIDAuODg4IG0uIE5BU0EvR1NGQy9BU1UuXG4vLyAgIFRoZSBwdWJsaWMgV01TIGFsc28gaGFzIGEgMSBtIHVuY29udHJvbGxlZCBub3J0aCBtb3NhaWMsIGJ1dCBpdHMgbWVhc3VyZWQgMjEgcyBjb2xkIHJlbmRlcnNcbi8vICAgbG9zZSB0byB0aGVzZSBjYWNoZWQgcG9sYXIgdGlsZXMgKDMuMiBzKS4gV01TIGlzIHRyaWVkIG9ubHkgYWZ0ZXIgYSBjYWNoZWQgc3F1YXJlIGZhaWxzLlxuLy8gICBFeGlzdGluZyBzb3V0aCBzdGF5cyBsb2NhbCBmaXJzdC5cbi8vIExST0MgcGVybWl0cyBjcmVkaXRlZCBlZHVjYXRpb25hbCB1c2U7IGRvIG5vdCBjYWxsIGFsbCBub24tUERTIHByb2R1Y3RzIHB1YmxpYyBkb21haW4uXG4vLyBGdWxsIGxheWVyIG5hbWVzLCBtZWFzdXJlZCByZXNwb25zZXMsIHRlcm1zIGFuZCBtb2RpZmljYXRpb24gbm90aWNlOiBDUkVESVRTLWltYWdlcnkubWQuXG4vL1xuLy8gUm91bmQgMjogUXVpY2tNYXAncyBrYWdfdGNfbV83bSBNb3JuaW5nIHByb2R1Y3QgKHNhbWUgVVJML2dyaWQvcmFuZ2UgYXMgRXZlbmluZykgaXMgYWxzb1xuLy8gbGl2ZSwgcHVibGljIGFuZCBDT1JTLWVuYWJsZWQ7IEpBWEEncyBzbG4tbC10Yy01LW1vcm5pbmctbWFwLXY0LjAgYXJjaGl2ZSBjb25maXJtcyB0aGUgcHJvZHVjdC5cbi8vIEZvdXIgcGFpcmVkIGhpc3RvZ3JhbXMgcHV0IGRldGFpbC1mcmVlIHNoYWRvd3MgaW4gdGhlIDAtLTIgRE4gc3Bpa2UuIFRob3NlIHBpeGVscyBoYXZlIGFcbi8vIHNpeC1zb3VyY2UtcGl4ZWwgZmVhdGhlciBCRUZPUkUgcHJvamVjdGlvbjsgTW9ybmluZyBpcyByZXF1ZXN0ZWQgb25seSB3aGVyZSBhbiBvbi1zY3JlZW5cbi8vIEV2ZW5pbmcgdGlsZSBoYXMgPjAuNSUgYmxhY2suIFdBQyBmaWxscyB3aGVyZSBib3RoIGxhY2sgZ3JvdW5kLiBUaGlzIG1peGVzIFN1biBkaXJlY3Rpb25zO1xuLy8gaXQgaXMgYSByZWFkYWJsZSB0ZXJyYWluIGNvbXBvc2l0ZSwgbm90IGEgcGhvdG9ncmFwaCBvZiBvbmUgbW9tZW50IChzZWUgaW1hZ2VyeSBjcmVkaXRzKS5cbi8vIFR5Y2hvJ3MgdHdvIGJyaWdodG5lc3MgYm94ZXMgd2VyZSByZXByb2R1Y2VkIGRpcmVjdGx5IGluIE5BU0EncyByYXcgTkFDIHoxMi0tMTQgdGlsZXM6XG4vLyB0aGV5IGFyZSBqb2lucyBpbnNpZGUgdGhhdCBtb3NhaWMuIFdlIGtlZXAgYSBmaXhlZCBnZW9ncmFwaGljIGV4cG9zdXJlIHJlZmVyZW5jZSByYXRoZXJcbi8vIHRoYW4gaW52ZW50aW5nIHBlci1yZXF1ZXN0IGNvcnJlY3Rpb25zIHRoYXQgd291bGQgbW92ZSB0aGUgam9pbnMgYXMgdGlsZXMgbG9hZC5cbi8vIFNoYXJwIHBob3RvcyBtYXRjaCBleHBvc3VyZSBhZ2FpbnN0IGEgRklYRUQgY29hcnNlciBzb3VyY2UgYW5kIFdBQyByZWZlcmVuY2UuXG4vLyBUaGUgc2FtZSB0cnVlLWZyYW1lIHJlZmVyZW5jZSBhdCBldmVyeSB6b29tIGF2b2lkcyBwZXItdGlsZSBtZWFuIGp1bXBzLlxuLy8gVGhlIHdlc3QtbGl0IHNlYW0gZml4IHN1cHBsaWVzIHRoZSByZWZlcmVuY2UgdGhlcmUuIFBvbGFyIGFuZCBmYWxsYmFjayBwaG90b3MgYWRkIGZpbmUgZGV0YWlsXG4vLyB0byB0aGUgZXhpc3RpbmcgYnJvYWQgcGljdHVyZS4gQW4gTkFDIG1vc2FpYyByZXBsYWNlcyBUQyBpbnNpZGUgaXRzIGZlYXRoZXJlZCBmb290cHJpbnQuXG4vLyBUaGVzZSBjaG9pY2VzIGhhcHBlbiBJTlNJREUgcGhvdG8gLyBwaG90b0ZpeCwgd2l0aCBubyBuZXcgSW1hZ2VyeUxheWVyIG9yIFVJIHN3aXRjaC4gU2hhcnBcbi8vIHJlcXVlc3RzIG9ubHkgc3RhcnQgYmV5b25kIFdBQydzIHo4IGFuZCBuZXZlciBydW4gaW4gc3RhcnQtdXAncyBleGlzdGluZyBzb3V0aC1wb2xlIHZpZXdzLlxuLy8gQ2xvc2Ugdmlld3Mga2VlcCBXQUMgdGhlbiByZXF1ZXN0IHRoZSB2aXNpYmxlIHRhcmdldCBsZXZlbCwgZGVmZXJyaW5nIGludGVybWVkaWF0ZSBsZXZlbHNcbi8vIHdpdGhvdXQgZGlzY2FyZGluZyB0aGVtIChhIGxhdGVyIHpvb20tb3V0IGNhbiBzdGlsbCB1c2UgdGhlbSkuIFJlcXVlc3RzIG5lYXJlciB0aGUgc2NyZWVuXG4vLyBjZW50cmUgZ2V0IHRoZSBuZXh0IHNlcnZlciBzbG90OyBjYW5jZWxsZWQgY29uc3VtZXJzIGFsc28gbGVhdmUgdGhhdCBwcmlvcml0eSBxdWV1ZS5cbi8vIFJldGFpbmVkIGRlY29kZWQgc291cmNlcywgaW5jbHVkaW5nIG1hc2tzL2xvY2FsIHJhc3RlcnMsIHNoYXJlIGFuIExSVSBidWRnZXQgcGVyIHdvcmtlcjpcbi8vIDEyOCArIDY0ICsgMzIgTWlCIGF0IG1vc3QuIFRoaXMgaXMgYSBjYWNoZSBsaW1pdCwgbm90IGEgYm91bmQgb24gdGhlIHdob2xlIGJyb3dzZXIvR1BVLlxuLy9cbi8vIENlc2l1bSBhc2tzIGVhY2ggaW1hZ2VyeSBwcm92aWRlciBmb3IgMjU2eDI1NiBsb24vbGF0IHRpbGVzIG9mIHRoZSBESVNQTEFZIGZyYW1lIChzZWUgZnJhbWUudHM6XG4vLyB0aGUgdHJ1ZSBzb3V0aCBwb2xlIHNpdHMgb24gQ2VzaXVtJ3MgZXF1YXRvciwgc28gcG9sYXIgdGlsZXMgYXJlIG5vcm1hbCBzcXVhcmVzLCBub3Qgc2xpdmVycykuXG4vLyBUaGUgcGljdHVyZXMgdGhlbXNlbHZlcyBhcmUgaW4gdGhlIFRSVUUgTW9vbiBmcmFtZSwgc28gZXZlcnkgdGlsZSBpcyByZS1wcm9qZWN0ZWQgcGl4ZWwgYnkgcGl4ZWwuXG4vLyBUaGF0IHdvcmsgKGRvd25sb2FkLCBkZWNvZGUsIHJlLXByb2plY3QpIGhhcHBlbnMgaW4gYSBzbWFsbCBwb29sIG9mIFdlYiBXb3JrZXJzXG4vLyAoaW1hZ2VyeVdvcmtlci50cyk7IHRoZSBtYWluIHRocmVhZCBvbmx5IGRvZXMgY2hlYXAgY2hlY2tzIGFuZCBoYW5kcyBmaW5pc2hlZCBJbWFnZUJpdG1hcHMgdG9cbi8vIENlc2l1bS5cbi8vXG4vLyAtIGNyZWF0ZUJhc2VNb3NhaWNQcm92aWRlcjogICB0aGUgd2hvbGUtTW9vbiBwaG90byBzdG9yZWQgd2l0aCB0aGUgYXBwIChwdWJsaWMvZGF0YS9iYXNlKTogdGhlXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBib3R0b20gbGF5ZXIsIHRoZXJlIGF0IG9uY2UgYW5kIHdpdGggbm8gaW50ZXJuZXRcbi8vIC0gY3JlYXRlTW9vblRyZWtQcm92aWRlcjogICAgIE5BU0EgTW9vbiBUcmVrIGdsb2JhbCB0aWxlcyAocGhvdG8sIExPTEEgY29sb3VyIGhlaWdodHMpXG4vLyAtIGNyZWF0ZVBvbGFyUmFzdGVyUHJvdmlkZXI6ICBvbmUgbG9jYWwgc291dGgtcG9sYXIgcGljdHVyZSAocG9sYXIgcGhvdG8sIHNjaWVuY2UgbWFwcylcbi8vIC0gY3JlYXRlUG9sYXJQeXJhbWlkUHJvdmlkZXI6IHNoYXJwIHNvdXRoLXBvbGFyIHBob3RvIHNxdWFyZXMsIGRvd24gdG8gfjEgbS9waXhlbDogcmVhZCBmcm9tIHRoZVxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29waWVzIHN0b3JlZCB3aXRoIHRoZSBhcHAgKHB1YmxpYy9kYXRhL3BvbGFyL3QpIHdoZXJlIHRoZXkgZXhpc3QsXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmcm9tIEFTVSBMdW5hc2VydiBlbHNld2hlcmVcbi8vXG4vLyBFYWNoIHByb3ZpZGVyIG9ubHkgY292ZXJzIHRoZSBwYXJ0IG9mIHRoZSBNb29uIGl0IGhhcyBwaWN0dXJlcyBmb3IgKGl0cyBgcmVjdGFuZ2xlYCksIGFuZCB0aWxlc1xuLy8gdGhhdCB0dXJuIG91dCB0byBiZSBlbXB0eSBhcmUgYW5zd2VyZWQgYXQgb25jZSB3aXRoIG9uZSBzaGFyZWQgdHJhbnNwYXJlbnQgcGl4ZWwsIHNvIHRoZSBsYXllcnNcbi8vIHVuZGVybmVhdGggc2hvdyB0aHJvdWdoIGFuZCBub3RoaW5nIHNtZWFyZWQgaXMgZXZlciBsZWZ0IG9uIHNjcmVlbi5cbi8vXG4vLyBXaGVyZSB0aGUgZGF0YSBlbmRzLCBsb2FkaW5nIGVuZHM6IGEgdGlsZSB0aGF0IGNvdWxkIG9ubHkgcmVwZWF0IGl0cyBwYXJlbnQgKHRoZSBwaG90b3MgaGF2ZSBub1xuLy8gZmluZXIgZGV0YWlsIHRoZXJlKSwgb3Igd2hvc2UgZG93bmxvYWQgZmFpbGVkLCBpcyBhbnN3ZXJlZCBcImtlZXAgc2hvd2luZyB0aGUgcGFyZW50IHRpbGVcIlxuLy8gKENlc2l1bSdzIHRpbGUtZGlzY2FyZCBtZWNoYW5pc20pLCBzbyBub3RoaW5nIGlzIHJlcXVlc3RlZCBmb3IgaXQgYW5kIG5vIGhvbGUgYXBwZWFycy4gQWZ0ZXIgYVxuLy8gZmFpbGVkIGRvd25sb2FkIHRoZSBsYXllciBhc2tzIENlc2l1bSB0byByZWxvYWQgaXRzIHRpbGVzIG9uY2UgdGhlIG5ldHdvcmsgd29ya3MgYWdhaW4gKENlc2l1bVxuLy8gaXRzZWxmIG5ldmVyIGFza3MgdHdpY2UgZm9yIGEgdGlsZSBpdCBoYXMgcmVjZWl2ZWQpLlxuXG5pbXBvcnQgeyBDYXJ0ZXNpYW4yLCBDYXJ0ZXNpYW4zLCBDYXJ0b2dyYXBoaWMsIENyZWRpdCwgRXZlbnQsIEdlb2dyYXBoaWNUaWxpbmdTY2hlbWUsIFJlY3RhbmdsZSwgUmVxdWVzdFN0YXRlLCB0eXBlIFZpZXdlciB9IGZyb20gJ2Nlc2l1bSc7XG5pbXBvcnQgeyBNT09OX0VMTElQU09JRCB9IGZyb20gJy4vZWxsaXBzb2lkJztcbmltcG9ydCB7XG4gIEZJWF9NSU5fVFJVRV9MQVQsIE5PUlRIX1BIT1RPX0xBVCwgUE9MQVJfRkVBVEhFUl9NLCBQT0xBUl9MSU1JVF9ERUcsIFBZUkFNSURfTUFYX0ssIFJFVFJZX01TLCBUSUxFLCBwYXJzZVB5cmFtaWRJbmRleCwgcGl4ZWxEZWcsIHB5cmFtaWRMZXZlbEZvciwgcHlyYW1pZFBhcmVudElzRW5vdWdoLFxuICBweXJhbWlkU3VyZWx5TG9jYWwsIHRpbGVGaXhSYW5nZSwgdGlsZVRydWVMYXRSYW5nZSwgcGhvdG9NYXhMZXZlbCwgcGl4ZWxNZXRyZXMsXG4gIHR5cGUgQmFzZUN1dCwgdHlwZSBGaXhQYXJhbXMsIHR5cGUgRnJvbVdvcmtlciwgdHlwZSBKb2IsIHR5cGUgUHlyYW1pZEluZGV4LCB0eXBlIFJlY3QsIHR5cGUgVG9Xb3JrZXIsIHR5cGUgU2NpZW5jZVJhc3RlclNvdXJjZSxcbn0gZnJvbSAnLi9pbWFnZXJ5V29ya2VyJztcbmV4cG9ydCB0eXBlIHsgU2NpZW5jZVJhc3RlclNvdXJjZSB9IGZyb20gJy4vaW1hZ2VyeVdvcmtlcic7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gV29ya2VyIHBvb2wuIFdvcmtlciAwIGRvZXMgZXZlcnkgcG9sYXItcmFzdGVyIGpvYiwgc28gZWFjaCBiaWcgcmFzdGVyIGlzIGRlY29kZWQgYW5kIGhlbGRcbi8vIG9uY2UuIFRpbGVkIHNvdXJjZXMgYXJlIHBpbm5lZCB0byBvbmUgb2YgdGhlIG90aGVyIHdvcmtlcnMsIHNvIGV2ZXJ5IHNvdXJjZSB0aWxlIGlzIGRvd25sb2FkZWRcbi8vIGFuZCBjYWNoZWQgZXhhY3RseSBvbmNlOiBhbGwgTW9vbiBUcmVrIGxheWVycyBzaGFyZSBvbmUgd29ya2VyIChzbyBpdHMgZG93bmxvYWQgbGltaXQgY292ZXJzXG4vLyB0aGUgd2hvbGUgdHJlay5uYXNhLmdvdiBzZXJ2ZXIpLCB0aGUgcG9sYXIgcHlyYW1pZCBoYXMgaXRzIG93bi5cbi8vIFRoZSBzY2llbmNlIG1hcHMgdXNlIG9uZSBmdXJ0aGVyIHdvcmtlciBhbmQgYSBzZXBhcmF0ZSBtZW1vcnkgYnVkZ2V0LCBzbyBwcmVwYXJpbmcgdGhlbVxuLy8gbmV2ZXIgbWFrZXMgdGhlIGxvY2FsIE1vb24gcGhvdG8gbG9zZSBpdHMgZGVjb2RlZCBzb3VyY2UuXG5cbmNvbnN0IFJBU1RFUl9RVUVVRSA9IDQ4OyAvLyBqb2JzIHdhaXRpbmcgcGVyIHdvcmtlciBiZWZvcmUgd2UgdGVsbCBDZXNpdW0gXCJidXN5LCBhc2sgYWdhaW5cIiAoQ1BVIG9ubHksIGZhc3QpXG5jb25zdCBUSUxFRF9RVUVVRSA9IDI0OyAvLyB0aWxlZCB3b3JrZXJzIHdhaXQgb24gdGhlIG5ldHdvcmssIHNvIGtlZXAgdGhlaXIgcXVldWVzIHNob3J0IGFuZCBmcmVzaFxuY29uc3QgTE9DQUxfUVVFVUUgPSA2NDsgLy8gdGlsZXMgZHJhd24gZnJvbSBmaWxlcyBzdG9yZWQgd2l0aCB0aGUgYXBwOiBmYXN0LCBuZXZlciBoZWxkIGJhY2sgYmVoaW5kIHNsb3cgZG93bmxvYWRzXG5cbi8vIFJlbG9hZGluZyB0aWxlcyB0aGF0IHdlcmUgZHJhd24gd2l0aCBob2xlcy5cbmNvbnN0IFJFTE9BRF9BRlRFUl9HQVBTX01TID0gUkVUUllfTVMgKyA1XzAwMDsgLy8gYnkgdGhlbiB0aGUgd29ya2VyIHJlYWxseSB0cmllcyB0aGUgZmFpbGVkIGRvd25sb2FkcyBhZ2FpblxuY29uc3QgUkVMT0FEX0FGVEVSX1JFQ09WRVJZX01TID0gMV81MDA7IC8vIGEgZmFpbGluZyBzZXJ2ZXIgYW5zd2VycyBhZ2Fpbiwgb3IgdGhlIGJyb3dzZXIgaXMgYmFjayBvbmxpbmVcbmNvbnN0IFJFTE9BRF9NSU5fU1BBQ0lOR19NUyA9IDMwXzAwMDsgLy8gYXQgbW9zdCBvbmUgcmVsb2FkIHBlciBsYXllciB0aGlzIG9mdGVuLi4uXG5jb25zdCBSRUxPQURfTUFYX1NQQUNJTkdfTVMgPSAxMCAqIDYwXzAwMDsgLy8gLi4uZG91YmxpbmcgdXAgdG8gdGhpcyB3aGlsZSBkb3dubG9hZHMga2VlcCBmYWlsaW5nXG5cbi8qKlxuICogUmFpc2VkIGFmdGVyIGEgbGF5ZXIgYXNrZWQgdGhlIGdsb2JlIHRvIHJlbG9hZCB0aWxlcyB0aGF0IGhhZCBob2xlcy4gV2l0aCByZXF1ZXN0UmVuZGVyTW9kZVxuICogdGhlIHNjZW5lIG9ubHkgc3RhcnRzIGxvYWRpbmcgdGhlbSBvbiBpdHMgbmV4dCBmcmFtZSwgc28gdGhlIG1hcCB2aWV3IGNhbiBsaXN0ZW4gYW5kIGNhbGxcbiAqIHNjZW5lLnJlcXVlc3RSZW5kZXIoKS5cbiAqL1xuZXhwb3J0IGNvbnN0IGltYWdlcnlSZWxvYWRlZCA9IG5ldyBFdmVudCgpO1xuXG5mdW5jdGlvbiBvbmVQaXhlbCgpOiBJbWFnZUJpdG1hcCB7XG4gIGNvbnN0IGMgPSBuZXcgT2Zmc2NyZWVuQ2FudmFzKDEsIDEpO1xuICBjLmdldENvbnRleHQoJzJkJyk7XG4gIHJldHVybiBjLnRyYW5zZmVyVG9JbWFnZUJpdG1hcCgpO1xufVxuXG4vKiogT25lIGZ1bGx5IHRyYW5zcGFyZW50IHBpeGVsLCBzaGFyZWQgYnkgZXZlcnkgZW1wdHkgdGlsZS4gKi9cbmxldCBibGFuazogSW1hZ2VCaXRtYXAgfCB1bmRlZmluZWQ7XG5jb25zdCBibGFua1RpbGUgPSAoKSA9PiAoYmxhbmsgPz89IG9uZVBpeGVsKCkpO1xuXG4vKipcbiAqIFRoZSBhbnN3ZXIgXCJub3RoaW5nIG5ldyBoZXJlOiBrZWVwIHNob3dpbmcgdGhlIHBhcmVudCB0aWxlXCIuIENlc2l1bSBhc2tzIGV2ZXJ5IHByb3ZpZGVyJ3NcbiAqIHRpbGVEaXNjYXJkUG9saWN5IGFib3V0IGVhY2ggcGljdHVyZSBpdCByZWNlaXZlczsgb3VycyByZWNvZ25pc2VzIHRoaXMgb25lLCBzbyB0aGUgdGlsZSBpc1xuICogbWFya2VkIGFzIG5vdCBhdmFpbGFibGUgYW5kIGl0cyBwYXJlbnQncyBwaWN0dXJlIHN0YXlzIG9uIHNjcmVlbiAoc3RyZXRjaGVkIGJ5IHRoZSBHUFUpLlxuICovXG5sZXQgcGFyZW50TWFyazogSW1hZ2VCaXRtYXAgfCB1bmRlZmluZWQ7XG5jb25zdCBwYXJlbnRNYXJrQml0bWFwID0gKCkgPT4gKHBhcmVudE1hcmsgPz89IG9uZVBpeGVsKCkpO1xuY29uc3QgZGlzY2FyZFBvbGljeSA9IHsgaXNSZWFkeTogKCkgPT4gdHJ1ZSwgc2hvdWxkRGlzY2FyZEltYWdlOiAoaW1hZ2U6IHVua25vd24pID0+IGltYWdlICE9PSB1bmRlZmluZWQgJiYgaW1hZ2UgPT09IHBhcmVudE1hcmsgfTtcblxuLyoqXG4gKiBXZWJHTCBpcyBtZWFudCB0byBpZ25vcmUgVU5QQUNLX0ZMSVBfWSBmb3IgSW1hZ2VCaXRtYXBzOyBDZXNpdW0gcmVsaWVzIG9uIHRoYXQgKGl0cyBvd24gdGlsZVxuICogYml0bWFwcyBhcmUgY3JlYXRlZCBwcmUtZmxpcHBlZCkgYW5kIHNvIGRvIHdlLiBDaGVjayBvbmNlIGluIHRoaXMgYnJvd3NlciBieSB1cGxvYWRpbmcgYSAxeDJcbiAqIGJpdG1hcCwgc28gdGlsZXMgY2FuIG5ldmVyIGNvbWUgb3V0IHVwc2lkZSBkb3duLiBSZXNvbHZlcyB0cnVlIGlmIHRoZSBicm93c2VyIERPRVMgZmxpcC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGV0ZWN0Qml0bWFwRmxpcCgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcbiAgICBjYW52YXMud2lkdGggPSBjYW52YXMuaGVpZ2h0ID0gMTtcbiAgICBjb25zdCBnbCA9IGNhbnZhcy5nZXRDb250ZXh0KCd3ZWJnbCcsIHsgYW50aWFsaWFzOiBmYWxzZSwgZGVwdGg6IGZhbHNlLCBzdGVuY2lsOiBmYWxzZSB9KTtcbiAgICBpZiAoIWdsKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgYm1wID0gYXdhaXQgY3JlYXRlSW1hZ2VCaXRtYXAobmV3IEltYWdlRGF0YShuZXcgVWludDhDbGFtcGVkQXJyYXkoWzI1NSwgMCwgMCwgMjU1LCAwLCAwLCAyNTUsIDI1NV0pLCAxLCAyKSwgeyBwcmVtdWx0aXBseUFscGhhOiAnbm9uZScgfSk7XG4gICAgY29uc3QgdGV4ID0gZ2wuY3JlYXRlVGV4dHVyZSgpO1xuICAgIGdsLmJpbmRUZXh0dXJlKGdsLlRFWFRVUkVfMkQsIHRleCk7XG4gICAgZ2wucGl4ZWxTdG9yZWkoZ2wuVU5QQUNLX0ZMSVBfWV9XRUJHTCwgdHJ1ZSk7XG4gICAgZ2wudGV4SW1hZ2UyRChnbC5URVhUVVJFXzJELCAwLCBnbC5SR0JBLCBnbC5SR0JBLCBnbC5VTlNJR05FRF9CWVRFLCBibXApO1xuICAgIGdsLnRleFBhcmFtZXRlcmkoZ2wuVEVYVFVSRV8yRCwgZ2wuVEVYVFVSRV9NSU5fRklMVEVSLCBnbC5ORUFSRVNUKTtcbiAgICBnbC5iaW5kRnJhbWVidWZmZXIoZ2wuRlJBTUVCVUZGRVIsIGdsLmNyZWF0ZUZyYW1lYnVmZmVyKCkpO1xuICAgIGdsLmZyYW1lYnVmZmVyVGV4dHVyZTJEKGdsLkZSQU1FQlVGRkVSLCBnbC5DT0xPUl9BVFRBQ0hNRU5UMCwgZ2wuVEVYVFVSRV8yRCwgdGV4LCAwKTtcbiAgICBjb25zdCBweCA9IG5ldyBVaW50OEFycmF5KDQpO1xuICAgIGdsLnJlYWRQaXhlbHMoMCwgMCwgMSwgMSwgZ2wuUkdCQSwgZ2wuVU5TSUdORURfQllURSwgcHgpOyAvLyB0ZXh0dXJlIHJvdyAwXG4gICAgYm1wLmNsb3NlKCk7XG4gICAgZ2wuZ2V0RXh0ZW5zaW9uKCdXRUJHTF9sb3NlX2NvbnRleHQnKT8ubG9zZUNvbnRleHQoKTtcbiAgICByZXR1cm4gcHhbMl0gPiBweFswXTsgLy8gcm93IDAgaXMgdGhlIGJpdG1hcCdzIGJvdHRvbSAoYmx1ZSkgcm93OiB0aGlzIGJyb3dzZXIgZmxpcHBlZCBpdFxuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7IC8vIGFzc3VtZSB0aGUgc3RhbmRhcmQgYmVoYXZpb3VyXG4gIH1cbn1cblxuY2xhc3MgSW1hZ2VyeVdvcmtlcnMge1xuICBwcml2YXRlIHJlYWRvbmx5IHdvcmtlcnM6IChXb3JrZXIgfCBudWxsKVtdID0gW107XG4gIHByaXZhdGUgcmVhZG9ubHkgYnVzeTogbnVtYmVyW10gPSBbXTtcbiAgcHJpdmF0ZSByZWFkb25seSBsb2NhbDogbnVtYmVyW10gPSBbXTsgLy8gam9icyBpbiBmbGlnaHQgdGhhdCBuZWVkIG5vIGRvd25sb2FkIGZyb20gYSByZW1vdGUgc2VydmVyXG4gIHByaXZhdGUgcmVhZG9ubHkgam9icyA9IG5ldyBNYXA8bnVtYmVyLCB7IHdvcmtlcjogbnVtYmVyOyBvd25lcjogUmVwcm9qZWN0ZWRJbWFnZXJ5UHJvdmlkZXI7IGRvbmU6IChiOiBJbWFnZUJpdG1hcCkgPT4gdm9pZDsgcmVqZWN0OiAocmVhc29uOiBFcnJvcikgPT4gdm9pZDsgcmVxdWVzdD86IEltYWdlcnlSZXF1ZXN0OyBhdDogbnVtYmVyOyBraW5kOiBzdHJpbmc7IGxvY2FsOiBib29sZWFuOyByZWN0OiBSZWN0IH0+KCk7XG4gIC8qKlxuICAgKiBDb3VudGVycyBmb3IgdGhlIGxvYWRpbmcgc2NyZWVuIGFuZCBmb3IgdGVzdHMuIHBhcmVudHMgPSB0aWxlcyBhbnN3ZXJlZCBcImtlZXAgdGhlIHBhcmVudFwiO1xuICAgKiBkZWVwZXN0ID0gZmluZXN0IHRpbGUgbGV2ZWwgYXNrZWQgb2YgdGhlIHdvcmtlcnMgcGVyIGtpbmQgb2YgbGF5ZXI7IGZpbGVzL3JlbW90ZS9mYWlsZWQgPVxuICAgKiBkb3dubG9hZHMgYnkgdGhlIHdvcmtlcnMgKGZpbGVzIHN0b3JlZCB3aXRoIHRoZSBhcHAgLyByZW1vdGUgc2VydmVycyAvIGZhaWxlZCkuXG4gICAqL1xuICByZWFkb25seSBzdGF0cyA9IHsgYXNrZWQ6IDAsIGFuc3dlcmVkOiAwLCByZWZ1c2VkOiAwLCBkZWZlcnJlZDogMCwgY2FuY2VsbGVkOiAwLCBwYXJlbnRzOiAwLCBzbG93ZXN0TXM6IDAsIGxhc3RNczogMCwgdG90YWxNczogMCwgZmlsZXM6IDAsIHJlbW90ZTogMCwgZmFpbGVkOiAwLCBkZWNvZGVkQnl0ZXM6IDAsIGRlY29kZWRJbWFnZXM6IDAsIGNhY2hlczogW10gYXMgTm9uTnVsbGFibGU8RnJvbVdvcmtlclsnY2FjaGUnXT5bXSwgZGVlcGVzdDoge30gYXMgUmVjb3JkPHN0cmluZywgbnVtYmVyPiwgdHJhZmZpYzoge30gYXMgTm9uTnVsbGFibGU8RnJvbVdvcmtlclsndHJhZmZpYyddPiB9O1xuICBwcml2YXRlIHJlYWRvbmx5IG5ldDogW251bWJlciwgbnVtYmVyLCBudW1iZXJdW10gPSBbXTtcbiAgcHJpdmF0ZSByZWFkb25seSB0cmFmZmljOiBOb25OdWxsYWJsZTxGcm9tV29ya2VyWyd0cmFmZmljJ10+W10gPSBbXTtcbiAgcHJpdmF0ZSByZWFkb25seSBmbGlwID0gZGV0ZWN0Qml0bWFwRmxpcCgpO1xuICBwcml2YXRlIHJlYWRvbmx5IHJvdXRlcyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIC8qKiBMYXllcnMgdGhhdCBkcmV3IHRpbGVzIHdpdGggaG9sZXMgYW5kIGFyZSB3YWl0aW5nIHRvIHJlbG9hZCB0aGVtLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IGdhcHBlZCA9IG5ldyBTZXQ8UmVwcm9qZWN0ZWRJbWFnZXJ5UHJvdmlkZXI+KCk7XG4gIHByaXZhdGUgbmV4dElkID0gMTtcbiAgcHJpdmF0ZSByZWFkb25seSBzY2llbmNlV2FybSA9IG5ldyBNYXA8bnVtYmVyLCB7IHJlc29sdmU6IChvazogYm9vbGVhbikgPT4gdm9pZDsgcHJvZ3Jlc3M/OiAoZnJhYzogbnVtYmVyKSA9PiB2b2lkIH0+KCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgc2NpZW5jZVZhbHVlcyA9IG5ldyBNYXA8bnVtYmVyLCAodmFsdWU6IG51bWJlciB8IG51bGwpID0+IHZvaWQ+KCk7XG4gIHJlYWRvbmx5IHRpbGVkQ291bnQ6IG51bWJlcjtcbiAgcmVhZG9ubHkgc2NpZW5jZVdvcmtlcjogbnVtYmVyO1xuXG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIGNvbnN0IGNvcmVzID0gbmF2aWdhdG9yLmhhcmR3YXJlQ29uY3VycmVuY3kgfHwgNDtcbiAgICB0aGlzLnRpbGVkQ291bnQgPSBjb3JlcyA+PSA0ID8gMiA6IDE7IC8vIE1vb24gVHJlayBhbmQgdGhlIHB5cmFtaWQsIHBsdXMgdGhlIHJhc3RlciB3b3JrZXJcbiAgICB0aGlzLnNjaWVuY2VXb3JrZXIgPSB0aGlzLnRpbGVkQ291bnQgKyAxO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDw9IHRoaXMuc2NpZW5jZVdvcmtlcjsgaSsrKSB7XG4gICAgICBjb25zdCB3ID0gbmV3IFdvcmtlcihuZXcgVVJMKCcuL2ltYWdlcnlXb3JrZXIudHMnLCBpbXBvcnQubWV0YS51cmwpLCB7IHR5cGU6ICdtb2R1bGUnIH0pO1xuICAgICAgdy5vbm1lc3NhZ2UgPSAoZTogTWVzc2FnZUV2ZW50PEZyb21Xb3JrZXI+KSA9PiB0aGlzLmZpbmlzaChlLmRhdGEsIGkpO1xuICAgICAgdy5vbmVycm9yID0gZSA9PiB0aGlzLmZhaWwoaSwgZSk7XG4gICAgICB0aGlzLndvcmtlcnMucHVzaCh3KTtcbiAgICAgIHRoaXMuYnVzeS5wdXNoKDApO1xuICAgICAgdGhpcy5sb2NhbC5wdXNoKDApO1xuICAgICAgdGhpcy5uZXQucHVzaChbMCwgMCwgMF0pO1xuICAgICAgLy8gU2NpZW5jZSBtYXBzIGhhdmUgdGhlaXIgb3duIHdvcmtlciBzbyBrZWVwaW5nIHRoZW0gcmVhZHkgY2Fubm90IGV2aWN0IHRoZSBNb29uIHBob3RvLlxuICAgICAgdy5wb3N0TWVzc2FnZSh7IGNhY2hlQnVkZ2V0Qnl0ZXM6IChpID09PSB0aGlzLnNjaWVuY2VXb3JrZXIgPyA1MTIgOiBpID09PSAwID8gMTI4IDogaSA9PT0gMSA/IDY0IDogMzIpICogMiAqKiAyMCB9IHNhdGlzZmllcyBUb1dvcmtlcik7XG4gICAgfVxuICAgIGFkZEV2ZW50TGlzdGVuZXIoJ29ubGluZScsICgpID0+IHtcbiAgICAgIGNvbnN0IG1zZzogVG9Xb3JrZXIgPSB7IGZvcmdldEZhaWx1cmVzOiB0cnVlIH07XG4gICAgICBmb3IgKGNvbnN0IHcgb2YgdGhpcy53b3JrZXJzKSB3Py5wb3N0TWVzc2FnZShtc2cpO1xuICAgICAgZm9yIChjb25zdCBwIG9mIHRoaXMuZ2FwcGVkKSBwLm5ldHdvcmtCYWNrKCk7XG4gICAgfSk7XG4gIH1cblxuICAvKiogV29ya2VyIGZvciBhIHRpbGVkIHNvdXJjZTogdGhlIHNhbWUgc291cmNlIGFsd2F5cyBnb2VzIHRvIHRoZSBzYW1lIHdvcmtlciAoc28gaXRzIGNhY2hlIGlzIHNoYXJlZCkuICovXG4gIHJvdXRlKHNvdXJjZTogc3RyaW5nKTogbnVtYmVyIHtcbiAgICBsZXQgdyA9IHRoaXMucm91dGVzLmdldChzb3VyY2UpO1xuICAgIGlmICh3ID09PSB1bmRlZmluZWQpIHRoaXMucm91dGVzLnNldChzb3VyY2UsIHcgPSAxICsgKHRoaXMucm91dGVzLnNpemUgJSB0aGlzLnRpbGVkQ291bnQpKTtcbiAgICByZXR1cm4gdztcbiAgfVxuXG4gIC8qKlxuICAgKiBSdW4gYSBqb2IsIG9yIHJldHVybiB1bmRlZmluZWQgd2hlbiB0aGF0IHdvcmtlciBhbHJlYWR5IGhhcyBhIGZ1bGwgcXVldWUgKENlc2l1bSByZXRyaWVzIG5leHRcbiAgICogZnJhbWUpLiBgbG9jYWxgID0gdGhlIGpvYiBuZWVkcyBubyByZW1vdGUgZG93bmxvYWQ6IHRob3NlIGhhdmUgdGhlaXIgb3duLCBsb25nZXIgcXVldWUgc29cbiAgICogdGhleSBhcmUgbmV2ZXIgc3R1Y2sgYmVoaW5kIHRpbGVzIHRoYXQgd2FpdCBmb3IgYSBzbG93IHNlcnZlci5cbiAgICovXG4gIHJ1bih3b3JrZXI6IG51bWJlciwgam9iOiBKb2IsIG93bmVyOiBSZXByb2plY3RlZEltYWdlcnlQcm92aWRlciwgbG9jYWwgPSBmYWxzZSwgcmVxdWVzdD86IEltYWdlcnlSZXF1ZXN0KTogUHJvbWlzZTxJbWFnZUJpdG1hcD4gfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IHcgPSB0aGlzLndvcmtlcnNbd29ya2VyXTtcbiAgICBpZiAoIXcpIHJldHVybiBQcm9taXNlLnJlc29sdmUoYmxhbmtUaWxlKCkpO1xuICAgIGNvbnN0IGNvdW50ID0gbG9jYWwgPyB0aGlzLmxvY2FsIDogdGhpcy5idXN5O1xuICAgIGlmIChjb3VudFt3b3JrZXJdID49IChsb2NhbCA/IExPQ0FMX1FVRVVFIDogd29ya2VyID09PSAwID8gUkFTVEVSX1FVRVVFIDogVElMRURfUVVFVUUpKSB7IHRoaXMuc3RhdHMucmVmdXNlZCsrOyByZXR1cm4gdW5kZWZpbmVkOyB9XG4gICAgY291bnRbd29ya2VyXSsrO1xuICAgIHRoaXMuc3RhdHMuYXNrZWQrKztcbiAgICB0aGlzLnN0YXRzLmRlZXBlc3Rbam9iLmtpbmRdID0gTWF0aC5tYXgodGhpcy5zdGF0cy5kZWVwZXN0W2pvYi5raW5kXSA/PyAwLCBqb2IubGV2ZWwpO1xuICAgIGNvbnN0IGlkID0gdGhpcy5uZXh0SWQrKztcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKGRvbmUsIHJlamVjdCkgPT4ge1xuICAgICAgdGhpcy5qb2JzLnNldChpZCwgeyB3b3JrZXIsIG93bmVyLCBkb25lLCByZWplY3QsIHJlcXVlc3QsIGF0OiBwZXJmb3JtYW5jZS5ub3coKSwga2luZDogam9iLmtpbmQsIGxvY2FsLCByZWN0OiBqb2IucmVjdCB9KTtcbiAgICAgIGlmIChyZXF1ZXN0KSB7XG4gICAgICAgIGNvbnN0IHByZXZpb3VzID0gcmVxdWVzdC5jYW5jZWxGdW5jdGlvbjtcbiAgICAgICAgcmVxdWVzdC5jYW5jZWxGdW5jdGlvbiA9ICgpID0+IHsgcHJldmlvdXM/LigpOyB0aGlzLmNhbmNlbChpZCk7IH07XG4gICAgICAgIC8vIEEgY3VzdG9tIHByb3ZpZGVyIGRvZXMgbm90IGVudGVyIENlc2l1bSdzIFVSTCBzY2hlZHVsZXIsIHdoaWNoIG5vcm1hbGx5IGNhbGxzXG4gICAgICAgIC8vIGNhbmNlbEZ1bmN0aW9uLiBIb25vdXIgYW4gZXhwbGljaXQgY2FuY2VsIGltbWVkaWF0ZWx5IGhlcmUgdG9vLlxuICAgICAgICBjb25zdCBjYW5jZWwgPSByZXF1ZXN0LmNhbmNlbDtcbiAgICAgICAgaWYgKGNhbmNlbCkgcmVxdWVzdC5jYW5jZWwgPSAoKSA9PiB7IGNhbmNlbC5jYWxsKHJlcXVlc3QpOyB0aGlzLmNhbmNlbChpZCk7IH07XG4gICAgICAgIGlmIChyZXF1ZXN0LmNhbmNlbGxlZCkgdGhpcy5jYW5jZWwoaWQpO1xuICAgICAgfVxuICAgICAgdm9pZCB0aGlzLmZsaXAudGhlbihmbGlwUm93cyA9PiB7IGlmICh0aGlzLmpvYnMuaGFzKGlkKSkgeyBjb25zdCBtc2c6IFRvV29ya2VyID0geyBpZCwgam9iLCBmbGlwUm93cyB9OyB3LnBvc3RNZXNzYWdlKG1zZyk7IH0gfSk7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNhbmNlbChpZDogbnVtYmVyKSB7XG4gICAgY29uc3QgaiA9IHRoaXMuam9icy5nZXQoaWQpO1xuICAgIGlmICghaikgcmV0dXJuO1xuICAgIHRoaXMuam9icy5kZWxldGUoaWQpO1xuICAgIChqLmxvY2FsID8gdGhpcy5sb2NhbCA6IHRoaXMuYnVzeSlbai53b3JrZXJdLS07XG4gICAgdGhpcy5zdGF0cy5jYW5jZWxsZWQrKztcbiAgICB0aGlzLndvcmtlcnNbai53b3JrZXJdPy5wb3N0TWVzc2FnZSh7IGNhbmNlbDogaWQgfSBzYXRpc2ZpZXMgVG9Xb3JrZXIpO1xuICAgIGlmIChqLnJlcXVlc3QpIHtcbiAgICAgIC8vIENlc2l1bSB0aGVuIHJldHVybnMgdGhpcyB0aWxlIHRvIFVOTE9BREVELCByZWFkeSB0byB0cnkgd2hlbiBpdCBpcyBzZWVuIGFnYWluLlxuICAgICAgai5yZXF1ZXN0LnN0YXRlID0gUmVxdWVzdFN0YXRlLkNBTkNFTExFRDtcbiAgICAgIGoucmVqZWN0KG5ldyBET01FeGNlcHRpb24oJ1RpbGUgbGVmdCB0aGUgdmlldycsICdBYm9ydEVycm9yJykpO1xuICAgIH0gZWxzZSBqLmRvbmUocGFyZW50TWFya0JpdG1hcCgpKTtcbiAgfVxuXG4gIGNhbmNlbE91dHNpZGUocmVjdGFuZ2xlczogcmVhZG9ubHkgUmVjdFtdKSB7XG4gICAgY29uc3Qgbm93ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgZm9yIChjb25zdCBbaWQsIGpdIG9mIHRoaXMuam9icykge1xuICAgICAgaWYgKGoua2luZCAhPT0gJ3Bob3RvJyB8fCBub3cgLSBqLmF0IDwgMzUwKSBjb250aW51ZTtcbiAgICAgIGlmICghcmVjdGFuZ2xlcy5zb21lKHIgPT4gcmVjdGFuZ2xlc092ZXJsYXAoai5yZWN0LCByKSkpIHRoaXMuY2FuY2VsKGlkKTtcbiAgICB9XG4gIH1cblxuICAvKiogVGVsbCBvbmUgd29ya2VyIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBhIHRpbGUgam9iIChlLmcuIHdoaWNoIHB5cmFtaWQgc3F1YXJlcyBhcmUgc3RvcmVkIHdpdGggdGhlIGFwcCkuICovXG4gIHRlbGwod29ya2VyOiBudW1iZXIsIG1zZzogVG9Xb3JrZXIpIHsgdGhpcy53b3JrZXJzW3dvcmtlcl0/LnBvc3RNZXNzYWdlKG1zZyk7IH1cblxuICB3YXJtU2NpZW5jZShzb3VyY2VzOiBTY2llbmNlUmFzdGVyU291cmNlW10sIHByb2dyZXNzPzogKGZyYWM6IG51bWJlcikgPT4gdm9pZCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGlmICghdGhpcy53b3JrZXJzW3RoaXMuc2NpZW5jZVdvcmtlcl0pIHJldHVybiBQcm9taXNlLnJlc29sdmUoZmFsc2UpO1xuICAgIGNvbnN0IHdhcm1JZCA9IHRoaXMubmV4dElkKys7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgdGhpcy5zY2llbmNlV2FybS5zZXQod2FybUlkLCB7IHJlc29sdmUsIHByb2dyZXNzIH0pO1xuICAgICAgdGhpcy50ZWxsKHRoaXMuc2NpZW5jZVdvcmtlciwgeyB3YXJtU2NpZW5jZTogc291cmNlcywgd2FybUlkIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgc2NpZW5jZVZhbHVlKHNvdXJjZTogU2NpZW5jZVJhc3RlclNvdXJjZSwgbGF0OiBudW1iZXIsIGxvbjogbnVtYmVyKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gICAgaWYgKCF0aGlzLndvcmtlcnNbdGhpcy5zY2llbmNlV29ya2VyXSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZShudWxsKTtcbiAgICBjb25zdCB2YWx1ZUlkID0gdGhpcy5uZXh0SWQrKztcbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICB0aGlzLnNjaWVuY2VWYWx1ZXMuc2V0KHZhbHVlSWQsIHJlc29sdmUpO1xuICAgICAgdGhpcy50ZWxsKHRoaXMuc2NpZW5jZVdvcmtlciwgeyBzY2llbmNlVmFsdWU6IHsgc291cmNlLCBsYXQsIGxvbiB9LCB2YWx1ZUlkIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBmaW5pc2goeyBpZCwgYml0bWFwLCBnYXBzLCByZWNvdmVyZWQsIHBhcmVudCwgbmV0LCB0cmFmZmljLCBjYWNoZSwgd2FybWVkLCB3YXJtRnJhYywgd2FybU9rLCB2YWx1ZUlkLCB2YWx1ZSB9OiBGcm9tV29ya2VyLCB3b3JrZXI6IG51bWJlcikge1xuICAgIGlmIChjYWNoZSkge1xuICAgICAgdGhpcy5zdGF0cy5jYWNoZXNbd29ya2VyXSA9IGNhY2hlO1xuICAgICAgdGhpcy5zdGF0cy5kZWNvZGVkQnl0ZXMgPSB0aGlzLnN0YXRzLmNhY2hlcy5yZWR1Y2UoKG4sIGMpID0+IG4gKyAoYz8ucmV0YWluZWRCeXRlcyA/PyAwKSwgMCk7XG4gICAgICB0aGlzLnN0YXRzLmRlY29kZWRJbWFnZXMgPSB0aGlzLnN0YXRzLmNhY2hlcy5yZWR1Y2UoKG4sIGMpID0+IG4gKyAoYz8ucmV0YWluZWRDb3VudCA/PyAwKSwgMCk7XG4gICAgfVxuICAgIGlmICh3YXJtZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3Qgam9iID0gdGhpcy5zY2llbmNlV2FybS5nZXQod2FybWVkKTtcbiAgICAgIGpvYj8ucHJvZ3Jlc3M/Lih3YXJtRnJhYyA/PyAwKTtcbiAgICAgIGlmICh3YXJtRnJhYyA9PT0gMSkgeyB0aGlzLnNjaWVuY2VXYXJtLmRlbGV0ZSh3YXJtZWQpOyBqb2I/LnJlc29sdmUod2FybU9rICE9PSBmYWxzZSk7IH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHZhbHVlSWQgIT09IHVuZGVmaW5lZCkgeyB0aGlzLnNjaWVuY2VWYWx1ZXMuZ2V0KHZhbHVlSWQpPy4odmFsdWUgPz8gbnVsbCk7IHRoaXMuc2NpZW5jZVZhbHVlcy5kZWxldGUodmFsdWVJZCk7IHJldHVybjsgfVxuICAgIGlmICh0cmFmZmljKSB7XG4gICAgICB0aGlzLnRyYWZmaWNbd29ya2VyXSA9IHRyYWZmaWM7XG4gICAgICBjb25zdCB0b3RhbHM6IE5vbk51bGxhYmxlPEZyb21Xb3JrZXJbJ3RyYWZmaWMnXT4gPSB7fTtcbiAgICAgIGZvciAoY29uc3QgcmVjb3JkIG9mIHRoaXMudHJhZmZpYykgaWYgKHJlY29yZCkgZm9yIChjb25zdCBbc2l0ZSwgdF0gb2YgT2JqZWN0LmVudHJpZXMocmVjb3JkKSkge1xuICAgICAgICBjb25zdCBzID0gdG90YWxzW3NpdGVdID8/PSB7IHJlcXVlc3RzOiAwLCBieXRlczogMCB9OyBzLnJlcXVlc3RzICs9IHQucmVxdWVzdHM7IHMuYnl0ZXMgKz0gdC5ieXRlcztcbiAgICAgIH1cbiAgICAgIHRoaXMuc3RhdHMudHJhZmZpYyA9IHRvdGFscztcbiAgICB9XG4gICAgaWYgKHJlY292ZXJlZCkgZm9yIChjb25zdCBwIG9mIHRoaXMuZ2FwcGVkKSBpZiAocC53b3JrZXIgPT09IHdvcmtlcikgcC5uZXR3b3JrQmFjaygpO1xuICAgIGlmIChuZXQpIHtcbiAgICAgIHRoaXMubmV0W3dvcmtlcl0gPSBuZXQ7XG4gICAgICB0aGlzLnN0YXRzLmZpbGVzID0gdGhpcy5zdGF0cy5yZW1vdGUgPSB0aGlzLnN0YXRzLmZhaWxlZCA9IDA7XG4gICAgICBmb3IgKGNvbnN0IG4gb2YgdGhpcy5uZXQpIHsgdGhpcy5zdGF0cy5maWxlcyArPSBuWzBdOyB0aGlzLnN0YXRzLnJlbW90ZSArPSBuWzFdOyB0aGlzLnN0YXRzLmZhaWxlZCArPSBuWzJdOyB9XG4gICAgfVxuICAgIGNvbnN0IGogPSB0aGlzLmpvYnMuZ2V0KGlkKTtcbiAgICBpZiAoIWopIHsgYml0bWFwPy5jbG9zZSgpOyByZXR1cm47IH1cbiAgICB0aGlzLmpvYnMuZGVsZXRlKGlkKTtcbiAgICAoai5sb2NhbCA/IHRoaXMubG9jYWwgOiB0aGlzLmJ1c3kpW2oud29ya2VyXS0tO1xuICAgIGNvbnN0IG1zID0gcGVyZm9ybWFuY2Uubm93KCkgLSBqLmF0O1xuICAgIHRoaXMuc3RhdHMuYW5zd2VyZWQrKzsgdGhpcy5zdGF0cy5sYXN0TXMgPSBtczsgdGhpcy5zdGF0cy50b3RhbE1zICs9IG1zOyB0aGlzLnN0YXRzLnNsb3dlc3RNcyA9IE1hdGgubWF4KHRoaXMuc3RhdHMuc2xvd2VzdE1zLCBtcyk7XG4gICAgaWYgKGdhcHMpIHtcbiAgICAgIHRoaXMuZ2FwcGVkLmFkZChqLm93bmVyKTsgai5vd25lci5ub3RlR2FwcygpO1xuICAgICAgaWYgKGoua2luZCA9PT0gJ2Jhc2UnKSBiYXNlQnJva2UoKTtcbiAgICAgIC8vIEZhaWxlZCBmaW5hbCB0aWxlcyB3YWxrIGRvd24gdGhlaXIgYW5jZXN0b3IgY2hhaW4uIExldCB0aGF0IHdhbGsgZmluaXNoLCB0b286XG4gICAgICAvLyBkZWZlcnJpbmcgYW4gaW50ZXJtZWRpYXRlIGFuY2VzdG9yIG9mZmxpbmUgd291bGQga2VlcCB0aWxlc0xvYWRlZCBmYWxzZSBmb3JldmVyLlxuICAgICAgaWYgKGoua2luZCA9PT0gJ3Bob3RvJykgcGhvdG9HYXRlQmFja29mZlVudGlsID0gcGVyZm9ybWFuY2Uubm93KCkgKyBSRVRSWV9NUztcbiAgICB9XG4gICAgaWYgKHBhcmVudCkgdGhpcy5zdGF0cy5wYXJlbnRzKys7XG4gICAgai5kb25lKHBhcmVudCA/IHBhcmVudE1hcmtCaXRtYXAoKSA6IGJpdG1hcCA/PyBibGFua1RpbGUoKSk7XG4gIH1cblxuICAvKiogSm9icyBoYW5kZWQgdG8gdGhlIHdvcmtlcnMgYW5kIG5vdCBhbnN3ZXJlZCB5ZXQuICovXG4gIHBlbmRpbmcoKTogbnVtYmVyIHsgcmV0dXJuIHRoaXMuam9icy5zaXplOyB9XG5cbiAgcGVuZGluZ1Bob3RvcygpOiBudW1iZXIgeyBsZXQgbiA9IDA7IGZvciAoY29uc3QgaiBvZiB0aGlzLmpvYnMudmFsdWVzKCkpIGlmIChqLmtpbmQgPT09ICdwaG90bycpIG4rKzsgcmV0dXJuIG47IH1cblxuICAvKiogRm9yIHRlc3RzOiB3aGF0IGlzIHdhaXRpbmcsIHBlciBraW5kIG9mIGpvYiwgYW5kIGZvciBob3cgbG9uZyAobXMpLiAqL1xuICB3YWl0aW5nKCk6IHsga2luZDogc3RyaW5nOyB3b3JrZXI6IG51bWJlcjsgbXM6IG51bWJlciB9W10ge1xuICAgIGNvbnN0IG5vdyA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgIHJldHVybiBbLi4udGhpcy5qb2JzLnZhbHVlcygpXS5tYXAoaiA9PiAoeyBraW5kOiBqLmtpbmQsIHdvcmtlcjogai53b3JrZXIsIG1zOiBNYXRoLnJvdW5kKG5vdyAtIGouYXQpIH0pKTtcbiAgfVxuXG4gIC8qKiBBIGxheWVyIGhhcyByZWxvYWRlZCBpdHMgdGlsZXMuICovXG4gIHNldHRsZWQocDogUmVwcm9qZWN0ZWRJbWFnZXJ5UHJvdmlkZXIpIHsgdGhpcy5nYXBwZWQuZGVsZXRlKHApOyB9XG5cbiAgLyoqIEEgd29ya2VyIHRoYXQgY3Jhc2hlZCBvciBjb3VsZCBub3Qgc3RhcnQ6IGl0cyB0aWxlcyAoYW5kIGxhdGVyIG9uZXMpIGNvbWUgYmFjayB0cmFuc3BhcmVudC4gKi9cbiAgcHJpdmF0ZSBmYWlsKHdvcmtlcjogbnVtYmVyLCBlOiBFcnJvckV2ZW50KSB7XG4gICAgY29uc29sZS5lcnJvcignSW1hZ2VyeSB3b3JrZXIgc3RvcHBlZDonLCBlLm1lc3NhZ2UpO1xuICAgIHRoaXMud29ya2Vyc1t3b3JrZXJdPy50ZXJtaW5hdGUoKTtcbiAgICB0aGlzLndvcmtlcnNbd29ya2VyXSA9IG51bGw7XG4gICAgZm9yIChjb25zdCBbaWQsIGpdIG9mIHRoaXMuam9icykgaWYgKGoud29ya2VyID09PSB3b3JrZXIpIHsgdGhpcy5qb2JzLmRlbGV0ZShpZCk7IGouZG9uZShibGFua1RpbGUoKSk7IH1cbiAgICB0aGlzLmJ1c3lbd29ya2VyXSA9IHRoaXMubG9jYWxbd29ya2VyXSA9IDA7XG4gIH1cbn1cblxubGV0IHBvb2w6IEltYWdlcnlXb3JrZXJzIHwgdW5kZWZpbmVkO1xuY29uc3Qgd29ya2VycyA9ICgpID0+IChwb29sID8/PSBuZXcgSW1hZ2VyeVdvcmtlcnMoKSk7XG5cbi8qKiBSZWN0YW5nbGVzIGhlcmUgYXJlIG9yZGluYXJ5IGRpc3BsYXktZ3JpZCB0aWxlczsgbm9uZSBjcm9zc2VzIHRoZSBkYXRlIGxpbmUuICovXG5jb25zdCByZWN0YW5nbGVzT3ZlcmxhcCA9IChhOiBSZWN0LCBiOiBSZWN0KSA9PiBhLndlc3QgPCBiLmVhc3QgJiYgYS5lYXN0ID4gYi53ZXN0ICYmIGEuc291dGggPCBiLm5vcnRoICYmIGEubm9ydGggPiBiLnNvdXRoO1xuXG5pbnRlcmZhY2UgUGhvdG9WaWV3IHtcbiAgbG9uOiBudW1iZXI7IGxhdDogbnVtYmVyOyBsZXZlbDogbnVtYmVyO1xuICBjYW1lcmFMb246IG51bWJlcjsgY2FtZXJhTGF0OiBudW1iZXI7IGdyb3VuZEhlaWdodDogbnVtYmVyO1xuICBjYW1lcmE6IENhcnRlc2lhbjM7IG1ldHJlc1BlckRpc3RhbmNlOiBudW1iZXI7IGNoYW5nZWRBdDogbnVtYmVyO1xufVxubGV0IHBob3RvVmlldzogUGhvdG9WaWV3IHwgdW5kZWZpbmVkO1xubGV0IHNhdmVkUHJlbG9hZHM6IHsgdmlld2VyOiBWaWV3ZXI7IGFuY2VzdG9yczogYm9vbGVhbjsgc2libGluZ3M6IGJvb2xlYW4gfSB8IHVuZGVmaW5lZDtcbmxldCBwaG90b0dhdGVCYWNrb2ZmVW50aWwgPSAwO1xuY29uc3QgZGVmZXJyZWRQaG90b3MgPSBuZXcgTWFwPHN0cmluZywgeyByZWN0OiBSZWN0OyBsZXZlbDogbnVtYmVyOyBhdDogbnVtYmVyIH0+KCk7XG5jb25zdCBhZG1pdHRlZFBob3RvcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuY29uc3Qgdmlld1RpbGluZyA9IG5ldyBHZW9ncmFwaGljVGlsaW5nU2NoZW1lKHsgZWxsaXBzb2lkOiBNT09OX0VMTElQU09JRCB9KTtcbmNvbnN0IHZpZXdQaXhlbCA9IG5ldyBDYXJ0ZXNpYW4yKCksIHZpZXdIaXQgPSBuZXcgQ2FydGVzaWFuMygpLCB2aWV3Q2FydG9ncmFwaGljID0gbmV3IENhcnRvZ3JhcGhpYygpLCBkaXN0YW5jZVBvaW50ID0gbmV3IENhcnRlc2lhbjMoKTtcbmNvbnN0IHBob3RvS2V5ID0gKHI6IFJlY3QsIGxldmVsOiBudW1iZXIpID0+IGAke2xldmVsfS8ke3Iud2VzdH0vJHtyLnNvdXRofWA7XG5jb25zdCBjbGFtcFZhbHVlID0gKHY6IG51bWJlciwgbG86IG51bWJlciwgaGk6IG51bWJlcikgPT4gTWF0aC5tYXgobG8sIE1hdGgubWluKGhpLCB2KSk7XG5jb25zdCBsZXZlbEF0U3BhY2luZyA9IChtZXRyZXM6IG51bWJlcikgPT4gY2xhbXBWYWx1ZShNYXRoLnJvdW5kKE1hdGgubG9nMihwaXhlbE1ldHJlcygwKSAvIE1hdGgubWF4KDAuMDAxLCBtZXRyZXMpKSksIDgsIDE3KTtcblxuLyoqIEVzdGltYXRlIHRoZSBwaG90byBwaXhlbHMgYWN0dWFsbHkgbmVlZGVkIGJ5IHRoaXMgY2FtZXJhLCByYXRoZXIgdGhhbiB2aXNpdGluZyBldmVyeVxuICogaW50ZXJtZWRpYXRlIHJlc29sdXRpb24gb24gdGhlIHdheSBkb3duLiBBbGwgY29vcmRpbmF0ZXMgaGVyZSB1c2UgQ2VzaXVtJ3MgZGlzcGxheSBmcmFtZS4gKi9cbmZ1bmN0aW9uIHVwZGF0ZVBob3RvVmlldyh2aWV3ZXI6IFZpZXdlcikge1xuICBjb25zdCB7IHNjZW5lLCBjYW1lcmEgfSA9IHZpZXdlciwgZ2xvYmUgPSBzY2VuZS5nbG9iZTtcbiAgY29uc3QgZnJ1c3R1bSA9IGNhbWVyYS5mcnVzdHVtIGFzIHsgZm92eT86IG51bWJlcjsgZm92PzogbnVtYmVyIH07XG4gIGNvbnN0IGZvdnkgPSBmcnVzdHVtLmZvdnkgPz8gZnJ1c3R1bS5mb3Y7XG4gIGlmICghZm92eSB8fCAhc2NlbmUuZHJhd2luZ0J1ZmZlckhlaWdodCkgcmV0dXJuO1xuICB2aWV3UGl4ZWwueCA9IHNjZW5lLmNhbnZhcy5jbGllbnRXaWR0aCAvIDI7IHZpZXdQaXhlbC55ID0gc2NlbmUuY2FudmFzLmNsaWVudEhlaWdodCAvIDI7XG4gIGNvbnN0IHJheSA9IGNhbWVyYS5nZXRQaWNrUmF5KHZpZXdQaXhlbCksIGhpdCA9IHJheSAmJiBnbG9iZS5waWNrKHJheSwgc2NlbmUsIHZpZXdIaXQpO1xuICBjb25zdCBjYW1lcmFMTCA9IGNhbWVyYS5wb3NpdGlvbkNhcnRvZ3JhcGhpYztcbiAgbGV0IGxvbiA9IGNhbWVyYUxMLmxvbmdpdHVkZSwgbGF0ID0gY2FtZXJhTEwubGF0aXR1ZGU7XG4gIGxldCBncm91bmRIZWlnaHQgPSBnbG9iZS5nZXRIZWlnaHQoY2FtZXJhTEwpID8/IDA7XG4gIGxldCBkaXN0YW5jZSA9IE1hdGgubWF4KDEsIE1hdGguYWJzKGNhbWVyYUxMLmhlaWdodCAtIGdyb3VuZEhlaWdodCkpO1xuICBpZiAoaGl0KSB7XG4gICAgY29uc3QgYXQgPSBNT09OX0VMTElQU09JRC5jYXJ0ZXNpYW5Ub0NhcnRvZ3JhcGhpYyhoaXQsIHZpZXdDYXJ0b2dyYXBoaWMpO1xuICAgIGlmIChhdCkgeyBsb24gPSBhdC5sb25naXR1ZGU7IGxhdCA9IGF0LmxhdGl0dWRlOyBncm91bmRIZWlnaHQgPSBhdC5oZWlnaHQ7IH1cbiAgICBkaXN0YW5jZSA9IE1hdGgubWF4KDEsIENhcnRlc2lhbjMuZGlzdGFuY2UoY2FtZXJhLnBvc2l0aW9uV0MsIGhpdCkpO1xuICB9XG4gIGNvbnN0IG1ldHJlc1BlckRpc3RhbmNlID0gMiAqIE1hdGgudGFuKGZvdnkgLyAyKSAqIGdsb2JlLm1heGltdW1TY3JlZW5TcGFjZUVycm9yIC8gc2NlbmUuZHJhd2luZ0J1ZmZlckhlaWdodDtcbiAgbGV0IGxldmVsID0gbGV2ZWxBdFNwYWNpbmcoZGlzdGFuY2UgKiBtZXRyZXNQZXJEaXN0YW5jZSk7XG4gIGNvbnN0IHh5ID0gdmlld1RpbGluZy5wb3NpdGlvblRvVGlsZVhZKG5ldyBDYXJ0b2dyYXBoaWMobG9uLCBsYXQpLCBsZXZlbCk7XG4gIGlmICh4eSkgbGV2ZWwgPSBNYXRoLm1pbihsZXZlbCwgcGhvdG9NYXhMZXZlbCh2aWV3VGlsaW5nLnRpbGVYWVRvUmVjdGFuZ2xlKHh5LngsIHh5LnksIGxldmVsKSkpO1xuICBjb25zdCBvbGQgPSBwaG90b1ZpZXcsIG5vdyA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCBjaGFuZ2VkID0gIW9sZCB8fCBvbGQubGV2ZWwgIT09IGxldmVsIHx8IENhcnRlc2lhbjMuZGlzdGFuY2VTcXVhcmVkKG9sZC5jYW1lcmEsIGNhbWVyYS5wb3NpdGlvbldDKSA+IE1hdGgubWF4KDEsIGRpc3RhbmNlICogZGlzdGFuY2UgKiAwLjAwMDAwMSlcbiAgICB8fCBNYXRoLmFicyhNYXRoLmF0YW4yKE1hdGguc2luKGxvbiAtIG9sZC5sb24pLCBNYXRoLmNvcyhsb24gLSBvbGQubG9uKSkpID4gcGl4ZWxEZWcobGV2ZWwpICogTWF0aC5QSSAvIDE4MFxuICAgIHx8IE1hdGguYWJzKGxhdCAtIG9sZC5sYXQpID4gcGl4ZWxEZWcobGV2ZWwpICogTWF0aC5QSSAvIDE4MDtcbiAgcGhvdG9WaWV3ID0geyBsb24sIGxhdCwgbGV2ZWwsIGNhbWVyYUxvbjogY2FtZXJhTEwubG9uZ2l0dWRlLCBjYW1lcmFMYXQ6IGNhbWVyYUxMLmxhdGl0dWRlLCBncm91bmRIZWlnaHQsXG4gICAgY2FtZXJhOiBDYXJ0ZXNpYW4zLmNsb25lKGNhbWVyYS5wb3NpdGlvbldDKSwgbWV0cmVzUGVyRGlzdGFuY2UsIGNoYW5nZWRBdDogY2hhbmdlZCA/IG5vdyA6IG9sZC5jaGFuZ2VkQXQgfTtcbiAgaWYgKGNoYW5nZWQpIHsgZGVmZXJyZWRQaG90b3MuY2xlYXIoKTsgYWRtaXR0ZWRQaG90b3MuY2xlYXIoKTsgfVxuICBwb29sPy50ZWxsKHBvb2wucm91dGUoJ3RyZWsnKSwgeyBwaG90b1ZpZXc6IHsgbG9uLCBsYXQsIGxldmVsIH0gfSk7XG4gIGlmIChsZXZlbCA+IDEwKSB7XG4gICAgaWYgKCFzYXZlZFByZWxvYWRzIHx8IHNhdmVkUHJlbG9hZHMudmlld2VyICE9PSB2aWV3ZXIpIHNhdmVkUHJlbG9hZHMgPSB7IHZpZXdlciwgYW5jZXN0b3JzOiBnbG9iZS5wcmVsb2FkQW5jZXN0b3JzLCBzaWJsaW5nczogZ2xvYmUucHJlbG9hZFNpYmxpbmdzIH07XG4gICAgLy8gYXBwbHlRdWFsaXR5IGNhbiB1cGRhdGUgdGhlc2Ugd2hpbGUgdGhpcyB2aWV3IGlzIG9wZW46IHJlbWVtYmVyIGl0cyBuZXcgY2hvaWNlLlxuICAgIGVsc2UgaWYgKGdsb2JlLnByZWxvYWRBbmNlc3RvcnMgfHwgZ2xvYmUucHJlbG9hZFNpYmxpbmdzKSB7IHNhdmVkUHJlbG9hZHMuYW5jZXN0b3JzID0gZ2xvYmUucHJlbG9hZEFuY2VzdG9yczsgc2F2ZWRQcmVsb2Fkcy5zaWJsaW5ncyA9IGdsb2JlLnByZWxvYWRTaWJsaW5nczsgfVxuICAgIGdsb2JlLnByZWxvYWRBbmNlc3RvcnMgPSBmYWxzZTsgZ2xvYmUucHJlbG9hZFNpYmxpbmdzID0gZmFsc2U7XG4gIH0gZWxzZSBpZiAoc2F2ZWRQcmVsb2Fkcz8udmlld2VyID09PSB2aWV3ZXIpIHtcbiAgICBnbG9iZS5wcmVsb2FkQW5jZXN0b3JzID0gc2F2ZWRQcmVsb2Fkcy5hbmNlc3RvcnM7IGdsb2JlLnByZWxvYWRTaWJsaW5ncyA9IHNhdmVkUHJlbG9hZHMuc2libGluZ3M7XG4gICAgc2F2ZWRQcmVsb2FkcyA9IHVuZGVmaW5lZDsgZGVmZXJyZWRQaG90b3MuY2xlYXIoKTsgYWRtaXR0ZWRQaG90b3MuY2xlYXIoKTtcbiAgfVxufVxuXG4vKiogQ2FtZXJhLWRlcGVuZGVudCB3YWl0cyBzdGF5IFVOTE9BREVEIGluIENlc2l1bSwgc28gYSBsYXRlciB6b29tLW91dCBjYW4gcmVxdWVzdCB0aGVtLlxuICogQSBkaXNjYXJkIG1hcmtlciB3b3VsZCBtYWtlIHRoZSBzYW1lIHVzZWZ1bCB0aWxlIElOVkFMSUQgdW50aWwgaXQgbGVmdCB0aGUgY2FjaGUuICovXG5mdW5jdGlvbiBkZWZlclBob3RvKHJlY3Q6IFJlY3QsIGxldmVsOiBudW1iZXIpOiBib29sZWFuIHtcbiAgY29uc3QgdmlldyA9IHBob3RvVmlldztcbiAgaWYgKCF2aWV3IHx8IHZpZXcubGV2ZWwgPD0gMTAgfHwgbGV2ZWwgPD0gOCB8fCBwZXJmb3JtYW5jZS5ub3coKSA8IHBob3RvR2F0ZUJhY2tvZmZVbnRpbCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBrZXkgPSBwaG90b0tleShyZWN0LCBsZXZlbCk7XG4gIGlmIChhZG1pdHRlZFBob3Rvcy5oYXMoa2V5KSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBtaWRkbGUgPSAocmVjdC53ZXN0ICsgcmVjdC5lYXN0KSAvIDI7XG4gIGNvbnN0IGNhbWVyYUxvbiA9IG1pZGRsZSArIE1hdGguYXRhbjIoTWF0aC5zaW4odmlldy5jYW1lcmFMb24gLSBtaWRkbGUpLCBNYXRoLmNvcyh2aWV3LmNhbWVyYUxvbiAtIG1pZGRsZSkpO1xuICBjb25zdCBsb24gPSBjbGFtcFZhbHVlKGNhbWVyYUxvbiwgcmVjdC53ZXN0LCByZWN0LmVhc3QpLCBsYXQgPSBjbGFtcFZhbHVlKHZpZXcuY2FtZXJhTGF0LCByZWN0LnNvdXRoLCByZWN0Lm5vcnRoKTtcbiAgQ2FydGVzaWFuMy5mcm9tUmFkaWFucyhsb24sIGxhdCwgdmlldy5ncm91bmRIZWlnaHQsIE1PT05fRUxMSVBTT0lELCBkaXN0YW5jZVBvaW50KTtcbiAgY29uc3QgZGlzdGFuY2UgPSBNYXRoLm1heCgxLCBDYXJ0ZXNpYW4zLmRpc3RhbmNlKHZpZXcuY2FtZXJhLCBkaXN0YW5jZVBvaW50KSk7XG4gIGNvbnN0IHRhcmdldCA9IE1hdGgubWluKHZpZXcubGV2ZWwsIHBob3RvTWF4TGV2ZWwocmVjdCksIGxldmVsQXRTcGFjaW5nKGRpc3RhbmNlICogdmlldy5tZXRyZXNQZXJEaXN0YW5jZSkpO1xuICBpZiAobGV2ZWwgPj0gdGFyZ2V0KSByZXR1cm4gZmFsc2U7XG4gIGlmICghZGVmZXJyZWRQaG90b3MuaGFzKGtleSkpIGRlZmVycmVkUGhvdG9zLnNldChrZXksIHsgcmVjdCwgbGV2ZWwsIGF0OiBwZXJmb3JtYW5jZS5ub3coKSB9KTtcbiAgaWYgKHBvb2wpIHBvb2wuc3RhdHMuZGVmZXJyZWQrKztcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKlxuICogQ2FsbCBhZnRlciBhIGZyYW1lIHdoaWxlIHRoZSBjYW1lcmEgbW92ZXMuIENlc2l1bSBrZWVwcyBvbGQgdGVycmFpbiB0aWxlcyBpbiBtZW1vcnksXG4gKiBidXQgb25seSB0aGVzZSB0aWxlcyBhcmUgb24gc2NyZWVuOiBzaGFycCBkb3dubG9hZHMgb3V0c2lkZSB0aGVtIGNhbiBzdG9wLiBUaGUgc2hvcnRcbiAqIGdyYWNlIHBlcmlvZCBsZXRzIHRoZSBmaXJzdCB0ZXJyYWluIGZyYW1lIGNhdGNoIHVwIGFmdGVyIGEgY2FtZXJhIGp1bXAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYW5jZWxPZmZzY3JlZW5JbWFnZXJ5KHZpZXdlcjogVmlld2VyLCBjdWxsID0gdHJ1ZSkge1xuICBpZiAoIXBvb2wgfHwgdmlld2VyLmlzRGVzdHJveWVkKCkpIHJldHVybjtcbiAgdXBkYXRlUGhvdG9WaWV3KHZpZXdlcik7XG4gIGNvbnN0IHN1cmZhY2UgPSAodmlld2VyLnNjZW5lLmdsb2JlIGFzIHVua25vd24gYXMgeyBfc3VyZmFjZT86IHsgX3RpbGVzVG9SZW5kZXI/OiB7IHJlY3RhbmdsZTogUmVjdDsgZGF0YT86IHsgaW1hZ2VyeT86IHsgbG9hZGluZ0ltYWdlcnk/OiB7IHJlY3RhbmdsZTogUmVjdDsgbGV2ZWw6IG51bWJlciB9IH1bXSB9IH1bXSB9IH0pLl9zdXJmYWNlO1xuICBjb25zdCB0aWxlcyA9IHN1cmZhY2U/Ll90aWxlc1RvUmVuZGVyO1xuICBpZiAodGlsZXM/Lmxlbmd0aCkge1xuICAgIGlmIChjdWxsKSBwb29sLmNhbmNlbE91dHNpZGUodGlsZXMubWFwKHRpbGUgPT4gdGlsZS5yZWN0YW5nbGUpKTtcbiAgICAvLyBQZXJzcGVjdGl2ZSB2aWV3cyBjYW4gZ2VudWluZWx5IG5lZWQgYSBjb2Fyc2VyIHRpbGUgZmFyIGZyb20gdGhlIHJvdmVyLiBPbmNlIGZpbmVyXG4gICAgLy8gd29yayBpcyBxdWlldCwgYWRtaXQgYW55IHN1Y2ggdGlsZSBTVElMTCBiZWluZyByZW5kZXJlZC4gQW5jZXN0b3JzIGFsb25lIHN0YXkgc2tpcHBlZCxcbiAgICAvLyBzbyB0aGVpciBxdWV1ZXMgY2Fubm90IGtlZXAgdGlsZXNMb2FkZWQgZmFsc2UgZm9yZXZlci4gTm8gY2FjaGUgc3RhdGUgaXMgaW52YWxpZGF0ZWQuXG4gICAgY29uc3Qgbm93ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgaWYgKHBob3RvVmlldyAmJiBub3cgLSBwaG90b1ZpZXcuY2hhbmdlZEF0ID4gNDAwICYmIHBvb2wucGVuZGluZ1Bob3RvcygpID09PSAwKSB7XG4gICAgICBmb3IgKGNvbnN0IHRpbGUgb2YgdGlsZXMpIGZvciAoY29uc3QgbGluayBvZiB0aWxlLmRhdGE/LmltYWdlcnkgPz8gW10pIHtcbiAgICAgICAgY29uc3QgbG9hZGluZyA9IGxpbmsubG9hZGluZ0ltYWdlcnk7XG4gICAgICAgIGlmICghbG9hZGluZz8ucmVjdGFuZ2xlKSBjb250aW51ZTtcbiAgICAgICAgY29uc3Qga2V5ID0gcGhvdG9LZXkobG9hZGluZy5yZWN0YW5nbGUsIGxvYWRpbmcubGV2ZWwpLCBkZWZlcnJlZCA9IGRlZmVycmVkUGhvdG9zLmdldChrZXkpO1xuICAgICAgICBpZiAoZGVmZXJyZWQgJiYgbm93IC0gZGVmZXJyZWQuYXQgPiA0MDApIHsgYWRtaXR0ZWRQaG90b3MuYWRkKGtleSk7IGRlZmVycmVkUGhvdG9zLmRlbGV0ZShrZXkpOyB2aWV3ZXIuc2NlbmUucmVxdWVzdFJlbmRlcigpOyB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbi8qKiBNYXAgcGljdHVyZXMgYXNrZWQgZm9yIGFuZCBub3QgZmluaXNoZWQgeWV0LCBhY3Jvc3MgYWxsIGxheWVycyAoMCA9IG5vdGhpbmcgaXMgbG9hZGluZykuIEZvciB0aGUgbG9hZGluZyBzY3JlZW4uICovXG5leHBvcnQgZnVuY3Rpb24gaW1hZ2VyeVBlbmRpbmcoKTogbnVtYmVyIHsgcmV0dXJuIHBvb2wgPyBwb29sLnBlbmRpbmcoKSA6IDA7IH1cblxuLy8gU21hbGwgdGVzdC9kZWJ1ZyBob29rIChzY3JpcHRzL2RyaXZlLm1qcyk6IHdoYXQgdGhlIGltYWdlcnkgd29ya2VycyBhcmUgZG9pbmcgcmlnaHQgbm93LlxuKGdsb2JhbFRoaXMgYXMgeyBfX21vb25kYUltYWdlcnk/OiB1bmtub3duIH0pLl9fbW9vbmRhSW1hZ2VyeSA9IHtcbiAgcGVuZGluZzogaW1hZ2VyeVBlbmRpbmcsXG4gIHN0YXRzOiAoKSA9PiAocG9vbCA/IHsgLi4ucG9vbC5zdGF0cywgZGVlcGVzdDogeyAuLi5wb29sLnN0YXRzLmRlZXBlc3QgfSB9IDogbnVsbCksXG4gIHdhaXRpbmc6ICgpID0+IChwb29sID8gcG9vbC53YWl0aW5nKCkgOiBbXSksXG4gIHZpZXc6ICgpID0+IChwaG90b1ZpZXcgPyB7IGxvbjogcGhvdG9WaWV3LmxvbiwgbGF0OiBwaG90b1ZpZXcubGF0LCBsZXZlbDogcGhvdG9WaWV3LmxldmVsLCBkZWZlcnJlZDogZGVmZXJyZWRQaG90b3Muc2l6ZSwgYWRtaXR0ZWQ6IGFkbWl0dGVkUGhvdG9zLnNpemUgfSA6IG51bGwpLFxufTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUaGUgcHJvdmlkZXIgb2JqZWN0IENlc2l1bSB0YWxrcyB0byAodGhlIGZpZWxkcyBvZiBDZXNpdW0ncyBJbWFnZXJ5UHJvdmlkZXIgaW50ZXJmYWNlKS5cblxuaW50ZXJmYWNlIFByb3ZpZGVyT3B0aW9ucyB7XG4gIHJlY3RhbmdsZTogUmVjdGFuZ2xlO1xuICBtYXhpbXVtTGV2ZWw6IG51bWJlcjtcbiAgY3JlZGl0OiBzdHJpbmc7XG4gIHdvcmtlcjogbnVtYmVyO1xuICAvKipcbiAgICogVGhlIHdvcmtlciBqb2IgZm9yIGEgZGlzcGxheSB0aWxlOyBudWxsIHdoZW4gdGhpcyBsYXllciBoYXMgbm90aGluZyB0byBkcmF3IHRoZXJlOyAncGFyZW50J1xuICAgKiB3aGVuIHRoZSB0aWxlIGNvdWxkIG9ubHkgcmVwZWF0IGl0cyBwYXJlbnQgKHRoZSBkYXRhIGVuZHMgYXQgYSBjb2Fyc2VyIGxldmVsKTsgJ3dhaXQnIHdoaWxlXG4gICAqIHRoZSBsYXllciBpcyBub3QgcmVhZHkgdG8gc2F5IChDZXNpdW0gYXNrcyBhZ2FpbiBuZXh0IGZyYW1lKS5cbiAgICovXG4gIGpvYkZvcjogKHJlY3Q6IFJlY3QsIGxldmVsOiBudW1iZXIsIHg6IG51bWJlciwgeTogbnVtYmVyKSA9PiBKb2IgfCBudWxsIHwgJ3BhcmVudCcgfCAnd2FpdCc7XG4gIC8qKiBUcnVlIGZvciBhIGpvYiB0aGF0IHN1cmVseSBuZWVkcyBubyByZW1vdGUgZG93bmxvYWQgKGl0IHRoZW4gbmV2ZXIgd2FpdHMgYmVoaW5kIHNsb3cgZG93bmxvYWRzKS4gKi9cbiAgaXNMb2NhbD86IChqb2I6IEpvYikgPT4gYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIEltYWdlcnlSZXF1ZXN0IHsgc3RhdGU/OiBudW1iZXI7IGNhbmNlbGxlZD86IGJvb2xlYW47IGNhbmNlbEZ1bmN0aW9uPzogKCkgPT4gdm9pZDsgY2FuY2VsPzogKCkgPT4gdm9pZCB9XG5cbmV4cG9ydCBjbGFzcyBSZXByb2plY3RlZEltYWdlcnlQcm92aWRlciB7XG4gIHJlYWRvbmx5IHRpbGluZ1NjaGVtZSA9IG5ldyBHZW9ncmFwaGljVGlsaW5nU2NoZW1lKHsgZWxsaXBzb2lkOiBNT09OX0VMTElQU09JRCB9KTsgLy8gRElTUExBWSBsb24vbGF0XG4gIHJlYWRvbmx5IHJlY3RhbmdsZTogUmVjdGFuZ2xlO1xuICByZWFkb25seSB0aWxlV2lkdGggPSBUSUxFO1xuICByZWFkb25seSB0aWxlSGVpZ2h0ID0gVElMRTtcbiAgcmVhZG9ubHkgbWluaW11bUxldmVsID0gMDsgLy8gYSBoaWdoZXIgbWluaW11bSBtYWtlcyB0aGUgZ2xvYmUgd2FpdCBmb3IgdGhvdXNhbmRzIG9mIHRpbGVzXG4gIHJlYWRvbmx5IG1heGltdW1MZXZlbDogbnVtYmVyO1xuICAvKiogTGV0cyBhIHRpbGUgc2F5IFwia2VlcCBzaG93aW5nIG15IHBhcmVudFwiIChzZWUgcGFyZW50TWFya0JpdG1hcCBhYm92ZSkuICovXG4gIHJlYWRvbmx5IHRpbGVEaXNjYXJkUG9saWN5ID0gZGlzY2FyZFBvbGljeTtcbiAgcmVhZG9ubHkgZXJyb3JFdmVudCA9IG5ldyBFdmVudCgpO1xuICByZWFkb25seSBjcmVkaXQ6IENyZWRpdDtcbiAgcmVhZG9ubHkgcHJveHkgPSB1bmRlZmluZWQ7XG4gIHJlYWRvbmx5IGhhc0FscGhhQ2hhbm5lbCA9IHRydWU7XG4gIC8qKiBTZXQgYnkgQ2VzaXVtJ3MgZ2xvYmUgd2hpbGUgdGhlIGxheWVyIGlzIHNob3duOiBkcm9wcyB0aGUgbGF5ZXIncyB0aWxlcyBhbmQgYXNrcyBmb3IgdGhlbSBhZ2Fpbi4gKi9cbiAgX3JlbG9hZDogKCgpID0+IHZvaWQpIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuICByZWFkb25seSB3b3JrZXI6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBqb2JGb3I6IFByb3ZpZGVyT3B0aW9uc1snam9iRm9yJ107XG4gIHByaXZhdGUgcmVhZG9ubHkgaXNMb2NhbDogUHJvdmlkZXJPcHRpb25zWydpc0xvY2FsJ107XG4gIHByaXZhdGUgZ2FwcyA9IGZhbHNlOyAvLyBzb21lIHRpbGVzIHdlcmUgZHJhd24gd2l0aCBob2xlcyBzaW5jZSB0aGUgbGFzdCByZWxvYWRcbiAgcHJpdmF0ZSByZWxvYWRBdCA9IEluZmluaXR5O1xuICBwcml2YXRlIHJlbG9hZFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBsYXN0UmVsb2FkID0gLUluZmluaXR5O1xuICBwcml2YXRlIHNwYWNpbmcgPSBSRUxPQURfTUlOX1NQQUNJTkdfTVM7XG5cbiAgY29uc3RydWN0b3IobzogUHJvdmlkZXJPcHRpb25zKSB7XG4gICAgdGhpcy5yZWN0YW5nbGUgPSBvLnJlY3RhbmdsZTtcbiAgICB0aGlzLm1heGltdW1MZXZlbCA9IG8ubWF4aW11bUxldmVsO1xuICAgIHRoaXMuY3JlZGl0ID0gbmV3IENyZWRpdChvLmNyZWRpdCk7XG4gICAgdGhpcy53b3JrZXIgPSBvLndvcmtlcjtcbiAgICB0aGlzLmpvYkZvciA9IG8uam9iRm9yO1xuICAgIHRoaXMuaXNMb2NhbCA9IG8uaXNMb2NhbDtcbiAgfVxuXG4gIGdldFRpbGVDcmVkaXRzKCk6IENyZWRpdFtdIHsgcmV0dXJuIFtdOyB9XG5cbiAgcmVxdWVzdEltYWdlKHg6IG51bWJlciwgeTogbnVtYmVyLCBsZXZlbDogbnVtYmVyLCByZXF1ZXN0PzogSW1hZ2VyeVJlcXVlc3QpOiBQcm9taXNlPEltYWdlQml0bWFwPiB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgciA9IHRoaXMudGlsaW5nU2NoZW1lLnRpbGVYWVRvUmVjdGFuZ2xlKHgsIHksIGxldmVsKTtcbiAgICBjb25zdCBqb2IgPSB0aGlzLmpvYkZvcih7IHdlc3Q6IHIud2VzdCwgc291dGg6IHIuc291dGgsIGVhc3Q6IHIuZWFzdCwgbm9ydGg6IHIubm9ydGggfSwgbGV2ZWwsIHgsIHkpO1xuICAgIGlmIChqb2IgPT09ICd3YWl0JykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBpZiAoam9iID09PSAncGFyZW50JykgeyB3b3JrZXJzKCkuc3RhdHMucGFyZW50cysrOyByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHBhcmVudE1hcmtCaXRtYXAoKSk7IH1cbiAgICBpZiAoam9iPy5raW5kID09PSAncGhvdG8nICYmIGRlZmVyUGhvdG8oam9iLnJlY3QsIGxldmVsKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICByZXR1cm4gam9iID8gd29ya2VycygpLnJ1bih0aGlzLndvcmtlciwgam9iLCB0aGlzLCB0aGlzLmlzTG9jYWw/Lihqb2IpID8/IGZhbHNlLCByZXF1ZXN0KSA6IFByb21pc2UucmVzb2x2ZShibGFua1RpbGUoKSk7XG4gIH1cblxuICAvKiogRHJvcCB0aGlzIGxheWVyJ3MgdGlsZXMgYW5kIGFzayBmb3IgdGhlbSBhZ2FpbiBub3cgKHVzZWQgd2hlbiB3aGF0IHRoZSBsYXllciBzaG91bGQgZHJhdyBoYXMgY2hhbmdlZCkuICovXG4gIHJlbG9hZE5vdygpIHtcbiAgICBpZiAoIXRoaXMuX3JlbG9hZCkgcmV0dXJuO1xuICAgIHRoaXMuX3JlbG9hZCgpO1xuICAgIGltYWdlcnlSZWxvYWRlZC5yYWlzZUV2ZW50KCk7XG4gIH1cblxuICBwaWNrRmVhdHVyZXMoKTogdW5kZWZpbmVkIHsgcmV0dXJuIHVuZGVmaW5lZDsgfVxuXG4gIC8qKiBBIHRpbGUgY2FtZSBiYWNrIHdpdGggaG9sZXMgKGEgZG93bmxvYWQgZmFpbGVkKTogcmVsb2FkIG9uY2UgdGhlIHdvcmtlciB3aWxsIHJlYWxseSB0cnkgYWdhaW4uICovXG4gIG5vdGVHYXBzKCkge1xuICAgIHRoaXMuZ2FwcyA9IHRydWU7XG4gICAgdGhpcy5zY2hlZHVsZVJlbG9hZChSRUxPQURfQUZURVJfR0FQU19NUyk7XG4gIH1cblxuICAvKiogVGhlIG5ldHdvcmsgd29ya3MgYWdhaW46IHJlbG9hZCBzb29uIGlmIHRoaXMgbGF5ZXIgaGFzIGhvbGVzLiAqL1xuICBuZXR3b3JrQmFjaygpIHtcbiAgICBpZiAodGhpcy5nYXBzKSB0aGlzLnNjaGVkdWxlUmVsb2FkKFJFTE9BRF9BRlRFUl9SRUNPVkVSWV9NUyk7XG4gIH1cblxuICBwcml2YXRlIHNjaGVkdWxlUmVsb2FkKGRlbGF5OiBudW1iZXIpIHtcbiAgICBjb25zdCBub3cgPSBwZXJmb3JtYW5jZS5ub3coKSwgYXQgPSBNYXRoLm1heChub3cgKyBkZWxheSwgdGhpcy5sYXN0UmVsb2FkICsgdGhpcy5zcGFjaW5nKTtcbiAgICBpZiAoYXQgPj0gdGhpcy5yZWxvYWRBdCkgcmV0dXJuOyAvLyBhbiBlYXJsaWVyIHJlbG9hZCBpcyBhbHJlYWR5IHBsYW5uZWRcbiAgICBjbGVhclRpbWVvdXQodGhpcy5yZWxvYWRUaW1lcik7XG4gICAgdGhpcy5yZWxvYWRBdCA9IGF0O1xuICAgIHRoaXMucmVsb2FkVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHRoaXMucmVsb2FkKCksIGF0IC0gbm93KTtcbiAgfVxuXG4gIHByaXZhdGUgcmVsb2FkKCkge1xuICAgIGNvbnN0IG5vdyA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgIHRoaXMucmVsb2FkVGltZXIgPSB1bmRlZmluZWQ7XG4gICAgdGhpcy5yZWxvYWRBdCA9IEluZmluaXR5O1xuICAgIC8vIENhbG0gc2luY2UgdGhlIGxhc3QgcmVsb2FkOiBzdGFydCBhZ2FpbiBmcm9tIHRoZSBzaG9ydGVzdCBzcGFjaW5nLiBIb2xlcyBhZ2FpbiBzb29uIGFmdGVyXG4gICAgLy8gKHRoZSBuZXR3b3JrIGlzIHN0aWxsIGJhZCk6IHdhaXQgdHdpY2UgYXMgbG9uZyBiZWZvcmUgdGhlIG5leHQgdHJ5LlxuICAgIHRoaXMuc3BhY2luZyA9IG5vdyAtIHRoaXMubGFzdFJlbG9hZCA+IDQgKiB0aGlzLnNwYWNpbmcgPyBSRUxPQURfTUlOX1NQQUNJTkdfTVMgOiBNYXRoLm1pbigyICogdGhpcy5zcGFjaW5nLCBSRUxPQURfTUFYX1NQQUNJTkdfTVMpO1xuICAgIHRoaXMubGFzdFJlbG9hZCA9IG5vdztcbiAgICB0aGlzLmdhcHMgPSBmYWxzZTtcbiAgICB3b3JrZXJzKCkuc2V0dGxlZCh0aGlzKTtcbiAgICBpZiAoIXRoaXMuX3JlbG9hZCkgcmV0dXJuOyAvLyBoaWRkZW46IHRoZSBsYXllciBhc2tzIGZvciBmcmVzaCB0aWxlcyBhbnl3YXkgd2hlbiBpdCBpcyBzaG93biBhZ2FpblxuICAgIHRoaXMuX3JlbG9hZCgpOyAvLyBDZXNpdW0ga2VlcHMgc2hvd2luZyB0aGUgb2xkIHRpbGVzIHVudGlsIHRoZSBuZXcgb25lcyBhcmUgcmVhZHlcbiAgICBpbWFnZXJ5UmVsb2FkZWQucmFpc2VFdmVudCgpO1xuICB9XG59XG5cbi8qKlxuICogRGlzcGxheS1mcmFtZSBib3ggYXJvdW5kIHRoZSB0cnVlIHNvdXRoLXBvbGFyIGNhcCBzb3V0aCBvZiBgY2xpcERlZ2AuIFRoZSBjYXAgaXMgY2VudHJlZCBvblxuICogZGlzcGxheSAwwrBOIDkwwrBFLCBzbyBhIGNhcCBvZiBhbmd1bGFyIHJhZGl1cyByIHNwYW5zIMKxciBpbiBkaXNwbGF5IGxhdCBhbmQgOTDCsMKxciBpbiBkaXNwbGF5IGxvbi5cbiAqIEEgbGl0dGxlIGV4dHJhICgwLjLCsCkga2VlcHMgdGhlIHNvZnQgZWRnZSBwaXhlbHMgaW5zaWRlLiBGb3IgdGhlIGRlZmF1bHQgY2xpcCB0aGlzIGlzIHRydWUgbGF0IDwgLTc5LjjCsC5cbiAqL1xuZnVuY3Rpb24gcG9sYXJSZWN0YW5nbGUoY2xpcERlZzogbnVtYmVyKTogUmVjdGFuZ2xlIHtcbiAgY29uc3QgciA9IE1hdGgubWluKDkwLCA5MCArIGNsaXBEZWcgKyAwLjIpO1xuICByZXR1cm4gUmVjdGFuZ2xlLmZyb21EZWdyZWVzKDkwIC0gciwgLXIsIDkwICsgciwgcik7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVGhlIHdob2xlLU1vb24gcGhvdG8gc3RvcmVkIHdpdGggdGhlIGFwcCAobWFkZSBieSBkYXRhLXByZXAvYmFzZV9tb3NhaWMucHkgZnJvbSB0aGUgc2FtZSBNb29uXG4vLyBUcmVrIFdBQyBtb3NhaWMgdGhlICdwaG90bycgbGF5ZXIgc3RyZWFtcykuIEl0cyBwaWN0dXJlcyBhcmUgYWxyZWFkeSBkcmF3biBpbiB0aGUgZGlzcGxheSBmcmFtZSxcbi8vIHNvIGEgdGlsZSBpcyBzaW1wbHkgY3V0IG91dCBvZiB0aGVtLlxuXG4vKiogT25lIHBpY3R1cmUgb2YgYmFzZS5qc29uLCBpbiB1bml0cyBvZiBpdHMgb3duIHRpbGVzOiB3aGVyZSBpdCBzdGFydHMgb24gdGhlIHRpbGUgZ3JpZCBvZiBpdHMgbGV2ZWwgYW5kIGhvdyBtYW55IHRpbGVzIGl0IGhvbGRzLiAqL1xuaW50ZXJmYWNlIEJhc2VQaWN0dXJlIHsgdXJsOiBzdHJpbmc7IGxldmVsOiBudW1iZXI7IG94OiBudW1iZXI7IG95OiBudW1iZXI7IGNvbHM6IG51bWJlcjsgcm93czogbnVtYmVyOyBtaXBzOiBudW1iZXI7IHBvbGVBd2FyZTogYm9vbGVhbiB9XG5pbnRlcmZhY2UgQmFzZVNldCB7IHN0YXRlOiAnbG9hZGluZycgfCAncmVhZHknIHwgJ2ZhaWxlZCc7IGdsb2JhbD86IEJhc2VQaWN0dXJlOyBxdWljaz86IEJhc2VQaWN0dXJlOyBzb3V0aD86IEJhc2VQaWN0dXJlOyBub3J0aD86IEJhc2VQaWN0dXJlOyBmaXg/OiBGaXhQYXJhbXMgfVxubGV0IGJhc2VTZXQ6IEJhc2VTZXQgfCB1bmRlZmluZWQ7XG4vKiogTW9vbiBUcmVrIGxheWVycyB0aGF0IGxlYXZlIHRoZSBsZXZlbHMgdGhlIGxvY2FsIHBpY3R1cmUgYWxyZWFkeSBzaG93cyB0byBpdC4gKi9cbmNvbnN0IG92ZXJCYXNlID0gbmV3IFNldDxSZXByb2plY3RlZEltYWdlcnlQcm92aWRlcj4oKTtcblxuLyoqIFRoZSBsb2NhbCBwaWN0dXJlIGNhbm5vdCBiZSB1c2VkIGFmdGVyIGFsbCAoZmlsZSBtaXNzaW5nIG9yIHVucmVhZGFibGUpOiB0aGUgTW9vbiBUcmVrIHBob3RvIHRha2VzIG92ZXIgaXRzIGxldmVscy4gKi9cbmZ1bmN0aW9uIGJhc2VCcm9rZSgpIHtcbiAgaWYgKCFiYXNlU2V0IHx8IGJhc2VTZXQuc3RhdGUgPT09ICdmYWlsZWQnKSByZXR1cm47XG4gIGJhc2VTZXQuc3RhdGUgPSAnZmFpbGVkJztcbiAgZm9yIChjb25zdCBwIG9mIG92ZXJCYXNlKSBwLnJlbG9hZE5vdygpO1xufVxuXG5mdW5jdGlvbiBiYXNlUGljdHVyZU9mKGZvbGRlcjogc3RyaW5nLCBtOiB1bmtub3duLCBtaXBzOiAobGV2ZWw6IG51bWJlcikgPT4gbnVtYmVyKTogQmFzZVBpY3R1cmUgfCB1bmRlZmluZWQge1xuICBjb25zdCBwID0gbSBhcyB7IGZpbGU/OiB1bmtub3duOyB3aWR0aD86IHVua25vd247IGhlaWdodD86IHVua25vd247IHdlc3Q/OiB1bmtub3duOyBub3J0aD86IHVua25vd247IGxldmVsPzogdW5rbm93bjsgcG9sZUF3YXJlPzogdW5rbm93biB9IHwgdW5kZWZpbmVkO1xuICBpZiAoIXAgfHwgdHlwZW9mIHAuZmlsZSAhPT0gJ3N0cmluZycgfHwgdHlwZW9mIHAud2lkdGggIT09ICdudW1iZXInIHx8IHR5cGVvZiBwLmhlaWdodCAhPT0gJ251bWJlcicgfHwgdHlwZW9mIHAud2VzdCAhPT0gJ251bWJlcicgfHwgdHlwZW9mIHAubm9ydGggIT09ICdudW1iZXInIHx8IHR5cGVvZiBwLmxldmVsICE9PSAnbnVtYmVyJykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgdCA9IDE4MCAvIDIgKiogcC5sZXZlbCwgcGljID0geyB1cmw6IG5ldyBVUkwocC5maWxlLCBmb2xkZXIpLmhyZWYsIGxldmVsOiBwLmxldmVsLCBveDogKHAud2VzdCArIDE4MCkgLyB0LCBveTogKDkwIC0gcC5ub3J0aCkgLyB0LCBjb2xzOiBwLndpZHRoIC8gVElMRSwgcm93czogcC5oZWlnaHQgLyBUSUxFLCBtaXBzOiBNYXRoLm1heCgwLCBtaXBzKHAubGV2ZWwpKSwgcG9sZUF3YXJlOiBwLnBvbGVBd2FyZSA9PT0gdHJ1ZSB9O1xuICByZXR1cm4gW3BpYy5veCwgcGljLm95LCBwaWMuY29scywgcGljLnJvd3MsIHBpYy5sZXZlbF0uZXZlcnkoTnVtYmVyLmlzSW50ZWdlcikgPyBwaWMgOiB1bmRlZmluZWQ7IC8vIG11c3Qgc2l0IGV4YWN0bHkgb24gdGhlIHRpbGUgZ3JpZFxufVxuXG4vKiogV2hlcmUgZGlzcGxheSB0aWxlIHgsIHkgb2YgYGxldmVsYCBzaXRzIGluc2lkZSBhIGxvY2FsIHBpY3R1cmUsIG9yIG51bGwgaWYgdGhlIHBpY3R1cmUgZG9lcyBub3QgaG9sZCBpdC4gKi9cbmZ1bmN0aW9uIGJhc2VDdXQocDogQmFzZVBpY3R1cmUgfCB1bmRlZmluZWQsIHg6IG51bWJlciwgeTogbnVtYmVyLCBsZXZlbDogbnVtYmVyKTogQmFzZUN1dCB8IG51bGwge1xuICBpZiAoIXAgfHwgbGV2ZWwgPiBwLmxldmVsKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgbWlwID0gcC5sZXZlbCAtIGxldmVsLCBmID0gMiAqKiBtaXA7XG4gIGlmIChwLm94ICUgZiB8fCBwLm95ICUgZikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHR4ID0geCAtIHAub3ggLyBmLCB0eSA9IHkgLSBwLm95IC8gZjtcbiAgaWYgKHR4IDwgMCB8fCB0eSA8IDAgfHwgKHR4ICsgMSkgKiBmID4gcC5jb2xzIHx8ICh0eSArIDEpICogZiA+IHAucm93cykgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHVybDogcC51cmwsIG1pcCwgcHg6IHR4ICogVElMRSwgcHk6IHR5ICogVElMRSwgbWlwczogcC5taXBzLCBwb2xlQXdhcmU6IHAucG9sZUF3YXJlIH07XG59XG5cbi8qKiBUaGUgcGljdHVyZSBvZiB0aGUgbG9jYWwgc2V0IHRoYXQgZHJhd3MgdGhpcyB0aWxlOiB0aGUgd2hvbGUtTW9vbiBvbmUgdXAgdG8gaXRzIGxldmVsLCB0aGUgc2hhcnBlciBwb2xhciBvbmVzIGJleW9uZC4gKi9cbmNvbnN0IGJhc2VDdXRGb3IgPSAoYjogQmFzZVNldCwgeDogbnVtYmVyLCB5OiBudW1iZXIsIGxldmVsOiBudW1iZXIpID0+XG4gIGIuZ2xvYmFsICYmIGxldmVsIDw9IGIuZ2xvYmFsLmxldmVsID8gYmFzZUN1dChiLmdsb2JhbCwgeCwgeSwgbGV2ZWwpIDogYmFzZUN1dChiLnNvdXRoLCB4LCB5LCBsZXZlbCkgPz8gYmFzZUN1dChiLm5vcnRoLCB4LCB5LCBsZXZlbCk7XG5cbi8qKiBUaGUgc2VhbS1maXggc2V0dGluZ3Mgb2YgYmFzZS5qc29uICh2NSksIHdpdGggdGhlIGFsYmVkbyBwaWN0dXJlJ3MgVVJMIHJlc29sdmVkLCBvciB1bmRlZmluZWQuICovXG5mdW5jdGlvbiBmaXhPZihmb2xkZXI6IHN0cmluZywgbTogdW5rbm93bik6IEZpeFBhcmFtcyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGYgPSBtIGFzIHsgYWxiZWRvPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47IEM/OiB1bmtub3duOyBTMD86IHVua25vd247IGhpbGxzaGFkZT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGEgPSBmPy5hbGJlZG8sIGggPSBmPy5oaWxsc2hhZGU7XG4gIGlmICghYSB8fCAhaCB8fCB0eXBlb2YgYS5maWxlICE9PSAnc3RyaW5nJyB8fCB0eXBlb2YgZi5DICE9PSAnbnVtYmVyJyB8fCB0eXBlb2YgZi5TMCAhPT0gJ251bWJlcicpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG51bSA9ICh2OiB1bmtub3duKSA9PiAodHlwZW9mIHYgPT09ICdudW1iZXInID8gdiA6IE5hTik7XG4gIGNvbnN0IGZpeDogRml4UGFyYW1zID0ge1xuICAgIGFsYmVkbzogeyB1cmw6IG5ldyBVUkwoYS5maWxlLCBmb2xkZXIpLmhyZWYsIHdlc3Q6IG51bShhLndlc3QpLCBlYXN0OiBudW0oYS5lYXN0KSwgbm9ydGg6IG51bShhLm5vcnRoKSwgc291dGg6IG51bShhLnNvdXRoKSwgc2NhbGU6IG51bShhLnNjYWxlKSB9LFxuICAgIEM6IGYuQywgUzA6IGYuUzAsIG5lYXI6IFN0cmluZyhoLm5lYXIpLCBmYXI6IFN0cmluZyhoLmZhciksIG5lYXJNYXhMYXQ6IG51bShoLm5lYXJNYXhMYXQpLFxuICB9O1xuICByZXR1cm4gT2JqZWN0LnZhbHVlcyhmaXguYWxiZWRvKS5ldmVyeSh2ID0+IHR5cGVvZiB2ID09PSAnc3RyaW5nJyB8fCBOdW1iZXIuaXNGaW5pdGUodikpICYmIE51bWJlci5pc0Zpbml0ZShmaXgubmVhck1heExhdCkgPyBmaXggOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogVGhlIHdob2xlLU1vb24gcGhvdG8gc3RvcmVkIHdpdGggdGhlIGFwcCwgYXMgdGhlIGJvdHRvbSBsYXllcjogb24gc2NyZWVuIGF0IG9uY2UsIHNoYXJwIGZvciB0aGVcbiAqIG9wZW5pbmcgdmlldyBhbmQgdGhlIFwiU291dGggUG9sZVwiIHZpZXcsIGFuZCBzdGlsbCB0aGVyZSB3aXRoIG5vIGludGVybmV0LiBgdXJsYCBpcyB0aGUgZm9sZGVyXG4gKiB0aGF0IGhvbGRzIGJhc2UuanNvbiAoZGVmYXVsdCAuL2RhdGEvYmFzZS8pLCB3cml0dGVuIGJ5IGRhdGEtcHJlcC9iYXNlX21vc2FpYy5weTpcbiAqICAgbW9vbjhrLmpwZyAgd2hvbGUgTW9vbiwgZGlzcGxheSB0aWxlIGxldmVscyAwLTQgKDEuMyBrbSBwZXIgcGl4ZWwpXG4gKiAgIG1vb24yay5qcGcgIHRoZSBzYW1lLCBzbWFsbDogZHJhd24gZmlyc3Qgd2hpbGUgdGhlIGJpZyBvbmUgaXMgZGVjb2RlZFxuICogICBzb3V0aDYuanBnICB3aXRoaW4gMzMuNzUgZGVncmVlcyBvZiB0aGUgc291dGggcG9sZSBhdCBsZXZlbCA2ICgzMzMgbSBwZXIgcGl4ZWwpLCBpZiBwcmVzZW50XG4gKiBEZWVwZXIgdGlsZXMgYXJlIGFuc3dlcmVkIFwia2VlcCB0aGUgcGFyZW50XCIsIHNvIHRoZSBsYXllciBuZXZlciBhc2tzIGZvciBtb3JlIHRoYW4gaXQgaGFzLlxuICogR2l2ZSB0aGUgbGF5ZXIgdGhlIHNhbWUgc2hvdy9hbHBoYSBhcyB0aGUgTW9vbiBUcmVrICdwaG90bycgbGF5ZXIgYWJvdmUgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVCYXNlTW9zYWljUHJvdmlkZXIobzogeyB1cmw/OiBzdHJpbmc7IGNyZWRpdDogc3RyaW5nIH0pOiBSZXByb2plY3RlZEltYWdlcnlQcm92aWRlciB7XG4gIGNvbnN0IGZvbGRlciA9IG5ldyBVUkwoby51cmwgPz8gJy4vZGF0YS9iYXNlLycsIGRvY3VtZW50LmJhc2VVUkkpLmhyZWYucmVwbGFjZSgvXFwvPyQvLCAnLycpO1xuICBjb25zdCBzZXQ6IEJhc2VTZXQgPSAoYmFzZVNldCA9IHsgc3RhdGU6ICdsb2FkaW5nJyB9KTtcbiAgdm9pZCBmZXRjaChgJHtmb2xkZXJ9YmFzZS5qc29uYCkudGhlbihyID0+IChyLm9rID8gci5qc29uKCkgOiBQcm9taXNlLnJlamVjdChuZXcgRXJyb3IoU3RyaW5nKHIuc3RhdHVzKSkpKSkudGhlbigobTogeyBwaWN0dXJlcz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyBmaXg/OiB1bmtub3duIH0pID0+IHtcbiAgICBzZXQuZ2xvYmFsID0gYmFzZVBpY3R1cmVPZihmb2xkZXIsIG0ucGljdHVyZXM/Lmdsb2JhbCwgbGV2ZWwgPT4gbGV2ZWwpO1xuICAgIHNldC5xdWljayA9IGJhc2VQaWN0dXJlT2YoZm9sZGVyLCBtLnBpY3R1cmVzPy5xdWljaywgbGV2ZWwgPT4gbGV2ZWwpO1xuICAgIC8vIHRoZSBzb3V0aCBwaWN0dXJlIG9ubHkgZHJhd3MgdGhlIGxldmVscyB0aGUgd2hvbGUtTW9vbiBwaWN0dXJlIGRvZXMgbm90IHJlYWNoXG4gICAgc2V0LnNvdXRoID0gc2V0Lmdsb2JhbCAmJiBiYXNlUGljdHVyZU9mKGZvbGRlciwgbS5waWN0dXJlcz8uc291dGgsIGxldmVsID0+IGxldmVsIC0gc2V0Lmdsb2JhbCEubGV2ZWwgLSAxKTtcbiAgICBzZXQubm9ydGggPSBzZXQuZ2xvYmFsICYmIGJhc2VQaWN0dXJlT2YoZm9sZGVyLCBtLnBpY3R1cmVzPy5ub3J0aCwgbGV2ZWwgPT4gbGV2ZWwgLSBzZXQuZ2xvYmFsIS5sZXZlbCAtIDEpO1xuICAgIHNldC5maXggPSBmaXhPZihmb2xkZXIsIChtIGFzIHsgZml4PzogdW5rbm93biB9KS5maXgpO1xuICAgIHNldC5zdGF0ZSA9IHNldC5nbG9iYWwgPyAncmVhZHknIDogJ2ZhaWxlZCc7XG4gIH0pLmNhdGNoKChlOiB1bmtub3duKSA9PiB7IGNvbnNvbGUud2FybignTG9jYWwgTW9vbiBwaWN0dXJlIG5vdCBhdmFpbGFibGU6JywgZSk7IHNldC5zdGF0ZSA9ICdmYWlsZWQnOyB9KTtcbiAgcmV0dXJuIG5ldyBSZXByb2plY3RlZEltYWdlcnlQcm92aWRlcih7XG4gICAgcmVjdGFuZ2xlOiBSZWN0YW5nbGUuY2xvbmUoUmVjdGFuZ2xlLk1BWF9WQUxVRSksXG4gICAgbWF4aW11bUxldmVsOiA2LFxuICAgIGNyZWRpdDogby5jcmVkaXQsXG4gICAgd29ya2VyOiAwLFxuICAgIGlzTG9jYWw6ICgpID0+IHRydWUsXG4gICAgam9iRm9yOiAocmVjdCwgbGV2ZWwsIHgsIHkpID0+IHtcbiAgICAgIGlmIChzZXQuc3RhdGUgPT09ICdsb2FkaW5nJykgcmV0dXJuICd3YWl0JztcbiAgICAgIGlmIChzZXQuc3RhdGUgPT09ICdmYWlsZWQnKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IGN1dCA9IGJhc2VDdXRGb3Ioc2V0LCB4LCB5LCBsZXZlbCk7XG4gICAgICBpZiAoIWN1dCkgcmV0dXJuICdwYXJlbnQnOyAvLyBkZWVwZXIgdGhhbiB0aGUgcGljdHVyZTogdGhlIHBhcmVudCB0aWxlIGFscmVhZHkgc2hvd3MgYWxsIHRoZXJlIGlzXG4gICAgICByZXR1cm4geyBraW5kOiAnYmFzZScsIHJlY3QsIGxldmVsLCBjdXQsIHF1aWNrOiAoY3V0LnVybCA9PT0gc2V0Lmdsb2JhbD8udXJsICYmIGJhc2VDdXQoc2V0LnF1aWNrLCB4LCB5LCBsZXZlbCkpIHx8IHVuZGVmaW5lZCB9O1xuICAgIH0sXG4gIH0pO1xufVxuXG4vKipcbiAqIE5BU0EgTW9vbiBUcmVrIGdsb2JhbCB0aWxlcyAodHJ1ZSBsb24vbGF0IFdNVFMpLCByZS1wcm9qZWN0ZWQgaW50byBkaXNwbGF5IHRpbGVzLiBQaXhlbHMgc291dGhcbiAqIG9mIGBtaW5UcnVlTGF0YCBzdGF5IHRyYW5zcGFyZW50IHNvIHRoZSBwb2xhciBsYXllcnMgc2hvdyB0aGVyZSBpbnN0ZWFkLiBEaXNwbGF5IGxldmVscyBnbyBvbmVcbiAqIHBhc3QgYG1heFNvdXJjZUxldmVsYCBzbyB0aGUgZGVlcGVzdCB0aWxlcyBhcmUgZHJhd24gc3RyYWlnaHQgZnJvbSB0aGUgc291cmNlIGF0IDJ4LCBub3RcbiAqIHJlLXNhbXBsZWQgdHdpY2UuXG4gKlxuICogYG92ZXJCYXNlYCAoZm9yIHRoZSBwaG90byB0aGF0IHRoZSBsb2NhbCB3aG9sZS1Nb29uIHBpY3R1cmUgaXMgbWFkZSBmcm9tKTogdGhlIGxldmVscyB0aGF0XG4gKiBwaWN0dXJlIGFscmVhZHkgc2hvd3MgYXJlIGxlZnQgdG8gaXQgKHRyYW5zcGFyZW50IGhlcmUpLCBzbyB0aGUgb3BlbmluZyB2aWV3IGFuZCB0aGUgXCJTb3V0aFxuICogUG9sZVwiIHZpZXcgbmVlZCBub3RoaW5nIGZyb20gdGhlIGludGVybmV0LiBOZWVkcyBhIGNyZWF0ZUJhc2VNb3NhaWNQcm92aWRlciBsYXllciB1bmRlcm5lYXRoO1xuICogd2l0aG91dCBvbmUsIG9yIGlmIGl0cyBmaWxlcyBhcmUgbWlzc2luZywgZXZlcnkgbGV2ZWwgaXMgc3RyZWFtZWQgYXMgYmVmb3JlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlTW9vblRyZWtQcm92aWRlcihvOiB7IGxheWVyOiBzdHJpbmc7IGV4dDogc3RyaW5nOyBtYXhTb3VyY2VMZXZlbDogbnVtYmVyOyBtaW5UcnVlTGF0PzogbnVtYmVyOyBjcmVkaXQ6IHN0cmluZzsgb3ZlckJhc2U/OiBib29sZWFuOyBzaGFycFBob3RvPzogYm9vbGVhbiB9KTogUmVwcm9qZWN0ZWRJbWFnZXJ5UHJvdmlkZXIge1xuICBjb25zdCBtaW5UcnVlTGF0ID0gby5taW5UcnVlTGF0ID8/IC05MDtcbiAgY29uc3QgcCA9IG5ldyBSZXByb2plY3RlZEltYWdlcnlQcm92aWRlcih7XG4gICAgcmVjdGFuZ2xlOiBSZWN0YW5nbGUuY2xvbmUoUmVjdGFuZ2xlLk1BWF9WQUxVRSksXG4gICAgbWF4aW11bUxldmVsOiBvLnNoYXJwUGhvdG8gPyAxNyA6IG8ubWF4U291cmNlTGV2ZWwgKyAxLFxuICAgIGNyZWRpdDogby5jcmVkaXQsXG4gICAgd29ya2VyOiB3b3JrZXJzKCkucm91dGUoJ3RyZWsnKSxcbiAgICBqb2JGb3I6IChyZWN0LCBsZXZlbCwgeCwgeSkgPT4ge1xuICAgICAgbGV0IG5vcnRoQmFzZTogRXh0cmFjdDxKb2IsIHsga2luZDogJ3Bob3RvJyB9Plsnbm9ydGhCYXNlJ107XG4gICAgICBpZiAoby5vdmVyQmFzZSAmJiBiYXNlU2V0KSB7XG4gICAgICAgIGlmIChiYXNlU2V0LnN0YXRlID09PSAnbG9hZGluZycpIHJldHVybiAnd2FpdCc7XG4gICAgICAgIGlmIChiYXNlU2V0LnN0YXRlID09PSAncmVhZHknICYmIGJhc2VDdXRGb3IoYmFzZVNldCwgeCwgeSwgbGV2ZWwpKSByZXR1cm4gbnVsbDsgLy8gdGhlIGxvY2FsIHBpY3R1cmUgdW5kZXJuZWF0aCBzaG93cyBleGFjdGx5IHRoaXNcbiAgICAgICAgaWYgKGJhc2VTZXQuc3RhdGUgPT09ICdyZWFkeScgJiYgYmFzZVNldC5maXggJiYgc2VhbUZpeE9uICYmIHRpbGVGaXhSYW5nZShyZWN0KS5taW4gPj0gMVxuICAgICAgICAgICYmICEoby5zaGFycFBob3RvICYmIGxldmVsID4gOCAmJiB0aWxlVHJ1ZUxhdFJhbmdlKHJlY3QpLm1pbkRlZyA+IE5PUlRIX1BIT1RPX0xBVCkpIHJldHVybiBudWxsOyAvLyB0aGUgbm9ydGggd29ya2VyJ3MgbG9jYWwgcmVmZXJlbmNlIGFscmVhZHkgaW5jbHVkZXMgdGhlIGZpeFxuICAgICAgICBpZiAoby5zaGFycFBob3RvICYmIGxldmVsID4gOCAmJiB0aWxlVHJ1ZUxhdFJhbmdlKHJlY3QpLm1pbkRlZyA+IE5PUlRIX1BIT1RPX0xBVCkge1xuICAgICAgICAgIGNvbnN0IHNjYWxlID0gMiAqKiBNYXRoLm1heCgwLCBsZXZlbCAtIDYpLCBweCA9IE1hdGguZmxvb3IoeCAvIHNjYWxlKSwgcHkgPSBNYXRoLmZsb29yKHkgLyBzY2FsZSk7XG4gICAgICAgICAgY29uc3QgY3V0ID0gYmFzZUN1dEZvcihiYXNlU2V0LCBweCwgcHksIDYpO1xuICAgICAgICAgIGlmIChjdXQpIHtcbiAgICAgICAgICAgIGNvbnN0IHIgPSBwLnRpbGluZ1NjaGVtZS50aWxlWFlUb1JlY3RhbmdsZShweCwgcHksIDYpO1xuICAgICAgICAgICAgbm9ydGhCYXNlID0geyBjdXQsIHJlY3Q6IHsgd2VzdDogci53ZXN0LCBlYXN0OiByLmVhc3QsIHNvdXRoOiByLnNvdXRoLCBub3J0aDogci5ub3J0aCB9IH07XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gbWluVHJ1ZUxhdCA+IC05MCAmJiB0aWxlVHJ1ZUxhdFJhbmdlKHJlY3QpLm1heERlZyA8IG1pblRydWVMYXQgLSBwaXhlbERlZyhsZXZlbClcbiAgICAgICAgPyBudWxsIC8vIHRpbGUgbGllcyB3aG9sbHkgaW5zaWRlIHRoZSBwb2xhciBjYXBcbiAgICAgICAgOiBvLnNoYXJwUGhvdG8gJiYgbGV2ZWwgPiBwaG90b01heExldmVsKHJlY3QpID8gJ3BhcmVudCdcbiAgICAgICAgOiBvLnNoYXJwUGhvdG8gJiYgbGV2ZWwgPiA4ID8geyBraW5kOiAncGhvdG8nLCByZWN0LCBsZXZlbCwgbGF5ZXI6IG8ubGF5ZXIsIG1pblRydWVMYXQsIG5vcnRoQmFzZSB9XG4gICAgICAgIDogeyBraW5kOiAndHJlaycsIHJlY3QsIGxldmVsLCBsYXllcjogby5sYXllciwgZXh0OiBvLmV4dCwgbWF4U291cmNlTGV2ZWw6IG8ubWF4U291cmNlTGV2ZWwsIG1pblRydWVMYXQgfTtcbiAgICB9LFxuICB9KTtcbiAgaWYgKG8ub3ZlckJhc2UpIG92ZXJCYXNlLmFkZChwKTtcbiAgcmV0dXJuIHA7XG59XG5cbi8qKiBGYWxzZSBvbmNlIHRoZSBzZWFtLWZpeCBsYXllciBpcyBrbm93biB0byBiZSBtaXNzaW5nICh0aGVuIHRoZSBwaG90byBtdXN0IGRyYXcgZXZlcnl3aGVyZSkuICovXG5sZXQgc2VhbUZpeE9uID0gZmFsc2U7XG5cbi8qKlxuICogVGhlIHNlYW0gZml4IGFib3ZlIHRoZSBNb29uIFRyZWsgcGhvdG8gKHY1KS4gTkFTQSdzIFdBQyBnbG9iYWwgbW9zYWljIGlzIGxpdCBmcm9tIHRoZSBlYXN0IGluIHRydWVcbiAqIGxvbiAtMTgwLi4tOTAgYW5kIGZyb20gdGhlIHdlc3QgZXZlcnl3aGVyZSBlbHNlLCBzbyBpdCBzaG93cyB0d28gc3RyYWlnaHQgbGlnaHRpbmcgZmxpcHMgKGF0IC05MCBhbmRcbiAqIDE4MCkuIFRoaXMgbGF5ZXIgZHJhd3MgYWxiZWRvIHggaGlsbHNoYWRlIHRoZXJlIChsaXQgZnJvbSB0aGUgd2VzdCBsaWtlIHRoZSByZXN0KSwgc2VlLXRocm91Z2ggd2hlcmVcbiAqIHRoZSBwaG90byBpcyByaWdodCBhbmQgY3Jvc3MtZmFkaW5nIG92ZXIgLTkwLi4tODAgYW5kIDE2NS4uMTgwLiBUaGUgc2V0dGluZ3MgY29tZSBmcm9tIGJhc2UuanNvblxuICogKGRhdGEtcHJlcC9iYXNlX21vc2FpYy5weSBiYWtlcyB0aGUgc2FtZSBwaWN0dXJlIGludG8gdGhlIGxvY2FsIHdob2xlLU1vb24gc2V0LCBzbyB0aGlzIGxheWVyIG9ubHlcbiAqIGRyYXdzIGxldmVscyBkZWVwZXIgdGhhbiB0aGF0IHNldCkuIE5lZWRzIGEgY3JlYXRlQmFzZU1vc2FpY1Byb3ZpZGVyIGxheWVyICh2NSBmb2xkZXIpIHVuZGVybmVhdGggYW5kXG4gKiB0aGUgcGhvdG8gbGF5ZXIgYmVsb3cgaXQ7IGdpdmUgaXQgdGhlIHNhbWUgc2hvdy9hbHBoYSBhcyB0aGUgcGhvdG8uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTZWFtRml4UHJvdmlkZXIobzogeyBjcmVkaXQ6IHN0cmluZyB9KTogUmVwcm9qZWN0ZWRJbWFnZXJ5UHJvdmlkZXIge1xuICBzZWFtRml4T24gPSB0cnVlO1xuICByZXR1cm4gbmV3IFJlcHJvamVjdGVkSW1hZ2VyeVByb3ZpZGVyKHtcbiAgICByZWN0YW5nbGU6IFJlY3RhbmdsZS5jbG9uZShSZWN0YW5nbGUuTUFYX1ZBTFVFKSxcbiAgICBtYXhpbXVtTGV2ZWw6IDE3LFxuICAgIGNyZWRpdDogby5jcmVkaXQsXG4gICAgd29ya2VyOiB3b3JrZXJzKCkucm91dGUoJ3RyZWsnKSxcbiAgICBqb2JGb3I6IChyZWN0LCBsZXZlbCwgeCwgeSkgPT4ge1xuICAgICAgY29uc3QgYiA9IGJhc2VTZXQ7XG4gICAgICBpZiAoIWIgfHwgYi5zdGF0ZSA9PT0gJ2xvYWRpbmcnKSByZXR1cm4gJ3dhaXQnO1xuICAgICAgaWYgKGIuc3RhdGUgPT09ICdmYWlsZWQnIHx8ICFiLmZpeCkgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoYmFzZUN1dEZvcihiLCB4LCB5LCBsZXZlbCkpIHJldHVybiBudWxsOyAvLyB0aGUgbG9jYWwgcGljdHVyZXMgYWxyZWFkeSBzaG93IGl0XG4gICAgICBpZiAodGlsZVRydWVMYXRSYW5nZShyZWN0KS5tYXhEZWcgPCBGSVhfTUlOX1RSVUVfTEFUIC0gcGl4ZWxEZWcobGV2ZWwpKSByZXR1cm4gbnVsbDsgLy8gaW5zaWRlIHRoZSBzb3V0aC1wb2xhciBwaG90b3NcbiAgICAgIGlmICh0aWxlRml4UmFuZ2UocmVjdCkubWF4IDw9IDApIHJldHVybiBudWxsOyAvLyB0aGUgcGhvdG8gaXMgcmlnaHQgaGVyZVxuICAgICAgLy8gVGhlIGxvY2FsIG5vcnRoLXBvbGUgcGljdHVyZSBhbHJlYWR5IGluY2x1ZGVzIHRoZSBzZWFtIGZpeC4gVGhlIHBob3RvIHdvcmtlciB1c2VzXG4gICAgICAvLyB0aGF0IGFzIGl0cyBicmlnaHRuZXNzIHJlZmVyZW5jZSwgYXZvaWRpbmcgYSByaW5nIG9mIHJlbW90ZSBFUSB0aWxlcyBhdCB0aGUgcG9sZS5cbiAgICAgIGlmIChsZXZlbCA+IDggJiYgdGlsZVRydWVMYXRSYW5nZShyZWN0KS5taW5EZWcgPiBOT1JUSF9QSE9UT19MQVQpIHJldHVybiBudWxsO1xuICAgICAgaWYgKGxldmVsID4gcGhvdG9NYXhMZXZlbChyZWN0KSkgcmV0dXJuICdwYXJlbnQnO1xuICAgICAgaWYgKGxldmVsID4gOCkgcmV0dXJuIHsga2luZDogJ3Bob3RvJywgcmVjdCwgbGV2ZWwsIGxheWVyOiAnTFJPX1dBQ19Nb3NhaWNfR2xvYmFsXzMwM3BwZF92MDInLCBtaW5UcnVlTGF0OiBGSVhfTUlOX1RSVUVfTEFULCBmaXg6IGIuZml4IH07XG4gICAgICByZXR1cm4geyBraW5kOiAnc3ludGgnLCByZWN0LCBsZXZlbCwgZml4OiBiLmZpeCB9O1xuICAgIH0sXG4gIH0pO1xufVxuXG4vKipcbiAqIEdldCBzb3V0aC1wb2xhciBwaWN0dXJlcyByZWFkeSBiZWZvcmUgdGhleSBhcmUgc2hvd246IHRoZSB3b3JrZXIgZG93bmxvYWRzIChmcm9tIHRoZSBicm93c2VyJ3MgY2FjaGUsIHN0YXJ0LXVwIHB1dFxuICogdGhlbSB0aGVyZSkgYW5kIGRlY29kZXMgdGhlbSBub3csIHNvIHRoZSBmaXJzdCB0aW1lIGEgbGF5ZXIgaXMgc3dpdGNoZWQgb24gaXRzIHRpbGVzIGFwcGVhciBhdCBvbmNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2FybVBvbGFyUmFzdGVycyh1cmxzOiBzdHJpbmdbXSkge1xuICBpZiAoIXVybHMubGVuZ3RoKSByZXR1cm47XG4gIHdvcmtlcnMoKS50ZWxsKDAsIHsgd2FybVJhc3RlcnM6IHVybHMubWFwKHUgPT4gbmV3IFVSTCh1LCBkb2N1bWVudC5iYXNlVVJJKS5ocmVmKSB9KTtcbn1cblxuY29uc3QgYWJzb2x1dGVTY2llbmNlU291cmNlID0gKHNvdXJjZTogU2NpZW5jZVJhc3RlclNvdXJjZSk6IFNjaWVuY2VSYXN0ZXJTb3VyY2UgPT4gKHsgLi4uc291cmNlLCB1cmw6IG5ldyBVUkwoc291cmNlLnVybCwgZG9jdW1lbnQuYmFzZVVSSSkuaHJlZiB9KTtcblxuLyoqIEZpbmlzaCBkZWNvZGluZyBiZWZvcmUgdGhlIHN0YXJ0IHNjcmVlbiBjbG9zZXMsIHJhdGhlciB0aGFuIG9ubHkgZmlsbGluZyB0aGUgSFRUUCBjYWNoZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3YXJtU2NpZW5jZVJhc3RlcnMoc291cmNlczogU2NpZW5jZVJhc3RlclNvdXJjZVtdLCBvblByb2dyZXNzPzogKGZyYWM6IG51bWJlcikgPT4gdm9pZCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCB1bmlxdWUgPSBbLi4ubmV3IE1hcChzb3VyY2VzLm1hcChzID0+IFtuZXcgVVJMKHMudXJsLCBkb2N1bWVudC5iYXNlVVJJKS5ocmVmLCBhYnNvbHV0ZVNjaWVuY2VTb3VyY2UocyldKSkudmFsdWVzKCldO1xuICByZXR1cm4gd29ya2VycygpLndhcm1TY2llbmNlKHVuaXF1ZSwgb25Qcm9ncmVzcyk7XG59XG5cbi8qKiBSYXcgYnl0ZSB1bmRlciBhIHNwb3Q7IHRoZSBsZWZ0IHBhbmVsIGFwcGxpZXMgdGhlIHByb2R1Y3QncyBwdWJsaXNoZWQgc2NhbGUgYW5kIG9mZnNldC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2llbmNlUmFzdGVyVmFsdWVBdChzb3VyY2U6IFNjaWVuY2VSYXN0ZXJTb3VyY2UsIGxhdDogbnVtYmVyLCBsb246IG51bWJlcik6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICByZXR1cm4gd29ya2VycygpLnNjaWVuY2VWYWx1ZShhYnNvbHV0ZVNjaWVuY2VTb3VyY2Uoc291cmNlKSwgbGF0LCBsb24pO1xufVxuXG4vKiogQSBmZXcgcmVhZHkgZGlzcGxheSB0aWxlcyBtYWtlIHRoZSBmaXJzdCBwYWludGVkIGZyYW1lIGluZGVwZW5kZW50IG9mIGEgd29ya2VyIHJvdW5kIHRyaXAuICovXG5jbGFzcyBTY2llbmNlUmFzdGVyUHJvdmlkZXIgZXh0ZW5kcyBSZXByb2plY3RlZEltYWdlcnlQcm92aWRlciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgcHJlcGFyZWQgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTxJbWFnZUJpdG1hcD4+KCk7XG5cbiAgb3ZlcnJpZGUgcmVxdWVzdEltYWdlKHg6IG51bWJlciwgeTogbnVtYmVyLCBsZXZlbDogbnVtYmVyLCByZXF1ZXN0PzogSW1hZ2VyeVJlcXVlc3QpOiBQcm9taXNlPEltYWdlQml0bWFwPiB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3Qga2V5ID0gYCR7bGV2ZWx9LyR7eH0vJHt5fWA7XG4gICAgbGV0IHBpY3R1cmUgPSB0aGlzLnByZXBhcmVkLmdldChrZXkpO1xuICAgIGlmICghcGljdHVyZSkge1xuICAgICAgY29uc3QgZ290ID0gc3VwZXIucmVxdWVzdEltYWdlKHgsIHksIGxldmVsLCByZXF1ZXN0KTtcbiAgICAgIGlmICghZ290KSByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgcGljdHVyZSA9IGdvdDtcbiAgICAgIHRoaXMucHJlcGFyZWQuc2V0KGtleSwgZ290KTtcbiAgICAgIHZvaWQgZ290LmNhdGNoKCgpID0+IHsgaWYgKHRoaXMucHJlcGFyZWQuZ2V0KGtleSkgPT09IGdvdCkgdGhpcy5wcmVwYXJlZC5kZWxldGUoa2V5KTsgfSk7XG4gICAgICAvLyAxNiBNQiBwZXIgcHJvdmlkZXIgYXQgbW9zdDsgYW4gb2xkIG9mZi1zY3JlZW4gdGlsZSBpcyBjaGVhcCB0byBkcmF3IGFnYWluIGZyb20gdGhlIGRlY29kZWQgc291cmNlLlxuICAgICAgd2hpbGUgKHRoaXMucHJlcGFyZWQuc2l6ZSA+IDY0KSB7XG4gICAgICAgIGNvbnN0IFtvbGQsIGJpdG1hcF0gPSB0aGlzLnByZXBhcmVkLmVudHJpZXMoKS5uZXh0KCkudmFsdWUhO1xuICAgICAgICB0aGlzLnByZXBhcmVkLmRlbGV0ZShvbGQpO1xuICAgICAgICB2b2lkIGJpdG1hcC50aGVuKGIgPT4geyBpZiAoYiAhPT0gYmxhbmsgJiYgYiAhPT0gcGFyZW50TWFyaykgc2V0VGltZW91dCgoKSA9PiBiLmNsb3NlKCksIDIwMDApOyB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHsgdGhpcy5wcmVwYXJlZC5kZWxldGUoa2V5KTsgdGhpcy5wcmVwYXJlZC5zZXQoa2V5LCBwaWN0dXJlKTsgfVxuICAgIHJldHVybiBwaWN0dXJlLnRoZW4oYiA9PiBiID09PSBwYXJlbnRNYXJrID8gYiA6IGNyZWF0ZUltYWdlQml0bWFwKGIpKTtcbiAgfVxuXG4gIG92ZXJyaWRlIG5vdGVHYXBzKCkgeyB0aGlzLnByZXBhcmVkLmNsZWFyKCk7IHN1cGVyLm5vdGVHYXBzKCk7IH1cbiAgb3ZlcnJpZGUgcmVsb2FkTm93KCkgeyB0aGlzLnByZXBhcmVkLmNsZWFyKCk7IHN1cGVyLnJlbG9hZE5vdygpOyB9XG59XG5cbi8qKiBPbmUgc3dpdGNoIGNhbiBjb21iaW5lIGEgZ2xvYmFsIG1hcCBhbmQgc2hhcnBlciBtYXBzIG5lYXIgZWl0aGVyIHBvbGUuIExhdGVyIHNvdXJjZXMgbGllIG9uIHRvcC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTY2llbmNlUmFzdGVyUHJvdmlkZXIobzogeyBzb3VyY2VzOiBTY2llbmNlUmFzdGVyU291cmNlW107IGNyZWRpdDogc3RyaW5nOyBtYXhpbXVtTGV2ZWw/OiBudW1iZXIgfSk6IFJlcHJvamVjdGVkSW1hZ2VyeVByb3ZpZGVyIHtcbiAgY29uc3Qgc291cmNlcyA9IG8uc291cmNlcy5tYXAoYWJzb2x1dGVTY2llbmNlU291cmNlKTtcbiAgcmV0dXJuIG5ldyBTY2llbmNlUmFzdGVyUHJvdmlkZXIoe1xuICAgIHJlY3RhbmdsZTogUmVjdGFuZ2xlLk1BWF9WQUxVRSxcbiAgICBtYXhpbXVtTGV2ZWw6IG8ubWF4aW11bUxldmVsID8/IDEwLFxuICAgIGNyZWRpdDogby5jcmVkaXQsXG4gICAgd29ya2VyOiB3b3JrZXJzKCkuc2NpZW5jZVdvcmtlcixcbiAgICBpc0xvY2FsOiAoKSA9PiB0cnVlLFxuICAgIGpvYkZvcjogKHJlY3QsIGxldmVsKSA9PiB7XG4gICAgICBjb25zdCByYW5nZSA9IHRpbGVUcnVlTGF0UmFuZ2UocmVjdCk7XG4gICAgICBjb25zdCB0b3VjaGVzID0gc291cmNlcy5zb21lKHMgPT4gcy5wcm9qZWN0aW9uID09PSAnZ2xvYmFsJyB8fCAocy5wb2xlID09PSAnbm9ydGgnXG4gICAgICAgID8gcmFuZ2UubWF4RGVnID49IChzLmNsaXBUcnVlTGF0RGVnID8/IDgwKSAtIHBpeGVsRGVnKGxldmVsKVxuICAgICAgICA6IHJhbmdlLm1pbkRlZyA8PSAocy5jbGlwVHJ1ZUxhdERlZyA/PyAtODApICsgcGl4ZWxEZWcobGV2ZWwpKSk7XG4gICAgICByZXR1cm4gdG91Y2hlcyA/IHsga2luZDogJ3NjaWVuY2UnLCByZWN0LCBsZXZlbCwgc291cmNlcyB9IDogbnVsbDtcbiAgICB9LFxuICB9KTtcbn1cblxuLyoqXG4gKiBPbmUgbG9jYWwgc291dGgtcG9sYXItc3RlcmVvZ3JhcGhpYyBwaWN0dXJlICh4ID0gcmhvwrdzaW4obG9uKSwgeSA9IHJob8K3Y29zKGxvbiksIMKxZXh0ZW50TSxcbiAqIHJvdyAwID0gK3kpLiBXaXRob3V0IGBjbGlwVHJ1ZUxhdERlZ2AgKHRoZSBwb2xhciBwaG90bykgaXQgZmFkZXMgb3V0IHNvZnRseSAob3ZlciA0MCBrbSwgZW5kaW5nIGF0IDgwwrBTKSBpbnRvIHRoZVxuICogTW9vbiBUcmVrIHBob3RvIGJlbG93OyB3aXRoIGl0IChzY2llbmNlIG1hcHMpIHRoZSBlZGdlIGlzIGEgY3Jpc3AgbGluZSBhdCB0aGF0IGxhdGl0dWRlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUG9sYXJSYXN0ZXJQcm92aWRlcihvOiB7IHVybDogc3RyaW5nOyBleHRlbnRNOiBudW1iZXI7IGNyZWRpdDogc3RyaW5nOyBtYXhpbXVtTGV2ZWw/OiBudW1iZXI7IGNsaXBUcnVlTGF0RGVnPzogbnVtYmVyIH0pOiBSZXByb2plY3RlZEltYWdlcnlQcm92aWRlciB7XG4gIGNvbnN0IGNsaXAgPSBvLmNsaXBUcnVlTGF0RGVnID8/IFBPTEFSX0xJTUlUX0RFRztcbiAgY29uc3QgZmVhdGhlck0gPSBvLmNsaXBUcnVlTGF0RGVnID09PSB1bmRlZmluZWQgPyBQT0xBUl9GRUFUSEVSX00gOiAwO1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKG8udXJsLCBkb2N1bWVudC5iYXNlVVJJKS5ocmVmOyAvLyB0aGUgd29ya2VyIHJlc29sdmVzIHJlbGF0aXZlIFVSTHMgYWdhaW5zdCBpdHMgb3duIHNjcmlwdFxuICByZXR1cm4gbmV3IFJlcHJvamVjdGVkSW1hZ2VyeVByb3ZpZGVyKHtcbiAgICByZWN0YW5nbGU6IHBvbGFyUmVjdGFuZ2xlKGNsaXApLFxuICAgIG1heGltdW1MZXZlbDogby5tYXhpbXVtTGV2ZWwgPz8gOSxcbiAgICBjcmVkaXQ6IG8uY3JlZGl0LFxuICAgIHdvcmtlcjogMCxcbiAgICBqb2JGb3I6IChyZWN0LCBsZXZlbCkgPT5cbiAgICAgIHRpbGVUcnVlTGF0UmFuZ2UocmVjdCkubWluRGVnID49IGNsaXAgKyBwaXhlbERlZyhsZXZlbCkgPyBudWxsIDogeyBraW5kOiAncmFzdGVyJywgcmVjdCwgbGV2ZWwsIHVybCwgZXh0ZW50TTogby5leHRlbnRNLCBjbGlwVHJ1ZUxhdDogY2xpcCwgZmVhdGhlck0gfSxcbiAgfSk7XG59XG5cbi8qKlxuICogU2hhcnAgc291dGgtcG9sYXIgcGhvdG9zICh0aGUgTFJPQyBtb3NhaWNzIHNlcnZlZCBieSBBU1UgTHVuYXNlcnYsIHRoZSBzZXJ2ZXIgYmVoaW5kIFF1aWNrTWFwKTpcbiAqIHNxdWFyZSBwb2xhciB0aWxlcywgbGV2ZWwgayA9IHRoZSA2MDgga20gc3F1YXJlIHNwbGl0IDJeayB4IDJeaywgayB1cCB0byAxMCAofjEuMiBtIHBlciBwaXhlbCkuXG4gKiBPbmx5IHRpbGVzIHRoYXQgbmVlZCBrID49IG1pbksgYXJlIGRyYXduOyBjb2Fyc2VyIHZpZXdzIHVzZSB0aGUgbG9jYWwgcG9sYXIgcGhvdG8gdW5kZXJuZWF0aC5cbiAqXG4gKiBMb2NhbCBmaXJzdDogdGhlIHNxdWFyZXMgc3RvcmVkIHdpdGggdGhlIGFwcCAoZm9sZGVyIGBsb2NhbGAsIGRlZmF1bHQgLi9kYXRhL3BvbGFyL3QvLCBsaXN0ZWRcbiAqIGluIGl0cyBpbmRleC5qc29uIGJ5IGRhdGEtcHJlcC9wb2xhcl90aWxlcy5weSkgYXJlIHJlYWQgZnJvbSBkaXNrOyBMdW5hc2VydiBpcyBvbmx5IGFza2VkIGZvclxuICogc3F1YXJlcyB0aGF0IGFyZSBub3Qgc3RvcmVkLiBQYXNzIGBsb2NhbDogbnVsbGAgdG8gYWx3YXlzIHVzZSB0aGUgcmVtb3RlIHNlcnZlci4gV2hlcmUgdGhlXG4gKiBwaG90b3MgaGF2ZSBubyBmaW5lciBkZXRhaWwgKG91dHNpZGUgODQgZGVnIFMgb25seSB0aGUgMTAwIG0gV0FDIG1vc2FpYyBleGlzdHMpIHRpbGVzIHN0b3AgYXRcbiAqIHRoZSBsZXZlbCB0aGF0IHNob3dzIGl0IGFsbCBhbmQgZGVlcGVyIG9uZXMga2VlcCB0aGVpciBwYXJlbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVQb2xhclB5cmFtaWRQcm92aWRlcihvOiB7IGxheWVyczogc3RyaW5nOyBtaW5LOiBudW1iZXI7IGNyZWRpdDogc3RyaW5nOyBsb2NhbD86IHN0cmluZyB8IG51bGwgfSk6IFJlcHJvamVjdGVkSW1hZ2VyeVByb3ZpZGVyIHtcbiAgbGV0IG1heGltdW1MZXZlbCA9IDA7XG4gIHdoaWxlIChweXJhbWlkTGV2ZWxGb3IobWF4aW11bUxldmVsKSA8IFBZUkFNSURfTUFYX0spIG1heGltdW1MZXZlbCsrO1xuICBjb25zdCB3b3JrZXIgPSB3b3JrZXJzKCkucm91dGUoJ3B5cmFtaWQnKTtcbiAgLy8gV2hpY2ggc3F1YXJlcyBhcmUgc3RvcmVkIHdpdGggdGhlIGFwcD8gUmVhZCB0aGUgbGlzdCBvbmNlIGFuZCBoYW5kIGl0IHRvIHRoZSB3b3JrZXIgYmVmb3JlIHRoZSBmaXJzdCBqb2IuXG4gIGxldCBsb2NhbDogc3RyaW5nIHwgbnVsbCA9IG51bGwsIGluZGV4OiBQeXJhbWlkSW5kZXggfCBudWxsID0gbnVsbCwgbGlzdGVkID0gdHJ1ZTtcbiAgaWYgKG8ubG9jYWwgIT09IG51bGwgJiYgdHlwZW9mIGRvY3VtZW50ICE9PSAndW5kZWZpbmVkJykge1xuICAgIGNvbnN0IGZvbGRlciA9IChsb2NhbCA9IG5ldyBVUkwoby5sb2NhbCA/PyAnLi9kYXRhL3BvbGFyL3QvJywgZG9jdW1lbnQuYmFzZVVSSSkuaHJlZi5yZXBsYWNlKC9cXC8/JC8sICcvJykpO1xuICAgIGxpc3RlZCA9IGZhbHNlO1xuICAgIGNvbnN0IHJlYWQgPSAodHJpZXNMZWZ0OiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgICBmZXRjaChgJHtmb2xkZXJ9aW5kZXguanNvbmApLnRoZW4ociA9PiAoci5vayA/IHIuanNvbigpIDogUHJvbWlzZS5yZWplY3QobmV3IEVycm9yKFN0cmluZyhyLnN0YXR1cykpKSkpLnRoZW4oKGpzb246IHVua25vd24pID0+IHtcbiAgICAgICAgY29uc3QgaXggPSBwYXJzZVB5cmFtaWRJbmRleChqc29uKTtcbiAgICAgICAgaWYgKGl4ICYmIGl4LmxheWVycyA9PT0gby5sYXllcnMpIHsgaW5kZXggPSBpeDsgd29ya2VycygpLnRlbGwod29ya2VyLCB7IHB5cmFtaWRJbmRleDoganNvbiwgYmFzZTogZm9sZGVyIH0pOyB9XG4gICAgICAgIGVsc2UgY29uc29sZS53YXJuKGBTdG9yZWQgc291dGgtcG9sZSBwaG90b3Mgbm90IHVzZWQ6IHRoZXkgYXJlIGZvciBcIiR7aXg/LmxheWVycyA/PyAnYW4gdW5rbm93biBsYXllciBzZXQnfVwiLCB0aGlzIGxheWVyIGFza3MgZm9yIFwiJHtvLmxheWVyc31cIi5gKTtcbiAgICAgIH0pLmNhdGNoKChlOiB1bmtub3duKSA9PiAodHJpZXNMZWZ0ID4gMCA/IG5ldyBQcm9taXNlPHZvaWQ+KHJlcyA9PiBzZXRUaW1lb3V0KHJlcywgMTUwMCkpLnRoZW4oKCkgPT4gcmVhZCh0cmllc0xlZnQgLSAxKSkgOiBjb25zb2xlLndhcm4oJ05vIGxpc3Qgb2Ygc3RvcmVkIHNvdXRoLXBvbGUgcGhvdG9zLCB1c2luZyB0aGUgcmVtb3RlIHNlcnZlciBvbmx5OicsIGUpKSk7XG4gICAgdm9pZCByZWFkKDEpLmZpbmFsbHkoKCkgPT4geyBsaXN0ZWQgPSB0cnVlOyB9KTtcbiAgfVxuICByZXR1cm4gbmV3IFJlcHJvamVjdGVkSW1hZ2VyeVByb3ZpZGVyKHtcbiAgICByZWN0YW5nbGU6IHBvbGFyUmVjdGFuZ2xlKFBPTEFSX0xJTUlUX0RFRyksXG4gICAgbWF4aW11bUxldmVsLFxuICAgIGNyZWRpdDogby5jcmVkaXQsXG4gICAgd29ya2VyLFxuICAgIGlzTG9jYWw6IGpvYiA9PiBweXJhbWlkU3VyZWx5TG9jYWwoaW5kZXgsIGpvYi5yZWN0LCBqb2IubGV2ZWwpLFxuICAgIGpvYkZvcjogKHJlY3QsIGxldmVsKSA9PiB7XG4gICAgICBpZiAocHlyYW1pZExldmVsRm9yKGxldmVsKSA8IG8ubWluSyB8fCB0aWxlVHJ1ZUxhdFJhbmdlKHJlY3QpLm1pbkRlZyA+PSBQT0xBUl9MSU1JVF9ERUcgKyBwaXhlbERlZyhsZXZlbCkpIHJldHVybiBudWxsO1xuICAgICAgaWYgKHB5cmFtaWRQYXJlbnRJc0Vub3VnaChyZWN0LCBsZXZlbCkpIHJldHVybiAncGFyZW50JzsgLy8gdGhlIHBob3RvcyBhcmUgbm8gc2hhcnBlciB0aGFuIHRoZSBwYXJlbnQgdGlsZSBzaG93c1xuICAgICAgaWYgKCFsaXN0ZWQpIHJldHVybiAnd2FpdCc7XG4gICAgICByZXR1cm4geyBraW5kOiAncHlyYW1pZCcsIHJlY3QsIGxldmVsLCBsYXllcnM6IG8ubGF5ZXJzLCBtaW5LOiBvLm1pbkssIGxvY2FsIH07XG4gICAgfSxcbiAgfSk7XG59XG4iXX0=