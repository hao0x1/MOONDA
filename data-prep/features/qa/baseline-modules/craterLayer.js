// Measured circular fits, drawn as small circles on the Moon, never as circles in a map tile.
// Source: Robbins (2019), https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins
// Small south-polar catalogue: Marco Figuera et al. (2022), CC BY 4.0,
// https://zenodo.org/records/5779260 (full attribution is retained in craters.json).
// The full catalogue is split by region and size in data-prep/features/scripts/build_crater_drawing.py.
// Keep craters.bin unchanged: the route planner also reads those Float32 triples.
//
// A screen vector layer avoids two raster problems: neighbouring tiles choosing different rings,
// and a line getting wider when Cesium magnifies its parent tile. One choice of at most 400 whole
// rims serves the entire view. Catalogue scans and path preparation yield every few milliseconds.
// The old canvas bitmaps also lacked the photo worker's row flip. WebGL ignores Cesium's upload
// flip for ImageBitmap, so each tile's rings were mirrored within that tile, shifting them on the
// ground. Drawing vectors skips that upload entirely. Specification:
// https://registry.khronos.org/webgl/specs/latest/1.0/#TEXIMAGE2D_HTML
import { Cartesian2, Matrix4 } from "/node_modules/.vite/deps/cesium.js?v=f79bc84e";
import { MOON_R, trueUnit, trueToDisplayVec } from "/src/moon/frame.ts";
const DEG = Math.PI / 180;
const R_KM = MOON_R / 1e3;
const MAX_RINGS = 400;
const MIN_PIXELS = 9;
const MAX_CACHE_BYTES = 10 * 1024 * 1024;
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const clamp = (v) => Math.max(-1, Math.min(1, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const wrap = (r) => ((r + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
/** Positive-east, planetocentric source coordinates; diameter is an arc length in km. */
export function craterCircle(latDeg, lonDeg, diameterKm) {
	const p = latDeg * DEG, l = lonDeg * DEG;
	const radiusRad = diameterKm / (2 * R_KM);
	return {
		centre: trueToDisplayVec(trueUnit(latDeg, lonDeg)),
		east: trueToDisplayVec([
			-Math.sin(l),
			Math.cos(l),
			0
		]),
		north: trueToDisplayVec([
			-Math.sin(p) * Math.cos(l),
			-Math.sin(p) * Math.sin(l),
			Math.cos(p)
		]),
		radiusRad,
		cosRadius: Math.cos(radiusRad),
		sinRadius: Math.sin(radiusRad)
	};
}
/** A true spherical rim point, rotated exactly as the photo is (display = x, -z, y). */
export function pointOnCrater(c, bearingRad) {
	const e = Math.cos(bearingRad) * c.sinRadius, n = Math.sin(bearingRad) * c.sinRadius;
	return [
		c.centre[0] * c.cosRadius + c.east[0] * e + c.north[0] * n,
		c.centre[1] * c.cosRadius + c.east[1] * e + c.north[1] * n,
		c.centre[2] * c.cosRadius + c.east[2] * e + c.north[2] * n
	];
}
/** Reference projection for the shared-edge check. The live renderer has no tile boundaries. */
export function projectCraterPointToTile(p, r, size = 256) {
	const lon = wrap(Math.atan2(p[1], p[0]) - (r.west + r.east) / 2);
	return {
		x: (lon / (r.east - r.west) + .5) * size,
		y: (r.north - Math.asin(clamp(p[2]))) / (r.north - r.south) * size
	};
}
/** Screen positions use x, y and w only. Depth changes and sub-pixel noise are not camera moves. */
export function craterScreenKey(matrix) {
	return [
		0,
		1,
		3,
		4,
		5,
		7,
		8,
		9,
		11,
		12,
		13,
		15
	].map((i) => {
		const scale = i >= 12 ? 1e4 : 0xe8d4a51000;
		return Math.round(matrix[i] * scale) / scale;
	}).join(",");
}
class Catalogue {
	index = null;
	small = new Float32Array(0);
	cache = new Map();
	pending = new Set();
	revision = 0;
	starting = null;
	root = new URL("./data/features/", document.baseURI);
	start() {
		this.starting ??= (async () => {
			const [index, small] = await Promise.allSettled([fetch(new URL("craters-draw/index.json", this.root)).then((r) => {
				if (!r.ok) throw Error(String(r.status));
				return r.json();
			}), fetch(new URL("craters-small-south.bin", this.root)).then((r) => r.ok ? r.arrayBuffer() : new ArrayBuffer(0))]);
			if (index.status === "fulfilled") this.index = index.value;
			else {
				// Older offline caches can still draw the retained planner catalogue.
				const r = await fetch(new URL("craters.bin", this.root));
				if (r.ok) this.cache.set("legacy", {
					data: new Float32Array(await r.arrayBuffer()),
					used: performance.now()
				});
			}
			if (small.status === "fulfilled") this.small = new Float32Array(small.value);
			this.revision++;
		})().catch((e) => console.warn("Crater catalogue unavailable:", e));
		return this.starting;
	}
	forView(view, minKm) {
		const arrays = [this.small];
		if (!this.index) {
			const legacy = this.cache.get("legacy");
			if (legacy) arrays.push(legacy.data);
			return arrays;
		}
		const needed = this.index.chunks.filter((c) => c.maxKm >= minKm && (view.radius + c.radiusRad >= Math.PI || dot(view.centre, c.centre) >= Math.cos(view.radius + c.radiusRad)));
		const keep = new Set(needed.map((c) => c.file));
		for (const c of needed) {
			const hit = this.cache.get(c.file);
			if (hit) {
				hit.used = performance.now();
				arrays.push(hit.data);
			} else if (this.pending.size < 4 && !this.pending.has(c.file)) {
				this.pending.add(c.file);
				void fetch(new URL(c.file, this.root)).then(async (r) => {
					if (!r.ok) throw Error(String(r.status));
					const data = new Float32Array(await r.arrayBuffer());
					if (data.length !== c.count * 3) throw Error("Incomplete crater chunk");
					this.cache.set(c.file, {
						data,
						used: performance.now()
					});
				}).catch((e) => console.warn("Crater chunk unavailable:", c.file, e)).finally(() => {
					this.pending.delete(c.file);
					this.revision++;
				});
			}
		}
		let bytes = [...this.cache.values()].reduce((n, c) => n + c.data.byteLength, 0);
		for (const [file, c] of [...this.cache].sort((a, b) => a[1].used - b[1].used)) {
			if (bytes <= MAX_CACHE_BYTES) break;
			if (!keep.has(file)) {
				this.cache.delete(file);
				bytes -= c.data.byteLength;
			}
		}
		return arrays;
	}
}
/** One canvas per viewer, shared by the globe and the existing true-lat/lon flat map. */
class CraterLayer {
	show = false;
	viewer;
	flat;
	heightAt;
	canvas = document.createElement("canvas");
	ctx;
	catalogue = new Catalogue();
	raf = 0;
	timer = 0;
	token = 0;
	choosing = false;
	chosen = [];
	lastKey = "";
	lastRevision = -1;
	lastChoice = 0;
	lastDraw = 0;
	destroyed = false;
	renderOff;
	dirt = true;
	pathKey = "";
	clearedKey = "";
	drawing = false;
	paths = [];
	constructor(viewer, flat, heightAt) {
		this.viewer = viewer;
		this.flat = flat;
		this.heightAt = heightAt;
		this.canvas.className = "moon-crater-rims";
		this.canvas.setAttribute("aria-hidden", "true");
		this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;";
		viewer.container.appendChild(this.canvas);
		this.ctx = this.canvas.getContext("2d");
		// A fresh terrain tile can move its photo slightly even with a still camera.
		this.renderOff = viewer.scene.globe.tileLoadProgressEvent.addEventListener(() => {
			this.dirt = true;
		});
		this.raf = requestAnimationFrame(this.tick);
	}
	destroy() {
		this.destroyed = true;
		this.token++;
		cancelAnimationFrame(this.raf);
		clearTimeout(this.timer);
		this.renderOff();
		this.canvas.remove();
		this.catalogue.cache.clear();
		this.paths = [];
		this.chosen = [];
	}
	view() {
		const viewer = this.viewer, camera = viewer.camera;
		const width = viewer.canvas.clientWidth, height = viewer.canvas.clientHeight;
		const flat = this.flat();
		const matrix = Matrix4.multiply(camera.frustum.projectionMatrix, camera.viewMatrix, new Matrix4());
		const p = camera.positionWC, distance = Math.hypot(p.x, p.y, p.z);
		const eye = [
			p.x,
			p.y,
			p.z
		];
		let centre = [
			p.x / distance,
			p.y / distance,
			p.z / distance
		];
		let radius = Math.acos(Math.min(1, MOON_R / distance));
		const fovy = camera.frustum.fovy ?? .8;
		let mpp = 2 * Math.max(100, distance - MOON_R) * Math.tan(fovy / 2) / height;
		let key;
		if (flat?.active) {
			centre = trueToDisplayVec(trueUnit(flat.view.latC, flat.view.lonC));
			const fr = flat.free();
			const north = flat.toLatLon(fr.cx, 0).lat, south = flat.toLatLon(fr.cx, height).lat;
			const span = width / flat.view.s;
			const top = Math.min(90, north), bottom = Math.max(-90, south);
			const nearestEquator = bottom <= 0 && top >= 0 ? 0 : Math.min(Math.abs(top), Math.abs(bottom));
			// A meridian then a parallel bounds every point of this true-lat/lon rectangle,
			// even when its top reaches a pole or it wraps through the date line.
			radius = Math.min(Math.PI, Math.max(Math.abs(top - flat.view.latC), Math.abs(bottom - flat.view.latC)) * DEG + Math.min(180, span / 2) * DEG * Math.cos(nearestEquator * DEG) + .008);
			mpp = MOON_R * DEG / flat.view.s * Math.max(.08, Math.cos(flat.view.latC * DEG));
			key = `flat:${flat.view.latC}:${flat.view.lonC}:${flat.view.s}:${fr.cx}:${fr.cy}`;
		} else {
			// Bound the footprint, including edge-only rims. If an edge sees space, keep the whole horizon cap.
			const hits = [];
			let allHit = true;
			for (const x of [
				0,
				width / 2,
				width
			]) for (const y of [
				0,
				height / 2,
				height
			]) {
				const ray = camera.getPickRay(new Cartesian2(x, y));
				if (!ray) {
					allHit = false;
					continue;
				}
				const d = ray.direction, o = ray.origin;
				const b = o.x * d.x + o.y * d.y + o.z * d.z;
				const disc = b * b - (o.x * o.x + o.y * o.y + o.z * o.z - MOON_R * MOON_R);
				if (disc < 0) {
					allHit = false;
					continue;
				}
				const t = -b - Math.sqrt(disc);
				if (t < 0) {
					allHit = false;
					continue;
				}
				hits.push([
					(o.x + d.x * t) / MOON_R,
					(o.y + d.y * t) / MOON_R,
					(o.z + d.z * t) / MOON_R
				]);
			}
			if (allHit && hits.length === 9) {
				centre = hits[4];
				radius = 0;
				for (const h of hits) radius = Math.max(radius, Math.acos(clamp(dot(centre, h))));
			}
			radius = Math.min(Math.PI, radius + .008);
			// Cesium changes its near/far depth limits while tiles load. Only x, y and w
			// place a line on screen; a depth-only change must never clear the drawing.
			key = craterScreenKey(matrix);
		}
		return {
			flat: flat?.active ? flat : null,
			centre,
			radius,
			width,
			height,
			mpp,
			eye,
			matrix,
			key: `${width}:${height}:${key}`
		};
	}
	tick = () => {
		if (this.destroyed) return;
		if (this.viewer.isDestroyed()) {
			this.destroy();
			return;
		}
		const flat = this.flat();
		const visible = this.show && !flat?.busy && (!!flat?.active || this.viewer.scene.globe.show);
		this.canvas.style.visibility = visible ? "visible" : "hidden";
		if (!visible) {
			this.timer = window.setTimeout(() => {
				this.raf = requestAnimationFrame(this.tick);
			}, 150);
			return;
		}
		void this.catalogue.start();
		const view = this.view(), now = performance.now();
		const revision = this.catalogue.revision;
		// A finished choice asks for a new picture, not another choice. Combining those
		// two flags kept restarting work in a busy view before its picture could finish.
		const changed = view.key !== this.lastKey || revision !== this.lastRevision;
		if (changed && now - this.lastChoice > 160) {
			this.lastChoice = now;
			this.lastKey = view.key;
			this.lastRevision = revision;
			// A choice is cheap and sliced; cancelling an old one avoids a late fetch restoring the previous view.
			const token = ++this.token;
			this.choosing = true;
			void this.choose(view, token).finally(() => {
				if (token === this.token) this.choosing = false;
			});
		}
		if (view.key !== this.clearedKey) {
			// Never leave screen positions from the previous camera over a newly moved photo.
			this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
			this.paths = [];
			this.clearedKey = view.key;
		}
		if (!this.drawing && (view.key !== this.pathKey || this.dirt) && now - this.lastDraw > 30) {
			this.lastDraw = now;
			this.dirt = false;
			this.drawing = true;
			// A newer catalogue choice does not invalidate an otherwise correct picture.
			// Finish one picture before preparing the next, rather than starving both.
			void this.draw(view).finally(() => {
				this.drawing = false;
			});
		}
		this.canvas.dataset.rings = String(this.paths.length);
		this.canvas.dataset.loading = String(this.catalogue.pending.size + Number(this.choosing) + Number(this.drawing));
		this.canvas.dataset.drawing = String(this.drawing);
		this.canvas.dataset.chunks = String(this.catalogue.cache.size);
		this.raf = requestAnimationFrame(this.tick);
	};
	async choose(view, token) {
		const minKm = Math.max(.03, MIN_PIXELS * view.mpp / 1e3);
		const arrays = this.catalogue.forView(view, minKm);
		const records = [];
		let slice = performance.now();
		for (const a of arrays) for (let i = 0; i < a.length; i += 3) {
			if (i % 768 === 0 && performance.now() - slice > 4) {
				await pause();
				if (token !== this.token || this.destroyed || this.viewer.isDestroyed()) return;
				slice = performance.now();
			}
			const km = a[i + 2];
			if (km < minKm) break;
			const lat = a[i], lon = a[i + 1];
			const centre = trueToDisplayVec(trueUnit(lat, lon)), rho = km / (2 * R_KM);
			const d = dot(centre, view.centre);
			if (view.radius + rho < Math.PI && d < Math.cos(view.radius + rho)) continue;
			if (rho > view.radius && d > Math.cos(rho - view.radius)) continue;
			records.push({
				lat,
				lon,
				km,
				circle: craterCircle(lat, lon, km)
			});
			if (performance.now() - slice > 4) {
				await pause();
				if (token !== this.token || this.destroyed || this.viewer.isDestroyed()) return;
				slice = performance.now();
			}
		}
		records.sort((a, b) => b.km - a.km);
		if (token !== this.token || this.destroyed || this.viewer.isDestroyed()) return;
		this.chosen = records;
		this.dirt = true;
	}
	screen(unit, view) {
		if (view.flat) {
			const p = view.flat.toScreen(Math.asin(clamp(-unit[1])) / DEG, Math.atan2(unit[2], unit[0]) / DEG);
			return {
				...p,
				visible: true
			};
		}
		const lat = Math.asin(clamp(-unit[1])) / DEG, lon = Math.atan2(unit[2], unit[0]) / DEG;
		const r = MOON_R + this.heightAt(lat, lon);
		const x = unit[0] * r, y = unit[1] * r, z = unit[2] * r, m = view.matrix;
		const w = m[3] * x + m[7] * y + m[11] * z + m[15];
		return {
			x: (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * view.width / 2,
			y: (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * view.height / 2,
			visible: w > 0 && dot(unit, view.eye) > MOON_R - 12e3
		};
	}
	async draw(view) {
		const paths = [];
		let slice = performance.now();
		for (const record of this.chosen) {
			if (paths.length === MAX_RINGS) break;
			const c = record.circle;
			const distance = Math.hypot(view.eye[0] - c.centre[0] * MOON_R, view.eye[1] - c.centre[1] * MOON_R, view.eye[2] - c.centre[2] * MOON_R);
			const altitude = Math.max(100, Math.hypot(...view.eye) - MOON_R);
			const diameterPx = record.km * 1e3 / view.mpp * (view.flat ? 1 : altitude / distance);
			if (!view.flat && diameterPx < MIN_PIXELS) continue;
			const steps = Math.max(24, Math.min(2048, Math.ceil(Math.PI * Math.sqrt(Math.max(1, diameterPx) / .5))));
			const path = new Path2D();
			let previous = null, crosses = false;
			const add = (a, b) => {
				// Splitting at the map seam never draws a straight chord through the whole flat map.
				if (!(a.visible && b.visible) || view.flat && Math.abs(a.x - b.x) > 180 * view.flat.view.s) return;
				if (Math.max(a.x, b.x) < -2 || Math.min(a.x, b.x) > view.width + 2 || Math.max(a.y, b.y) < -2 || Math.min(a.y, b.y) > view.height + 2) return;
				path.moveTo(a.x, a.y);
				path.lineTo(b.x, b.y);
				crosses = true;
			};
			// Refine in screen space too: the flat map stretches circles strongly near either true pole.
			const segment = (a, pa, b, pb, depth) => {
				const mid = (a + b) / 2, pm = this.screen(pointOnCrater(c, mid), view);
				const err = Math.hypot(pm.x - (pa.x + pb.x) / 2, pm.y - (pa.y + pb.y) / 2);
				if (depth < 9 && (err > .3 || pa.visible !== pb.visible) && (pa.visible || pb.visible || pm.visible)) {
					segment(a, pa, mid, pm, depth + 1);
					segment(mid, pm, b, pb, depth + 1);
				} else add(pa, pb);
			};
			for (let i = 0; i <= steps; i++) {
				const a = i / steps * Math.PI * 2, p = this.screen(pointOnCrater(c, a), view);
				if (previous) segment((i - 1) / steps * Math.PI * 2, previous, a, p, 0);
				previous = p;
				if (i % 32 === 0 && performance.now() - slice > 4) {
					await pause();
					if (this.destroyed || this.viewer.isDestroyed() || view.key !== this.view().key) return;
					slice = performance.now();
				}
			}
			if (crosses) paths.push({
				record,
				path
			});
			if (performance.now() - slice > 4) {
				await pause();
				if (this.destroyed || this.viewer.isDestroyed() || view.key !== this.view().key) return;
				slice = performance.now();
			}
		}
		if (this.destroyed || this.viewer.isDestroyed() || view.key !== this.view().key) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		if (this.canvas.width !== Math.round(view.width * dpr) || this.canvas.height !== Math.round(view.height * dpr)) {
			this.canvas.width = Math.round(view.width * dpr);
			this.canvas.height = Math.round(view.height * dpr);
		}
		const g = this.ctx;
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, view.width, view.height);
		g.strokeStyle = "rgba(235, 241, 247, 0.7)";
		g.lineWidth = 1.25;
		g.lineCap = "round";
		g.lineJoin = "round";
		for (const p of paths) g.stroke(p.path);
		this.paths = paths;
		this.pathKey = view.key;
		this.canvas.dataset.minKm = String(Math.min(...paths.map((p) => p.record.km)));
	}
}
const layers = new WeakMap();
/** Creates once, then switches the same vector layer on both maps. No imagery texture slot is used. */
export function createCraterLayer(viewer, flat, heightAt) {
	let layer = layers.get(viewer);
	if (!layer) {
		layer = new CraterLayer(viewer, flat, heightAt);
		layers.set(viewer, layer);
	}
	return layer;
}

//# sourceMappingURL=data:application/json;base64,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T0FBTyxRQUFRLEtBQUssTUFBTSxLQUFLLFFBQVEsR0FBRztHQUFHLEtBQUssT0FBTyxTQUFTLEtBQUssTUFBTSxLQUFLLFNBQVMsR0FBRztFQUNyRztFQUNBLE1BQU0sSUFBSSxLQUFLO0VBQ2YsRUFBRSxhQUFhLEtBQUssR0FBRyxHQUFHLEtBQUssR0FBRyxDQUFDO0VBQUcsRUFBRSxVQUFVLEdBQUcsR0FBRyxLQUFLLE9BQU8sS0FBSyxNQUFNO0VBQy9FLEVBQUUsY0FBYztFQUE0QixFQUFFLFlBQVk7RUFBTSxFQUFFLFVBQVU7RUFBUyxFQUFFLFdBQVc7RUFDbEcsS0FBSyxNQUFNLEtBQUssT0FBTyxFQUFFLE9BQU8sRUFBRSxJQUFJO0VBQ3RDLEtBQUssUUFBUTtFQUNiLEtBQUssVUFBVSxLQUFLO0VBQ3BCLEtBQUssT0FBTyxRQUFRLFFBQVEsT0FBTyxLQUFLLElBQUksR0FBRyxNQUFNLEtBQUksTUFBSyxFQUFFLE9BQU8sRUFBRSxDQUFDLENBQUM7Q0FDN0U7QUFDRjtBQUVBLE1BQU0sU0FBUyxJQUFJLFFBQTZCOztBQUVoRCxPQUFPLFNBQVMsa0JBQWtCLFFBQWdCLE1BQTRCLFVBQTZEO0NBQ3pJLElBQUksUUFBUSxPQUFPLElBQUksTUFBTTtDQUM3QixJQUFJLENBQUMsT0FBTztFQUFFLFFBQVEsSUFBSSxZQUFZLFFBQVEsTUFBTSxRQUFRO0VBQUcsT0FBTyxJQUFJLFFBQVEsS0FBSztDQUFHO0NBQzFGLE9BQU87QUFDVCIsIm5hbWVzIjpbXSwic291cmNlcyI6WyJjcmF0ZXJMYXllci50cyJdLCJ2ZXJzaW9uIjozLCJzb3VyY2VzQ29udGVudCI6WyIvLyBNZWFzdXJlZCBjaXJjdWxhciBmaXRzLCBkcmF3biBhcyBzbWFsbCBjaXJjbGVzIG9uIHRoZSBNb29uLCBuZXZlciBhcyBjaXJjbGVzIGluIGEgbWFwIHRpbGUuXG4vLyBTb3VyY2U6IFJvYmJpbnMgKDIwMTkpLCBodHRwczovL2FzdHJvZ2VvbG9neS51c2dzLmdvdi9zZWFyY2gvbWFwL21vb25fY3JhdGVyX2RhdGFiYXNlX3YxX3JvYmJpbnNcbi8vIFNtYWxsIHNvdXRoLXBvbGFyIGNhdGFsb2d1ZTogTWFyY28gRmlndWVyYSBldCBhbC4gKDIwMjIpLCBDQyBCWSA0LjAsXG4vLyBodHRwczovL3plbm9kby5vcmcvcmVjb3Jkcy81Nzc5MjYwIChmdWxsIGF0dHJpYnV0aW9uIGlzIHJldGFpbmVkIGluIGNyYXRlcnMuanNvbikuXG4vLyBUaGUgZnVsbCBjYXRhbG9ndWUgaXMgc3BsaXQgYnkgcmVnaW9uIGFuZCBzaXplIGluIGRhdGEtcHJlcC9mZWF0dXJlcy9zY3JpcHRzL2J1aWxkX2NyYXRlcl9kcmF3aW5nLnB5LlxuLy8gS2VlcCBjcmF0ZXJzLmJpbiB1bmNoYW5nZWQ6IHRoZSByb3V0ZSBwbGFubmVyIGFsc28gcmVhZHMgdGhvc2UgRmxvYXQzMiB0cmlwbGVzLlxuLy9cbi8vIEEgc2NyZWVuIHZlY3RvciBsYXllciBhdm9pZHMgdHdvIHJhc3RlciBwcm9ibGVtczogbmVpZ2hib3VyaW5nIHRpbGVzIGNob29zaW5nIGRpZmZlcmVudCByaW5ncyxcbi8vIGFuZCBhIGxpbmUgZ2V0dGluZyB3aWRlciB3aGVuIENlc2l1bSBtYWduaWZpZXMgaXRzIHBhcmVudCB0aWxlLiBPbmUgY2hvaWNlIG9mIGF0IG1vc3QgNDAwIHdob2xlXG4vLyByaW1zIHNlcnZlcyB0aGUgZW50aXJlIHZpZXcuIENhdGFsb2d1ZSBzY2FucyBhbmQgcGF0aCBwcmVwYXJhdGlvbiB5aWVsZCBldmVyeSBmZXcgbWlsbGlzZWNvbmRzLlxuLy8gVGhlIG9sZCBjYW52YXMgYml0bWFwcyBhbHNvIGxhY2tlZCB0aGUgcGhvdG8gd29ya2VyJ3Mgcm93IGZsaXAuIFdlYkdMIGlnbm9yZXMgQ2VzaXVtJ3MgdXBsb2FkXG4vLyBmbGlwIGZvciBJbWFnZUJpdG1hcCwgc28gZWFjaCB0aWxlJ3MgcmluZ3Mgd2VyZSBtaXJyb3JlZCB3aXRoaW4gdGhhdCB0aWxlLCBzaGlmdGluZyB0aGVtIG9uIHRoZVxuLy8gZ3JvdW5kLiBEcmF3aW5nIHZlY3RvcnMgc2tpcHMgdGhhdCB1cGxvYWQgZW50aXJlbHkuIFNwZWNpZmljYXRpb246XG4vLyBodHRwczovL3JlZ2lzdHJ5Lmtocm9ub3Mub3JnL3dlYmdsL3NwZWNzL2xhdGVzdC8xLjAvI1RFWElNQUdFMkRfSFRNTFxuaW1wb3J0IHsgQ2FydGVzaWFuMiwgTWF0cml4NCwgdHlwZSBWaWV3ZXIgfSBmcm9tICdjZXNpdW0nO1xuaW1wb3J0IHsgTU9PTl9SLCB0cnVlVW5pdCwgdHJ1ZVRvRGlzcGxheVZlYywgdHlwZSBWMyB9IGZyb20gJy4vZnJhbWUudHMnO1xuaW1wb3J0IHR5cGUgeyBGbGF0TWFwIH0gZnJvbSAnLi9mbGF0TWFwLnRzJztcblxuY29uc3QgREVHID0gTWF0aC5QSSAvIDE4MDtcbmNvbnN0IFJfS00gPSBNT09OX1IgLyAxMDAwO1xuY29uc3QgTUFYX1JJTkdTID0gNDAwO1xuY29uc3QgTUlOX1BJWEVMUyA9IDk7XG5jb25zdCBNQVhfQ0FDSEVfQllURVMgPSAxMCAqIDEwMjQgKiAxMDI0O1xuY29uc3QgcGF1c2UgPSAoKSA9PiBuZXcgUHJvbWlzZTx2b2lkPihyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMCkpO1xuY29uc3QgY2xhbXAgPSAodjogbnVtYmVyKSA9PiBNYXRoLm1heCgtMSwgTWF0aC5taW4oMSwgdikpO1xuY29uc3QgZG90ID0gKGE6IFYzLCBiOiBWMykgPT4gYVswXSAqIGJbMF0gKyBhWzFdICogYlsxXSArIGFbMl0gKiBiWzJdO1xuY29uc3Qgd3JhcCA9IChyOiBudW1iZXIpID0+ICgociArIE1hdGguUEkpICUgKDIgKiBNYXRoLlBJKSArIDIgKiBNYXRoLlBJKSAlICgyICogTWF0aC5QSSkgLSBNYXRoLlBJO1xuXG5leHBvcnQgaW50ZXJmYWNlIENyYXRlckNpcmNsZSB7XG4gIGNlbnRyZTogVjM7IGVhc3Q6IFYzOyBub3J0aDogVjM7XG4gIHJhZGl1c1JhZDogbnVtYmVyOyBjb3NSYWRpdXM6IG51bWJlcjsgc2luUmFkaXVzOiBudW1iZXI7XG59XG5cbi8qKiBQb3NpdGl2ZS1lYXN0LCBwbGFuZXRvY2VudHJpYyBzb3VyY2UgY29vcmRpbmF0ZXM7IGRpYW1ldGVyIGlzIGFuIGFyYyBsZW5ndGggaW4ga20uICovXG5leHBvcnQgZnVuY3Rpb24gY3JhdGVyQ2lyY2xlKGxhdERlZzogbnVtYmVyLCBsb25EZWc6IG51bWJlciwgZGlhbWV0ZXJLbTogbnVtYmVyKTogQ3JhdGVyQ2lyY2xlIHtcbiAgY29uc3QgcCA9IGxhdERlZyAqIERFRywgbCA9IGxvbkRlZyAqIERFRztcbiAgY29uc3QgcmFkaXVzUmFkID0gZGlhbWV0ZXJLbSAvICgyICogUl9LTSk7XG4gIHJldHVybiB7XG4gICAgY2VudHJlOiB0cnVlVG9EaXNwbGF5VmVjKHRydWVVbml0KGxhdERlZywgbG9uRGVnKSksXG4gICAgZWFzdDogdHJ1ZVRvRGlzcGxheVZlYyhbLU1hdGguc2luKGwpLCBNYXRoLmNvcyhsKSwgMF0pLFxuICAgIG5vcnRoOiB0cnVlVG9EaXNwbGF5VmVjKFstTWF0aC5zaW4ocCkgKiBNYXRoLmNvcyhsKSwgLU1hdGguc2luKHApICogTWF0aC5zaW4obCksIE1hdGguY29zKHApXSksXG4gICAgcmFkaXVzUmFkLCBjb3NSYWRpdXM6IE1hdGguY29zKHJhZGl1c1JhZCksIHNpblJhZGl1czogTWF0aC5zaW4ocmFkaXVzUmFkKSxcbiAgfTtcbn1cblxuLyoqIEEgdHJ1ZSBzcGhlcmljYWwgcmltIHBvaW50LCByb3RhdGVkIGV4YWN0bHkgYXMgdGhlIHBob3RvIGlzIChkaXNwbGF5ID0geCwgLXosIHkpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBvaW50T25DcmF0ZXIoYzogQ3JhdGVyQ2lyY2xlLCBiZWFyaW5nUmFkOiBudW1iZXIpOiBWMyB7XG4gIGNvbnN0IGUgPSBNYXRoLmNvcyhiZWFyaW5nUmFkKSAqIGMuc2luUmFkaXVzLCBuID0gTWF0aC5zaW4oYmVhcmluZ1JhZCkgKiBjLnNpblJhZGl1cztcbiAgcmV0dXJuIFtjLmNlbnRyZVswXSAqIGMuY29zUmFkaXVzICsgYy5lYXN0WzBdICogZSArIGMubm9ydGhbMF0gKiBuLFxuICAgIGMuY2VudHJlWzFdICogYy5jb3NSYWRpdXMgKyBjLmVhc3RbMV0gKiBlICsgYy5ub3J0aFsxXSAqIG4sXG4gICAgYy5jZW50cmVbMl0gKiBjLmNvc1JhZGl1cyArIGMuZWFzdFsyXSAqIGUgKyBjLm5vcnRoWzJdICogbl07XG59XG5cbi8qKiBSZWZlcmVuY2UgcHJvamVjdGlvbiBmb3IgdGhlIHNoYXJlZC1lZGdlIGNoZWNrLiBUaGUgbGl2ZSByZW5kZXJlciBoYXMgbm8gdGlsZSBib3VuZGFyaWVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb2plY3RDcmF0ZXJQb2ludFRvVGlsZShwOiBWMywgcjogeyB3ZXN0OiBudW1iZXI7IGVhc3Q6IG51bWJlcjsgc291dGg6IG51bWJlcjsgbm9ydGg6IG51bWJlciB9LCBzaXplID0gMjU2KTogeyB4OiBudW1iZXI7IHk6IG51bWJlciB9IHtcbiAgY29uc3QgbG9uID0gd3JhcChNYXRoLmF0YW4yKHBbMV0sIHBbMF0pIC0gKHIud2VzdCArIHIuZWFzdCkgLyAyKTtcbiAgcmV0dXJuIHsgeDogKGxvbiAvIChyLmVhc3QgLSByLndlc3QpICsgMC41KSAqIHNpemUsXG4gICAgeTogKHIubm9ydGggLSBNYXRoLmFzaW4oY2xhbXAocFsyXSkpKSAvIChyLm5vcnRoIC0gci5zb3V0aCkgKiBzaXplIH07XG59XG5cbi8qKiBTY3JlZW4gcG9zaXRpb25zIHVzZSB4LCB5IGFuZCB3IG9ubHkuIERlcHRoIGNoYW5nZXMgYW5kIHN1Yi1waXhlbCBub2lzZSBhcmUgbm90IGNhbWVyYSBtb3Zlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmF0ZXJTY3JlZW5LZXkobWF0cml4OiBBcnJheUxpa2U8bnVtYmVyPik6IHN0cmluZyB7XG4gIHJldHVybiBbMCwgMSwgMywgNCwgNSwgNywgOCwgOSwgMTEsIDEyLCAxMywgMTVdLm1hcChpID0+IHtcbiAgICBjb25zdCBzY2FsZSA9IGkgPj0gMTIgPyAxZTQgOiAxZTEyO1xuICAgIHJldHVybiBNYXRoLnJvdW5kKG1hdHJpeFtpXSAqIHNjYWxlKSAvIHNjYWxlO1xuICB9KS5qb2luKCcsJyk7XG59XG5cbmludGVyZmFjZSBDaHVuayB7XG4gIGZpbGU6IHN0cmluZzsgY291bnQ6IG51bWJlcjsgYnl0ZXM6IG51bWJlcjsgbWluS206IG51bWJlcjsgbWF4S206IG51bWJlcjtcbiAgY2VudHJlOiBWMzsgcmFkaXVzUmFkOiBudW1iZXI7XG59XG5pbnRlcmZhY2UgSW5kZXggeyBjb3VudDogbnVtYmVyOyBjaHVua3M6IENodW5rW10gfVxuaW50ZXJmYWNlIENhY2hlZCB7IGRhdGE6IEZsb2F0MzJBcnJheTsgdXNlZDogbnVtYmVyIH1cbmludGVyZmFjZSBDYXAgeyBjZW50cmU6IFYzOyByYWRpdXM6IG51bWJlciB9XG5pbnRlcmZhY2UgVmlldyBleHRlbmRzIENhcCB7XG4gIGZsYXQ6IEZsYXRNYXAgfCBudWxsOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgbXBwOiBudW1iZXI7XG4gIGV5ZTogVjM7IG1hdHJpeDogTWF0cml4NDsga2V5OiBzdHJpbmc7XG59XG5pbnRlcmZhY2UgUmVjb3JkIHsgbGF0OiBudW1iZXI7IGxvbjogbnVtYmVyOyBrbTogbnVtYmVyOyBjaXJjbGU6IENyYXRlckNpcmNsZSB9XG5pbnRlcmZhY2UgRHJhd24geyByZWNvcmQ6IFJlY29yZDsgcGF0aDogUGF0aDJEIH1cbmludGVyZmFjZSBTY3JlZW5Qb2ludCB7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB2aXNpYmxlOiBib29sZWFuIH1cblxuY2xhc3MgQ2F0YWxvZ3VlIHtcbiAgaW5kZXg6IEluZGV4IHwgbnVsbCA9IG51bGw7XG4gIHNtYWxsID0gbmV3IEZsb2F0MzJBcnJheSgwKTtcbiAgY2FjaGUgPSBuZXcgTWFwPHN0cmluZywgQ2FjaGVkPigpO1xuICBwZW5kaW5nID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIHJldmlzaW9uID0gMDtcbiAgcHJpdmF0ZSBzdGFydGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHJvb3QgPSBuZXcgVVJMKCcuL2RhdGEvZmVhdHVyZXMvJywgZG9jdW1lbnQuYmFzZVVSSSk7XG5cbiAgc3RhcnQoKSB7XG4gICAgdGhpcy5zdGFydGluZyA/Pz0gKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IFtpbmRleCwgc21hbGxdID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKFtcbiAgICAgICAgZmV0Y2gobmV3IFVSTCgnY3JhdGVycy1kcmF3L2luZGV4Lmpzb24nLCB0aGlzLnJvb3QpKS50aGVuKHIgPT4geyBpZiAoIXIub2spIHRocm93IEVycm9yKFN0cmluZyhyLnN0YXR1cykpOyByZXR1cm4gci5qc29uKCkgYXMgUHJvbWlzZTxJbmRleD47IH0pLFxuICAgICAgICBmZXRjaChuZXcgVVJMKCdjcmF0ZXJzLXNtYWxsLXNvdXRoLmJpbicsIHRoaXMucm9vdCkpLnRoZW4ociA9PiByLm9rID8gci5hcnJheUJ1ZmZlcigpIDogbmV3IEFycmF5QnVmZmVyKDApKSxcbiAgICAgIF0pO1xuICAgICAgaWYgKGluZGV4LnN0YXR1cyA9PT0gJ2Z1bGZpbGxlZCcpIHRoaXMuaW5kZXggPSBpbmRleC52YWx1ZTtcbiAgICAgIGVsc2Uge1xuICAgICAgICAvLyBPbGRlciBvZmZsaW5lIGNhY2hlcyBjYW4gc3RpbGwgZHJhdyB0aGUgcmV0YWluZWQgcGxhbm5lciBjYXRhbG9ndWUuXG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChuZXcgVVJMKCdjcmF0ZXJzLmJpbicsIHRoaXMucm9vdCkpO1xuICAgICAgICBpZiAoci5vaykgdGhpcy5jYWNoZS5zZXQoJ2xlZ2FjeScsIHsgZGF0YTogbmV3IEZsb2F0MzJBcnJheShhd2FpdCByLmFycmF5QnVmZmVyKCkpLCB1c2VkOiBwZXJmb3JtYW5jZS5ub3coKSB9KTtcbiAgICAgIH1cbiAgICAgIGlmIChzbWFsbC5zdGF0dXMgPT09ICdmdWxmaWxsZWQnKSB0aGlzLnNtYWxsID0gbmV3IEZsb2F0MzJBcnJheShzbWFsbC52YWx1ZSk7XG4gICAgICB0aGlzLnJldmlzaW9uKys7XG4gICAgfSkoKS5jYXRjaChlID0+IGNvbnNvbGUud2FybignQ3JhdGVyIGNhdGFsb2d1ZSB1bmF2YWlsYWJsZTonLCBlKSk7XG4gICAgcmV0dXJuIHRoaXMuc3RhcnRpbmc7XG4gIH1cblxuICBmb3JWaWV3KHZpZXc6IENhcCwgbWluS206IG51bWJlcik6IEZsb2F0MzJBcnJheVtdIHtcbiAgICBjb25zdCBhcnJheXM6IEZsb2F0MzJBcnJheVtdID0gW3RoaXMuc21hbGxdO1xuICAgIGlmICghdGhpcy5pbmRleCkgeyBjb25zdCBsZWdhY3kgPSB0aGlzLmNhY2hlLmdldCgnbGVnYWN5Jyk7IGlmIChsZWdhY3kpIGFycmF5cy5wdXNoKGxlZ2FjeS5kYXRhKTsgcmV0dXJuIGFycmF5czsgfVxuICAgIGNvbnN0IG5lZWRlZCA9IHRoaXMuaW5kZXguY2h1bmtzLmZpbHRlcihjID0+IGMubWF4S20gPj0gbWluS20gJiZcbiAgICAgICh2aWV3LnJhZGl1cyArIGMucmFkaXVzUmFkID49IE1hdGguUEkgfHwgZG90KHZpZXcuY2VudHJlLCBjLmNlbnRyZSkgPj0gTWF0aC5jb3Modmlldy5yYWRpdXMgKyBjLnJhZGl1c1JhZCkpKTtcbiAgICBjb25zdCBrZWVwID0gbmV3IFNldChuZWVkZWQubWFwKGMgPT4gYy5maWxlKSk7XG4gICAgZm9yIChjb25zdCBjIG9mIG5lZWRlZCkge1xuICAgICAgY29uc3QgaGl0ID0gdGhpcy5jYWNoZS5nZXQoYy5maWxlKTtcbiAgICAgIGlmIChoaXQpIHsgaGl0LnVzZWQgPSBwZXJmb3JtYW5jZS5ub3coKTsgYXJyYXlzLnB1c2goaGl0LmRhdGEpOyB9XG4gICAgICBlbHNlIGlmICh0aGlzLnBlbmRpbmcuc2l6ZSA8IDQgJiYgIXRoaXMucGVuZGluZy5oYXMoYy5maWxlKSkge1xuICAgICAgICB0aGlzLnBlbmRpbmcuYWRkKGMuZmlsZSk7XG4gICAgICAgIHZvaWQgZmV0Y2gobmV3IFVSTChjLmZpbGUsIHRoaXMucm9vdCkpLnRoZW4oYXN5bmMgciA9PiB7XG4gICAgICAgICAgaWYgKCFyLm9rKSB0aHJvdyBFcnJvcihTdHJpbmcoci5zdGF0dXMpKTtcbiAgICAgICAgICBjb25zdCBkYXRhID0gbmV3IEZsb2F0MzJBcnJheShhd2FpdCByLmFycmF5QnVmZmVyKCkpO1xuICAgICAgICAgIGlmIChkYXRhLmxlbmd0aCAhPT0gYy5jb3VudCAqIDMpIHRocm93IEVycm9yKCdJbmNvbXBsZXRlIGNyYXRlciBjaHVuaycpO1xuICAgICAgICAgIHRoaXMuY2FjaGUuc2V0KGMuZmlsZSwgeyBkYXRhLCB1c2VkOiBwZXJmb3JtYW5jZS5ub3coKSB9KTtcbiAgICAgICAgfSkuY2F0Y2goZSA9PiBjb25zb2xlLndhcm4oJ0NyYXRlciBjaHVuayB1bmF2YWlsYWJsZTonLCBjLmZpbGUsIGUpKS5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICB0aGlzLnBlbmRpbmcuZGVsZXRlKGMuZmlsZSk7IHRoaXMucmV2aXNpb24rKztcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGxldCBieXRlcyA9IFsuLi50aGlzLmNhY2hlLnZhbHVlcygpXS5yZWR1Y2UoKG4sIGMpID0+IG4gKyBjLmRhdGEuYnl0ZUxlbmd0aCwgMCk7XG4gICAgZm9yIChjb25zdCBbZmlsZSwgY10gb2YgWy4uLnRoaXMuY2FjaGVdLnNvcnQoKGEsIGIpID0+IGFbMV0udXNlZCAtIGJbMV0udXNlZCkpIHtcbiAgICAgIGlmIChieXRlcyA8PSBNQVhfQ0FDSEVfQllURVMpIGJyZWFrO1xuICAgICAgaWYgKCFrZWVwLmhhcyhmaWxlKSkgeyB0aGlzLmNhY2hlLmRlbGV0ZShmaWxlKTsgYnl0ZXMgLT0gYy5kYXRhLmJ5dGVMZW5ndGg7IH1cbiAgICB9XG4gICAgcmV0dXJuIGFycmF5cztcbiAgfVxufVxuXG4vKiogT25lIGNhbnZhcyBwZXIgdmlld2VyLCBzaGFyZWQgYnkgdGhlIGdsb2JlIGFuZCB0aGUgZXhpc3RpbmcgdHJ1ZS1sYXQvbG9uIGZsYXQgbWFwLiAqL1xuY2xhc3MgQ3JhdGVyTGF5ZXIge1xuICBzaG93ID0gZmFsc2U7XG4gIHByaXZhdGUgdmlld2VyOiBWaWV3ZXI7XG4gIHByaXZhdGUgZmxhdDogKCkgPT4gRmxhdE1hcCB8IG51bGw7XG4gIHByaXZhdGUgaGVpZ2h0QXQ6IChsYXQ6IG51bWJlciwgbG9uOiBudW1iZXIpID0+IG51bWJlcjtcbiAgcHJpdmF0ZSBjYW52YXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcbiAgcHJpdmF0ZSBjdHg6IENhbnZhc1JlbmRlcmluZ0NvbnRleHQyRDtcbiAgcHJpdmF0ZSBjYXRhbG9ndWUgPSBuZXcgQ2F0YWxvZ3VlKCk7XG4gIHByaXZhdGUgcmFmID0gMDtcbiAgcHJpdmF0ZSB0aW1lciA9IDA7XG4gIHByaXZhdGUgdG9rZW4gPSAwO1xuICBwcml2YXRlIGNob29zaW5nID0gZmFsc2U7XG4gIHByaXZhdGUgY2hvc2VuOiBSZWNvcmRbXSA9IFtdO1xuICBwcml2YXRlIGxhc3RLZXkgPSAnJztcbiAgcHJpdmF0ZSBsYXN0UmV2aXNpb24gPSAtMTtcbiAgcHJpdmF0ZSBsYXN0Q2hvaWNlID0gMDtcbiAgcHJpdmF0ZSBsYXN0RHJhdyA9IDA7XG4gIHByaXZhdGUgZGVzdHJveWVkID0gZmFsc2U7XG4gIHByaXZhdGUgcmVuZGVyT2ZmOiAoKSA9PiB2b2lkO1xuICBwcml2YXRlIGRpcnQgPSB0cnVlO1xuICBwcml2YXRlIHBhdGhLZXkgPSAnJztcbiAgcHJpdmF0ZSBjbGVhcmVkS2V5ID0gJyc7XG4gIHByaXZhdGUgZHJhd2luZyA9IGZhbHNlO1xuICBwcml2YXRlIHBhdGhzOiBEcmF3bltdID0gW107XG5cbiAgY29uc3RydWN0b3Iodmlld2VyOiBWaWV3ZXIsIGZsYXQ6ICgpID0+IEZsYXRNYXAgfCBudWxsLCBoZWlnaHRBdDogKGxhdDogbnVtYmVyLCBsb246IG51bWJlcikgPT4gbnVtYmVyKSB7XG4gICAgdGhpcy52aWV3ZXIgPSB2aWV3ZXI7IHRoaXMuZmxhdCA9IGZsYXQ7IHRoaXMuaGVpZ2h0QXQgPSBoZWlnaHRBdDtcbiAgICB0aGlzLmNhbnZhcy5jbGFzc05hbWUgPSAnbW9vbi1jcmF0ZXItcmltcyc7XG4gICAgdGhpcy5jYW52YXMuc2V0QXR0cmlidXRlKCdhcmlhLWhpZGRlbicsICd0cnVlJyk7XG4gICAgdGhpcy5jYW52YXMuc3R5bGUuY3NzVGV4dCA9ICdwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7cG9pbnRlci1ldmVudHM6bm9uZTt6LWluZGV4OjI7JztcbiAgICB2aWV3ZXIuY29udGFpbmVyLmFwcGVuZENoaWxkKHRoaXMuY2FudmFzKTtcbiAgICB0aGlzLmN0eCA9IHRoaXMuY2FudmFzLmdldENvbnRleHQoJzJkJykhO1xuICAgIC8vIEEgZnJlc2ggdGVycmFpbiB0aWxlIGNhbiBtb3ZlIGl0cyBwaG90byBzbGlnaHRseSBldmVuIHdpdGggYSBzdGlsbCBjYW1lcmEuXG4gICAgdGhpcy5yZW5kZXJPZmYgPSB2aWV3ZXIuc2NlbmUuZ2xvYmUudGlsZUxvYWRQcm9ncmVzc0V2ZW50LmFkZEV2ZW50TGlzdGVuZXIoKCkgPT4geyB0aGlzLmRpcnQgPSB0cnVlOyB9KTtcbiAgICB0aGlzLnJhZiA9IHJlcXVlc3RBbmltYXRpb25GcmFtZSh0aGlzLnRpY2spO1xuICB9XG5cbiAgZGVzdHJveSgpIHtcbiAgICB0aGlzLmRlc3Ryb3llZCA9IHRydWU7IHRoaXMudG9rZW4rKztcbiAgICBjYW5jZWxBbmltYXRpb25GcmFtZSh0aGlzLnJhZik7IGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTtcbiAgICB0aGlzLnJlbmRlck9mZigpOyB0aGlzLmNhbnZhcy5yZW1vdmUoKTtcbiAgICB0aGlzLmNhdGFsb2d1ZS5jYWNoZS5jbGVhcigpOyB0aGlzLnBhdGhzID0gW107IHRoaXMuY2hvc2VuID0gW107XG4gIH1cblxuICBwcml2YXRlIHZpZXcoKTogVmlldyB7XG4gICAgY29uc3Qgdmlld2VyID0gdGhpcy52aWV3ZXIsIGNhbWVyYSA9IHZpZXdlci5jYW1lcmE7XG4gICAgY29uc3Qgd2lkdGggPSB2aWV3ZXIuY2FudmFzLmNsaWVudFdpZHRoLCBoZWlnaHQgPSB2aWV3ZXIuY2FudmFzLmNsaWVudEhlaWdodDtcbiAgICBjb25zdCBmbGF0ID0gdGhpcy5mbGF0KCk7XG4gICAgY29uc3QgbWF0cml4ID0gTWF0cml4NC5tdWx0aXBseShjYW1lcmEuZnJ1c3R1bS5wcm9qZWN0aW9uTWF0cml4LCBjYW1lcmEudmlld01hdHJpeCwgbmV3IE1hdHJpeDQoKSk7XG4gICAgY29uc3QgcCA9IGNhbWVyYS5wb3NpdGlvbldDLCBkaXN0YW5jZSA9IE1hdGguaHlwb3QocC54LCBwLnksIHAueik7XG4gICAgY29uc3QgZXllOiBWMyA9IFtwLngsIHAueSwgcC56XTtcbiAgICBsZXQgY2VudHJlOiBWMyA9IFtwLnggLyBkaXN0YW5jZSwgcC55IC8gZGlzdGFuY2UsIHAueiAvIGRpc3RhbmNlXTtcbiAgICBsZXQgcmFkaXVzID0gTWF0aC5hY29zKE1hdGgubWluKDEsIE1PT05fUiAvIGRpc3RhbmNlKSk7XG4gICAgY29uc3QgZm92eSA9IChjYW1lcmEuZnJ1c3R1bSBhcyB1bmtub3duIGFzIHsgZm92eT86IG51bWJlciB9KS5mb3Z5ID8/IDAuODtcbiAgICBsZXQgbXBwID0gMiAqIE1hdGgubWF4KDEwMCwgZGlzdGFuY2UgLSBNT09OX1IpICogTWF0aC50YW4oZm92eSAvIDIpIC8gaGVpZ2h0O1xuICAgIGxldCBrZXk6IHN0cmluZztcbiAgICBpZiAoZmxhdD8uYWN0aXZlKSB7XG4gICAgICBjZW50cmUgPSB0cnVlVG9EaXNwbGF5VmVjKHRydWVVbml0KGZsYXQudmlldy5sYXRDLCBmbGF0LnZpZXcubG9uQykpO1xuICAgICAgY29uc3QgZnIgPSBmbGF0LmZyZWUoKTtcbiAgICAgIGNvbnN0IG5vcnRoID0gZmxhdC50b0xhdExvbihmci5jeCwgMCkubGF0LCBzb3V0aCA9IGZsYXQudG9MYXRMb24oZnIuY3gsIGhlaWdodCkubGF0O1xuICAgICAgY29uc3Qgc3BhbiA9IHdpZHRoIC8gZmxhdC52aWV3LnM7XG4gICAgICBjb25zdCB0b3AgPSBNYXRoLm1pbig5MCwgbm9ydGgpLCBib3R0b20gPSBNYXRoLm1heCgtOTAsIHNvdXRoKTtcbiAgICAgIGNvbnN0IG5lYXJlc3RFcXVhdG9yID0gYm90dG9tIDw9IDAgJiYgdG9wID49IDAgPyAwIDogTWF0aC5taW4oTWF0aC5hYnModG9wKSwgTWF0aC5hYnMoYm90dG9tKSk7XG4gICAgICAvLyBBIG1lcmlkaWFuIHRoZW4gYSBwYXJhbGxlbCBib3VuZHMgZXZlcnkgcG9pbnQgb2YgdGhpcyB0cnVlLWxhdC9sb24gcmVjdGFuZ2xlLFxuICAgICAgLy8gZXZlbiB3aGVuIGl0cyB0b3AgcmVhY2hlcyBhIHBvbGUgb3IgaXQgd3JhcHMgdGhyb3VnaCB0aGUgZGF0ZSBsaW5lLlxuICAgICAgcmFkaXVzID0gTWF0aC5taW4oTWF0aC5QSSwgTWF0aC5tYXgoTWF0aC5hYnModG9wIC0gZmxhdC52aWV3LmxhdEMpLCBNYXRoLmFicyhib3R0b20gLSBmbGF0LnZpZXcubGF0QykpICogREVHICtcbiAgICAgICAgTWF0aC5taW4oMTgwLCBzcGFuIC8gMikgKiBERUcgKiBNYXRoLmNvcyhuZWFyZXN0RXF1YXRvciAqIERFRykgKyAwLjAwOCk7XG4gICAgICBtcHAgPSBNT09OX1IgKiBERUcgLyBmbGF0LnZpZXcucyAqIE1hdGgubWF4KDAuMDgsIE1hdGguY29zKGZsYXQudmlldy5sYXRDICogREVHKSk7XG4gICAgICBrZXkgPSBgZmxhdDoke2ZsYXQudmlldy5sYXRDfToke2ZsYXQudmlldy5sb25DfToke2ZsYXQudmlldy5zfToke2ZyLmN4fToke2ZyLmN5fWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEJvdW5kIHRoZSBmb290cHJpbnQsIGluY2x1ZGluZyBlZGdlLW9ubHkgcmltcy4gSWYgYW4gZWRnZSBzZWVzIHNwYWNlLCBrZWVwIHRoZSB3aG9sZSBob3Jpem9uIGNhcC5cbiAgICAgIGNvbnN0IGhpdHM6IFYzW10gPSBbXTtcbiAgICAgIGxldCBhbGxIaXQgPSB0cnVlO1xuICAgICAgZm9yIChjb25zdCB4IG9mIFswLCB3aWR0aCAvIDIsIHdpZHRoXSkgZm9yIChjb25zdCB5IG9mIFswLCBoZWlnaHQgLyAyLCBoZWlnaHRdKSB7XG4gICAgICAgIGNvbnN0IHJheSA9IGNhbWVyYS5nZXRQaWNrUmF5KG5ldyBDYXJ0ZXNpYW4yKHgsIHkpKTtcbiAgICAgICAgaWYgKCFyYXkpIHsgYWxsSGl0ID0gZmFsc2U7IGNvbnRpbnVlOyB9XG4gICAgICAgIGNvbnN0IGQgPSByYXkuZGlyZWN0aW9uLCBvID0gcmF5Lm9yaWdpbjtcbiAgICAgICAgY29uc3QgYiA9IG8ueCAqIGQueCArIG8ueSAqIGQueSArIG8ueiAqIGQuejtcbiAgICAgICAgY29uc3QgZGlzYyA9IGIgKiBiIC0gKG8ueCAqIG8ueCArIG8ueSAqIG8ueSArIG8ueiAqIG8ueiAtIE1PT05fUiAqIE1PT05fUik7XG4gICAgICAgIGlmIChkaXNjIDwgMCkgeyBhbGxIaXQgPSBmYWxzZTsgY29udGludWU7IH1cbiAgICAgICAgY29uc3QgdCA9IC1iIC0gTWF0aC5zcXJ0KGRpc2MpO1xuICAgICAgICBpZiAodCA8IDApIHsgYWxsSGl0ID0gZmFsc2U7IGNvbnRpbnVlOyB9XG4gICAgICAgIGhpdHMucHVzaChbKG8ueCArIGQueCAqIHQpIC8gTU9PTl9SLCAoby55ICsgZC55ICogdCkgLyBNT09OX1IsIChvLnogKyBkLnogKiB0KSAvIE1PT05fUl0pO1xuICAgICAgfVxuICAgICAgaWYgKGFsbEhpdCAmJiBoaXRzLmxlbmd0aCA9PT0gOSkge1xuICAgICAgICBjZW50cmUgPSBoaXRzWzRdOyByYWRpdXMgPSAwO1xuICAgICAgICBmb3IgKGNvbnN0IGggb2YgaGl0cykgcmFkaXVzID0gTWF0aC5tYXgocmFkaXVzLCBNYXRoLmFjb3MoY2xhbXAoZG90KGNlbnRyZSwgaCkpKSk7XG4gICAgICB9XG4gICAgICByYWRpdXMgPSBNYXRoLm1pbihNYXRoLlBJLCByYWRpdXMgKyAwLjAwOCk7IC8vIGNvdmVyIHRlcnJhaW4gdXAgdG8gdGhlIGhpZ2hlc3QgbHVuYXIgbW91bnRhaW5zXG4gICAgICAvLyBDZXNpdW0gY2hhbmdlcyBpdHMgbmVhci9mYXIgZGVwdGggbGltaXRzIHdoaWxlIHRpbGVzIGxvYWQuIE9ubHkgeCwgeSBhbmQgd1xuICAgICAgLy8gcGxhY2UgYSBsaW5lIG9uIHNjcmVlbjsgYSBkZXB0aC1vbmx5IGNoYW5nZSBtdXN0IG5ldmVyIGNsZWFyIHRoZSBkcmF3aW5nLlxuICAgICAga2V5ID0gY3JhdGVyU2NyZWVuS2V5KG1hdHJpeCk7XG4gICAgfVxuICAgIHJldHVybiB7IGZsYXQ6IGZsYXQ/LmFjdGl2ZSA/IGZsYXQgOiBudWxsLCBjZW50cmUsIHJhZGl1cywgd2lkdGgsIGhlaWdodCwgbXBwLCBleWUsIG1hdHJpeCwga2V5OiBgJHt3aWR0aH06JHtoZWlnaHR9OiR7a2V5fWAgfTtcbiAgfVxuXG4gIHByaXZhdGUgdGljayA9ICgpID0+IHtcbiAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHJldHVybjtcbiAgICBpZiAodGhpcy52aWV3ZXIuaXNEZXN0cm95ZWQoKSkgeyB0aGlzLmRlc3Ryb3koKTsgcmV0dXJuOyB9XG4gICAgY29uc3QgZmxhdCA9IHRoaXMuZmxhdCgpO1xuICAgIGNvbnN0IHZpc2libGUgPSB0aGlzLnNob3cgJiYgIWZsYXQ/LmJ1c3kgJiYgKCEhZmxhdD8uYWN0aXZlIHx8IHRoaXMudmlld2VyLnNjZW5lLmdsb2JlLnNob3cpO1xuICAgIHRoaXMuY2FudmFzLnN0eWxlLnZpc2liaWxpdHkgPSB2aXNpYmxlID8gJ3Zpc2libGUnIDogJ2hpZGRlbic7XG4gICAgaWYgKCF2aXNpYmxlKSB7XG4gICAgICB0aGlzLnRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4geyB0aGlzLnJhZiA9IHJlcXVlc3RBbmltYXRpb25GcmFtZSh0aGlzLnRpY2spOyB9LCAxNTApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2b2lkIHRoaXMuY2F0YWxvZ3VlLnN0YXJ0KCk7XG4gICAgY29uc3QgdmlldyA9IHRoaXMudmlldygpLCBub3cgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgICBjb25zdCByZXZpc2lvbiA9IHRoaXMuY2F0YWxvZ3VlLnJldmlzaW9uO1xuICAgIC8vIEEgZmluaXNoZWQgY2hvaWNlIGFza3MgZm9yIGEgbmV3IHBpY3R1cmUsIG5vdCBhbm90aGVyIGNob2ljZS4gQ29tYmluaW5nIHRob3NlXG4gICAgLy8gdHdvIGZsYWdzIGtlcHQgcmVzdGFydGluZyB3b3JrIGluIGEgYnVzeSB2aWV3IGJlZm9yZSBpdHMgcGljdHVyZSBjb3VsZCBmaW5pc2guXG4gICAgY29uc3QgY2hhbmdlZCA9IHZpZXcua2V5ICE9PSB0aGlzLmxhc3RLZXkgfHwgcmV2aXNpb24gIT09IHRoaXMubGFzdFJldmlzaW9uO1xuICAgIGlmIChjaGFuZ2VkICYmIG5vdyAtIHRoaXMubGFzdENob2ljZSA+IDE2MCkge1xuICAgICAgdGhpcy5sYXN0Q2hvaWNlID0gbm93OyB0aGlzLmxhc3RLZXkgPSB2aWV3LmtleTsgdGhpcy5sYXN0UmV2aXNpb24gPSByZXZpc2lvbjtcbiAgICAgIC8vIEEgY2hvaWNlIGlzIGNoZWFwIGFuZCBzbGljZWQ7IGNhbmNlbGxpbmcgYW4gb2xkIG9uZSBhdm9pZHMgYSBsYXRlIGZldGNoIHJlc3RvcmluZyB0aGUgcHJldmlvdXMgdmlldy5cbiAgICAgIGNvbnN0IHRva2VuID0gKyt0aGlzLnRva2VuO1xuICAgICAgdGhpcy5jaG9vc2luZyA9IHRydWU7XG4gICAgICB2b2lkIHRoaXMuY2hvb3NlKHZpZXcsIHRva2VuKS5maW5hbGx5KCgpID0+IHsgaWYgKHRva2VuID09PSB0aGlzLnRva2VuKSB0aGlzLmNob29zaW5nID0gZmFsc2U7IH0pO1xuICAgIH1cbiAgICBpZiAodmlldy5rZXkgIT09IHRoaXMuY2xlYXJlZEtleSkge1xuICAgICAgLy8gTmV2ZXIgbGVhdmUgc2NyZWVuIHBvc2l0aW9ucyBmcm9tIHRoZSBwcmV2aW91cyBjYW1lcmEgb3ZlciBhIG5ld2x5IG1vdmVkIHBob3RvLlxuICAgICAgdGhpcy5jdHguY2xlYXJSZWN0KDAsIDAsIHRoaXMuY2FudmFzLndpZHRoLCB0aGlzLmNhbnZhcy5oZWlnaHQpO1xuICAgICAgdGhpcy5wYXRocyA9IFtdOyB0aGlzLmNsZWFyZWRLZXkgPSB2aWV3LmtleTtcbiAgICB9XG4gICAgaWYgKCF0aGlzLmRyYXdpbmcgJiYgKHZpZXcua2V5ICE9PSB0aGlzLnBhdGhLZXkgfHwgdGhpcy5kaXJ0KSAmJiBub3cgLSB0aGlzLmxhc3REcmF3ID4gMzApIHtcbiAgICAgIHRoaXMubGFzdERyYXcgPSBub3c7IHRoaXMuZGlydCA9IGZhbHNlOyB0aGlzLmRyYXdpbmcgPSB0cnVlO1xuICAgICAgLy8gQSBuZXdlciBjYXRhbG9ndWUgY2hvaWNlIGRvZXMgbm90IGludmFsaWRhdGUgYW4gb3RoZXJ3aXNlIGNvcnJlY3QgcGljdHVyZS5cbiAgICAgIC8vIEZpbmlzaCBvbmUgcGljdHVyZSBiZWZvcmUgcHJlcGFyaW5nIHRoZSBuZXh0LCByYXRoZXIgdGhhbiBzdGFydmluZyBib3RoLlxuICAgICAgdm9pZCB0aGlzLmRyYXcodmlldykuZmluYWxseSgoKSA9PiB7IHRoaXMuZHJhd2luZyA9IGZhbHNlOyB9KTtcbiAgICB9XG4gICAgdGhpcy5jYW52YXMuZGF0YXNldC5yaW5ncyA9IFN0cmluZyh0aGlzLnBhdGhzLmxlbmd0aCk7XG4gICAgdGhpcy5jYW52YXMuZGF0YXNldC5sb2FkaW5nID0gU3RyaW5nKHRoaXMuY2F0YWxvZ3VlLnBlbmRpbmcuc2l6ZSArIE51bWJlcih0aGlzLmNob29zaW5nKSArIE51bWJlcih0aGlzLmRyYXdpbmcpKTtcbiAgICB0aGlzLmNhbnZhcy5kYXRhc2V0LmRyYXdpbmcgPSBTdHJpbmcodGhpcy5kcmF3aW5nKTtcbiAgICB0aGlzLmNhbnZhcy5kYXRhc2V0LmNodW5rcyA9IFN0cmluZyh0aGlzLmNhdGFsb2d1ZS5jYWNoZS5zaXplKTtcbiAgICB0aGlzLnJhZiA9IHJlcXVlc3RBbmltYXRpb25GcmFtZSh0aGlzLnRpY2spO1xuICB9O1xuXG4gIHByaXZhdGUgYXN5bmMgY2hvb3NlKHZpZXc6IFZpZXcsIHRva2VuOiBudW1iZXIpIHtcbiAgICBjb25zdCBtaW5LbSA9IE1hdGgubWF4KDAuMDMsIE1JTl9QSVhFTFMgKiB2aWV3Lm1wcCAvIDEwMDApO1xuICAgIGNvbnN0IGFycmF5cyA9IHRoaXMuY2F0YWxvZ3VlLmZvclZpZXcodmlldywgbWluS20pO1xuICAgIGNvbnN0IHJlY29yZHM6IFJlY29yZFtdID0gW107XG4gICAgbGV0IHNsaWNlID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgZm9yIChjb25zdCBhIG9mIGFycmF5cykgZm9yIChsZXQgaSA9IDA7IGkgPCBhLmxlbmd0aDsgaSArPSAzKSB7XG4gICAgICBpZiAoaSAlIDc2OCA9PT0gMCAmJiBwZXJmb3JtYW5jZS5ub3coKSAtIHNsaWNlID4gNCkge1xuICAgICAgICBhd2FpdCBwYXVzZSgpOyBpZiAodG9rZW4gIT09IHRoaXMudG9rZW4gfHwgdGhpcy5kZXN0cm95ZWQgfHwgdGhpcy52aWV3ZXIuaXNEZXN0cm95ZWQoKSkgcmV0dXJuOyBzbGljZSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgICAgfVxuICAgICAgY29uc3Qga20gPSBhW2kgKyAyXTtcbiAgICAgIGlmIChrbSA8IG1pbkttKSBicmVhazsgLy8gZXZlcnkgaW5wdXQgaXMgbGFyZ2VzdCBmaXJzdFxuICAgICAgY29uc3QgbGF0ID0gYVtpXSwgbG9uID0gYVtpICsgMV07XG4gICAgICBjb25zdCBjZW50cmUgPSB0cnVlVG9EaXNwbGF5VmVjKHRydWVVbml0KGxhdCwgbG9uKSksIHJobyA9IGttIC8gKDIgKiBSX0tNKTtcbiAgICAgIGNvbnN0IGQgPSBkb3QoY2VudHJlLCB2aWV3LmNlbnRyZSk7XG4gICAgICBpZiAodmlldy5yYWRpdXMgKyByaG8gPCBNYXRoLlBJICYmIGQgPCBNYXRoLmNvcyh2aWV3LnJhZGl1cyArIHJobykpIGNvbnRpbnVlO1xuICAgICAgaWYgKHJobyA+IHZpZXcucmFkaXVzICYmIGQgPiBNYXRoLmNvcyhyaG8gLSB2aWV3LnJhZGl1cykpIGNvbnRpbnVlO1xuICAgICAgcmVjb3Jkcy5wdXNoKHsgbGF0LCBsb24sIGttLCBjaXJjbGU6IGNyYXRlckNpcmNsZShsYXQsIGxvbiwga20pIH0pO1xuICAgICAgaWYgKHBlcmZvcm1hbmNlLm5vdygpIC0gc2xpY2UgPiA0KSB7XG4gICAgICAgIGF3YWl0IHBhdXNlKCk7IGlmICh0b2tlbiAhPT0gdGhpcy50b2tlbiB8fCB0aGlzLmRlc3Ryb3llZCB8fCB0aGlzLnZpZXdlci5pc0Rlc3Ryb3llZCgpKSByZXR1cm47IHNsaWNlID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICB9XG4gICAgfVxuICAgIHJlY29yZHMuc29ydCgoYSwgYikgPT4gYi5rbSAtIGEua20pO1xuICAgIGlmICh0b2tlbiAhPT0gdGhpcy50b2tlbiB8fCB0aGlzLmRlc3Ryb3llZCB8fCB0aGlzLnZpZXdlci5pc0Rlc3Ryb3llZCgpKSByZXR1cm47XG4gICAgdGhpcy5jaG9zZW4gPSByZWNvcmRzO1xuICAgIHRoaXMuZGlydCA9IHRydWU7XG4gIH1cblxuICBwcml2YXRlIHNjcmVlbih1bml0OiBWMywgdmlldzogVmlldyk6IFNjcmVlblBvaW50IHtcbiAgICBpZiAodmlldy5mbGF0KSB7XG4gICAgICBjb25zdCBwID0gdmlldy5mbGF0LnRvU2NyZWVuKE1hdGguYXNpbihjbGFtcCgtdW5pdFsxXSkpIC8gREVHLCBNYXRoLmF0YW4yKHVuaXRbMl0sIHVuaXRbMF0pIC8gREVHKTtcbiAgICAgIHJldHVybiB7IC4uLnAsIHZpc2libGU6IHRydWUgfTtcbiAgICB9XG4gICAgY29uc3QgbGF0ID0gTWF0aC5hc2luKGNsYW1wKC11bml0WzFdKSkgLyBERUcsIGxvbiA9IE1hdGguYXRhbjIodW5pdFsyXSwgdW5pdFswXSkgLyBERUc7XG4gICAgY29uc3QgciA9IE1PT05fUiArIHRoaXMuaGVpZ2h0QXQobGF0LCBsb24pO1xuICAgIGNvbnN0IHggPSB1bml0WzBdICogciwgeSA9IHVuaXRbMV0gKiByLCB6ID0gdW5pdFsyXSAqIHIsIG0gPSB2aWV3Lm1hdHJpeDtcbiAgICBjb25zdCB3ID0gbVszXSAqIHggKyBtWzddICogeSArIG1bMTFdICogeiArIG1bMTVdO1xuICAgIHJldHVybiB7IHg6ICgxICsgKG1bMF0gKiB4ICsgbVs0XSAqIHkgKyBtWzhdICogeiArIG1bMTJdKSAvIHcpICogdmlldy53aWR0aCAvIDIsXG4gICAgICB5OiAoMSAtIChtWzFdICogeCArIG1bNV0gKiB5ICsgbVs5XSAqIHogKyBtWzEzXSkgLyB3KSAqIHZpZXcuaGVpZ2h0IC8gMixcbiAgICAgIHZpc2libGU6IHcgPiAwICYmIGRvdCh1bml0LCB2aWV3LmV5ZSkgPiBNT09OX1IgLSAxMjAwMCB9O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBkcmF3KHZpZXc6IFZpZXcpIHtcbiAgICBjb25zdCBwYXRoczogRHJhd25bXSA9IFtdO1xuICAgIGxldCBzbGljZSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgIGZvciAoY29uc3QgcmVjb3JkIG9mIHRoaXMuY2hvc2VuKSB7XG4gICAgICBpZiAocGF0aHMubGVuZ3RoID09PSBNQVhfUklOR1MpIGJyZWFrO1xuICAgICAgY29uc3QgYyA9IHJlY29yZC5jaXJjbGU7XG4gICAgICBjb25zdCBkaXN0YW5jZSA9IE1hdGguaHlwb3Qodmlldy5leWVbMF0gLSBjLmNlbnRyZVswXSAqIE1PT05fUiwgdmlldy5leWVbMV0gLSBjLmNlbnRyZVsxXSAqIE1PT05fUiwgdmlldy5leWVbMl0gLSBjLmNlbnRyZVsyXSAqIE1PT05fUik7XG4gICAgICBjb25zdCBhbHRpdHVkZSA9IE1hdGgubWF4KDEwMCwgTWF0aC5oeXBvdCguLi52aWV3LmV5ZSkgLSBNT09OX1IpO1xuICAgICAgY29uc3QgZGlhbWV0ZXJQeCA9IHJlY29yZC5rbSAqIDEwMDAgLyB2aWV3Lm1wcCAqICh2aWV3LmZsYXQgPyAxIDogYWx0aXR1ZGUgLyBkaXN0YW5jZSk7XG4gICAgICBpZiAoIXZpZXcuZmxhdCAmJiBkaWFtZXRlclB4IDwgTUlOX1BJWEVMUykgY29udGludWU7XG4gICAgICBjb25zdCBzdGVwcyA9IE1hdGgubWF4KDI0LCBNYXRoLm1pbigyMDQ4LCBNYXRoLmNlaWwoTWF0aC5QSSAqIE1hdGguc3FydChNYXRoLm1heCgxLCBkaWFtZXRlclB4KSAvIDAuNSkpKSk7XG4gICAgICBjb25zdCBwYXRoID0gbmV3IFBhdGgyRCgpO1xuICAgICAgbGV0IHByZXZpb3VzOiBTY3JlZW5Qb2ludCB8IG51bGwgPSBudWxsLCBjcm9zc2VzID0gZmFsc2U7XG4gICAgICBjb25zdCBhZGQgPSAoYTogU2NyZWVuUG9pbnQsIGI6IFNjcmVlblBvaW50KSA9PiB7XG4gICAgICAgIC8vIFNwbGl0dGluZyBhdCB0aGUgbWFwIHNlYW0gbmV2ZXIgZHJhd3MgYSBzdHJhaWdodCBjaG9yZCB0aHJvdWdoIHRoZSB3aG9sZSBmbGF0IG1hcC5cbiAgICAgICAgaWYgKCEoYS52aXNpYmxlICYmIGIudmlzaWJsZSkgfHwgKHZpZXcuZmxhdCAmJiBNYXRoLmFicyhhLnggLSBiLngpID4gMTgwICogdmlldy5mbGF0LnZpZXcucykpIHJldHVybjtcbiAgICAgICAgaWYgKE1hdGgubWF4KGEueCwgYi54KSA8IC0yIHx8IE1hdGgubWluKGEueCwgYi54KSA+IHZpZXcud2lkdGggKyAyIHx8IE1hdGgubWF4KGEueSwgYi55KSA8IC0yIHx8IE1hdGgubWluKGEueSwgYi55KSA+IHZpZXcuaGVpZ2h0ICsgMikgcmV0dXJuO1xuICAgICAgICBwYXRoLm1vdmVUbyhhLngsIGEueSk7IHBhdGgubGluZVRvKGIueCwgYi55KTsgY3Jvc3NlcyA9IHRydWU7XG4gICAgICB9O1xuICAgICAgLy8gUmVmaW5lIGluIHNjcmVlbiBzcGFjZSB0b286IHRoZSBmbGF0IG1hcCBzdHJldGNoZXMgY2lyY2xlcyBzdHJvbmdseSBuZWFyIGVpdGhlciB0cnVlIHBvbGUuXG4gICAgICBjb25zdCBzZWdtZW50ID0gKGE6IG51bWJlciwgcGE6IFNjcmVlblBvaW50LCBiOiBudW1iZXIsIHBiOiBTY3JlZW5Qb2ludCwgZGVwdGg6IG51bWJlcikgPT4ge1xuICAgICAgICBjb25zdCBtaWQgPSAoYSArIGIpIC8gMiwgcG0gPSB0aGlzLnNjcmVlbihwb2ludE9uQ3JhdGVyKGMsIG1pZCksIHZpZXcpO1xuICAgICAgICBjb25zdCBlcnIgPSBNYXRoLmh5cG90KHBtLnggLSAocGEueCArIHBiLngpIC8gMiwgcG0ueSAtIChwYS55ICsgcGIueSkgLyAyKTtcbiAgICAgICAgaWYgKGRlcHRoIDwgOSAmJiAoZXJyID4gMC4zIHx8IHBhLnZpc2libGUgIT09IHBiLnZpc2libGUpICYmXG4gICAgICAgICAgKHBhLnZpc2libGUgfHwgcGIudmlzaWJsZSB8fCBwbS52aXNpYmxlKSkge1xuICAgICAgICAgIHNlZ21lbnQoYSwgcGEsIG1pZCwgcG0sIGRlcHRoICsgMSk7IHNlZ21lbnQobWlkLCBwbSwgYiwgcGIsIGRlcHRoICsgMSk7XG4gICAgICAgIH0gZWxzZSBhZGQocGEsIHBiKTtcbiAgICAgIH07XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8PSBzdGVwczsgaSsrKSB7XG4gICAgICAgIGNvbnN0IGEgPSBpIC8gc3RlcHMgKiBNYXRoLlBJICogMiwgcCA9IHRoaXMuc2NyZWVuKHBvaW50T25DcmF0ZXIoYywgYSksIHZpZXcpO1xuICAgICAgICBpZiAocHJldmlvdXMpIHNlZ21lbnQoKGkgLSAxKSAvIHN0ZXBzICogTWF0aC5QSSAqIDIsIHByZXZpb3VzLCBhLCBwLCAwKTtcbiAgICAgICAgcHJldmlvdXMgPSBwO1xuICAgICAgICBpZiAoaSAlIDMyID09PSAwICYmIHBlcmZvcm1hbmNlLm5vdygpIC0gc2xpY2UgPiA0KSB7XG4gICAgICAgICAgYXdhaXQgcGF1c2UoKTtcbiAgICAgICAgICBpZiAodGhpcy5kZXN0cm95ZWQgfHwgdGhpcy52aWV3ZXIuaXNEZXN0cm95ZWQoKSB8fCB2aWV3LmtleSAhPT0gdGhpcy52aWV3KCkua2V5KSByZXR1cm47XG4gICAgICAgICAgc2xpY2UgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGNyb3NzZXMpIHBhdGhzLnB1c2goeyByZWNvcmQsIHBhdGggfSk7XG4gICAgICBpZiAocGVyZm9ybWFuY2Uubm93KCkgLSBzbGljZSA+IDQpIHtcbiAgICAgICAgYXdhaXQgcGF1c2UoKTtcbiAgICAgICAgaWYgKHRoaXMuZGVzdHJveWVkIHx8IHRoaXMudmlld2VyLmlzRGVzdHJveWVkKCkgfHwgdmlldy5rZXkgIT09IHRoaXMudmlldygpLmtleSkgcmV0dXJuO1xuICAgICAgICBzbGljZSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAodGhpcy5kZXN0cm95ZWQgfHwgdGhpcy52aWV3ZXIuaXNEZXN0cm95ZWQoKSB8fCB2aWV3LmtleSAhPT0gdGhpcy52aWV3KCkua2V5KSByZXR1cm47XG4gICAgY29uc3QgZHByID0gTWF0aC5taW4oMiwgd2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMSk7XG4gICAgaWYgKHRoaXMuY2FudmFzLndpZHRoICE9PSBNYXRoLnJvdW5kKHZpZXcud2lkdGggKiBkcHIpIHx8IHRoaXMuY2FudmFzLmhlaWdodCAhPT0gTWF0aC5yb3VuZCh2aWV3LmhlaWdodCAqIGRwcikpIHtcbiAgICAgIHRoaXMuY2FudmFzLndpZHRoID0gTWF0aC5yb3VuZCh2aWV3LndpZHRoICogZHByKTsgdGhpcy5jYW52YXMuaGVpZ2h0ID0gTWF0aC5yb3VuZCh2aWV3LmhlaWdodCAqIGRwcik7XG4gICAgfVxuICAgIGNvbnN0IGcgPSB0aGlzLmN0eDtcbiAgICBnLnNldFRyYW5zZm9ybShkcHIsIDAsIDAsIGRwciwgMCwgMCk7IGcuY2xlYXJSZWN0KDAsIDAsIHZpZXcud2lkdGgsIHZpZXcuaGVpZ2h0KTtcbiAgICBnLnN0cm9rZVN0eWxlID0gJ3JnYmEoMjM1LCAyNDEsIDI0NywgMC43KSc7IGcubGluZVdpZHRoID0gMS4yNTsgZy5saW5lQ2FwID0gJ3JvdW5kJzsgZy5saW5lSm9pbiA9ICdyb3VuZCc7XG4gICAgZm9yIChjb25zdCBwIG9mIHBhdGhzKSBnLnN0cm9rZShwLnBhdGgpO1xuICAgIHRoaXMucGF0aHMgPSBwYXRocztcbiAgICB0aGlzLnBhdGhLZXkgPSB2aWV3LmtleTtcbiAgICB0aGlzLmNhbnZhcy5kYXRhc2V0Lm1pbkttID0gU3RyaW5nKE1hdGgubWluKC4uLnBhdGhzLm1hcChwID0+IHAucmVjb3JkLmttKSkpO1xuICB9XG59XG5cbmNvbnN0IGxheWVycyA9IG5ldyBXZWFrTWFwPFZpZXdlciwgQ3JhdGVyTGF5ZXI+KCk7XG4vKiogQ3JlYXRlcyBvbmNlLCB0aGVuIHN3aXRjaGVzIHRoZSBzYW1lIHZlY3RvciBsYXllciBvbiBib3RoIG1hcHMuIE5vIGltYWdlcnkgdGV4dHVyZSBzbG90IGlzIHVzZWQuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlQ3JhdGVyTGF5ZXIodmlld2VyOiBWaWV3ZXIsIGZsYXQ6ICgpID0+IEZsYXRNYXAgfCBudWxsLCBoZWlnaHRBdDogKGxhdDogbnVtYmVyLCBsb246IG51bWJlcikgPT4gbnVtYmVyKTogQ3JhdGVyTGF5ZXIge1xuICBsZXQgbGF5ZXIgPSBsYXllcnMuZ2V0KHZpZXdlcik7XG4gIGlmICghbGF5ZXIpIHsgbGF5ZXIgPSBuZXcgQ3JhdGVyTGF5ZXIodmlld2VyLCBmbGF0LCBoZWlnaHRBdCk7IGxheWVycy5zZXQodmlld2VyLCBsYXllcik7IH1cbiAgcmV0dXJuIGxheWVyO1xufVxuIl19