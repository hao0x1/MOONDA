import { settings } from "/src/app/settings.ts";
import { prefetchMusic } from "/src/audio/music.ts";
import { t } from "/src/i18n/index.ts?t=1794657753993";
import { analyseSpotAsync } from "/src/science/client.ts?t=1794645275498";
import { loadManifest } from "/src/science/layerValues.ts?t=1794657825225";
export const STAGES = [
	"app",
	"photo",
	"mountains",
	"sky",
	"layers",
	"science",
	"pole",
	"surface",
	"music"
];
/** Share of the overall percentage, roughly by how long each stage takes on a first visit. */
const WEIGHT = {
	app: 0,
	photo: 12,
	mountains: 30,
	sky: 10,
	layers: 12,
	science: 8,
	pole: 18,
	surface: 17,
	music: 5
};
/** The app's code is in by the time anything here runs: that row starts out done, with the time the page took to get it. */
const appStage = () => ({
	id: "app",
	state: "done",
	frac: null,
	ms: Math.round(performance.now())
});
const freshStage = (id) => id === "app" ? appStage() : {
	id,
	state: "waiting",
	frac: null
};
/** The state before anything has started (the start screen draws this on its first frame). */
export function initialProgress() {
	return {
		pct: 0,
		step: t("start.step.start"),
		done: false,
		stages: STAGES.map(freshStage)
	};
}
/** The south-pole views see far over the horizon, where the photos come from NASA's server (slow from far away):
*  give each view this many times its own time limit before calling it "finishes in the background". */
const POLE_TIME = 2.5;
/** Which kinds of photo jobs are still waiting (for the trace), e.g. "trek×12 synth×4". */
function waitingKinds() {
	const w = globalThis.__moondaImagery?.waiting() ?? [];
	const n = new Map();
	for (const x of w) n.set(x.kind, (n.get(x.kind) ?? 0) + 1);
	return [...n].map(([k, c]) => `${k}×${c}`).join(" ");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** true when `p` settled in time (resolved or failed), false when the time ran out */
function withTimeout(p, ms, cancelled) {
	return new Promise((resolve) => {
		let over = false;
		const end = (ok) => {
			if (!over) {
				over = true;
				clearTimeout(timer);
				clearInterval(poll);
				resolve(ok);
			}
		};
		const timer = setTimeout(() => end(false), ms);
		const poll = setInterval(() => {
			if (cancelled?.()) end(false);
		}, 100);
		p.then(() => end(true), () => end(true));
	});
}
/** Render frames until the globe has nothing left to load for a few frames in a row, or time runs out.
*  `onFrac` hears how much of the photo work is done (from the most tile jobs seen waiting at once). */
export async function waitUntilLoaded(viewer, maxMs, pending, cancelled, onFrac) {
	const t0 = performance.now();
	let quiet = 0, peak = 1;
	while (performance.now() - t0 < maxMs) {
		if (viewer.isDestroyed() || cancelled?.()) return false;
		viewer.scene.requestRender();
		// setTimeout as well as requestAnimationFrame: a tab in the background gets very few animation frames
		await Promise.race([new Promise((r) => requestAnimationFrame(() => r())), sleep(50)]);
		if (viewer.isDestroyed()) return false;
		const n = pending ? pending() : 0;
		peak = Math.max(peak, n);
		const done = viewer.scene.globe.tilesLoaded && n === 0;
		onFrac?.(done ? 1 : Math.min(.95, 1 - n / peak));
		quiet = done ? quiet + 1 : 0;
		if (quiet >= 4 && performance.now() - t0 > 250) return true;
	}
	return false;
}
const setPose = (viewer, p) => {
	viewer.camera.setView({
		destination: p.destination,
		orientation: {
			direction: p.direction,
			up: p.up
		}
	});
	viewer.scene.requestRender();
};
/** Until lander.prewarm() exists: fetch the files the Stand-here view asks for, so they come from the browser cache. */
async function fetchSurfaceFiles(onFrac, cancelled) {
	const base = new URL("./lander/", document.baseURI);
	const files = [
		"regolith_a.webp",
		"regolith_b.webp",
		"regolith_c.webp"
	].map((f) => new URL(f, base).href);
	// the rock models: each glTF names its own mesh and picture files
	const rocks = Array.from({ length: 7 }, (_, i) => new URL(`rocks/moon_rock_0${i + 1}/rock.gltf`, base));
	const listed = await Promise.all(rocks.map((u) => fetch(u).then((r) => r.ok ? r.json() : null).then((g) => [...g?.buffers ?? [], ...g?.images ?? []].map((x) => x.uri).filter((x) => !!x && !x.startsWith("data:")).map((x) => new URL(x, u).href)).catch(() => [])));
	files.push(...listed.flat());
	let done = 0;
	// a few at a time: the network stays free for anything else the start-up still needs
	const queue = [...files];
	const lane = async () => {
		for (let f = queue.shift(); f && !cancelled(); f = queue.shift()) {
			await fetch(f).then((r) => r.arrayBuffer()).catch(() => null);
			onFrac(++done / files.length);
		}
	};
	await Promise.all([
		lane(),
		lane(),
		lane()
	]);
}
/** Download files into the browser cache, a couple at a time, reporting how many are in. True when all arrived. */
async function fetchFiles(files, onFrac, cancelled, lanes = 2) {
	let done = 0, ok = true;
	const queue = [...files];
	const lane = async () => {
		for (let f = queue.shift(); f && !cancelled(); f = queue.shift()) {
			const good = await fetch(f).then((r) => r.arrayBuffer().then(() => r.ok)).catch(() => false);
			ok = ok && good;
			onFrac(++done / files.length);
		}
	};
	await Promise.all(Array.from({ length: lanes }, lane));
	return ok && done === files.length;
}
export async function runPreload(viewer, d) {
	const stop = () => viewer.isDestroyed() || !!d.cancelled?.();
	const cancelled = () => !!d.cancelled?.();
	// what happened, for tests and for "why did it take so long" (window.__moonda.preloadTrace)
	const trace = [];
	const hook = window.__moonda;
	if (hook) hook.preloadTrace = trace;
	const stages = new Map(STAGES.map((id) => [id, freshStage(id)]));
	const began = new Map();
	let finished = false, lastPct = -1, lastSent = "";
	const send = () => {
		if (finished || viewer.isDestroyed()) return;
		const list = STAGES.map((id) => ({ ...stages.get(id) }));
		let got = 0, all = 0;
		for (const s of list) {
			all += WEIGHT[s.id];
			got += WEIGHT[s.id] * (s.state === "done" || s.state === "later" || s.state === "off" ? 1 : s.state === "loading" ? s.frac ?? 0 : 0);
		}
		const pct = Math.min(99, Math.floor(100 * got / all));
		const current = list.find((s) => s.state === "loading");
		const key = list.map((s) => s.state).join() + pct;
		if (key === lastSent && pct === lastPct) return;
		lastSent = key;
		lastPct = pct;
		d.onProgress({
			pct,
			step: current ? t(`start.stage.${current.id}`) : t("start.step.start"),
			done: false,
			stages: list
		});
	};
	const mark = (id, state, frac = null) => {
		const s = stages.get(id);
		if (state === "loading" && !began.has(id)) began.set(id, performance.now());
		if (state !== "loading" && state !== "waiting" && began.has(id)) s.ms = Math.round(performance.now() - began.get(id));
		s.state = state;
		s.frac = frac;
		send();
	};
	const frac = (id) => (f) => {
		const s = stages.get(id);
		if (s.state !== "loading" || s.frac !== null && Math.abs(f - s.frac) < .02 && f < 1) return;
		s.frac = f;
		send();
	};
	/** run one stage: loading → done when `job` says it finished in time, otherwise "later" */
	const stage = async (id, job) => {
		mark(id, "loading");
		let ok = false;
		try {
			ok = await job() !== false;
		} catch {
			ok = false;
		}
		if (!viewer.isDestroyed()) mark(id, ok && !cancelled() ? "done" : "later");
	};
	// music: only when it is switched on; switching it on during start-up fetches it then
	let musicJob = null;
	const music = () => {
		if (!settings.get().sound) {
			if (stages.get("music").state === "waiting") mark("music", "off");
			return;
		}
		if (musicJob) return;
		musicJob = stage("music", () => withTimeout(prefetchMusic(), 2e4, cancelled).then((ok) => ok));
	};
	const offSound = settings.subscribe((s, prev) => {
		if (s.sound && !prev.sound) music();
	});
	try {
		send();
		music();
		const manifest = withTimeout(loadManifest(), 8e3, cancelled);
		const sky = d.skyReady ? stage("sky", () => withTimeout(d.skyReady, 3e4, cancelled)) : Promise.resolve(mark("sky", "done"));
		// the height maps download from the very start, while the opening view's photo loads
		let heightsOk = false;
		let photoDone = () => {};
		const photoFinished = new Promise((r) => {
			photoDone = r;
		});
		const mountains = stage("mountains", async () => {
			heightsOk = await withTimeout(d.heightsReady, 9e4, cancelled);
			await photoFinished;
			if (stop()) return false;
			await sleep(60);
			setPose(viewer, d.startView);
			// then the 3D ground at the opening view
			return heightsOk && await waitUntilLoaded(viewer, 15e3, d.imageryPending, d.cancelled);
		});
		// the opening view's photo, on the smooth ball (the 3D ground replaces it once the heights are in)
		setPose(viewer, d.startView);
		await stage("photo", async () => {
			const ok = await waitUntilLoaded(viewer, 2e4, d.imageryPending, d.cancelled, frac("photo"));
			await manifest;
			await withTimeout(d.namesReady, 6e3, cancelled);
			return ok;
		}).finally(photoDone);
		await mountains;
		if (stop()) return;
		// the calculator and the Stand-here view work in the background (worker thread, network) while
		// the camera visits the south-pole views
		const science = stage("science", () => {
			if (!heightsOk) return Promise.resolve(false);
			// one real calculation at the first south-pole spot people try: the worker has the heights, its
			// 80 m tiles there are loaded and its code is warmed up
			const hour = 36e5;
			return withTimeout(analyseSpotAsync({
				lat: -89.45,
				lon: -136.7,
				mastM: 2,
				startMs: Math.floor(Date.now() / hour) * hour,
				days: 14
			}, 4e4), 4e4, cancelled);
		});
		// Decode local science maps while remote height tiles download, so a slow server cannot
		// hold up the maps that are already stored with the app.
		const layers = d.layerFiles || d.warmLayers ? stage("layers", async () => withTimeout((async () => {
			let fetched = d.layerFiles ? 0 : 1, warmed = d.warmLayers ? 0 : 1;
			const report = () => frac("layers")(d.layerFiles && d.warmLayers ? fetched * .45 + warmed * .55 : d.layerFiles ? fetched : warmed);
			const fetchJob = d.layerFiles ? d.layerFiles().then((files) => fetchFiles(files, (f) => {
				fetched = f;
				report();
			}, cancelled)) : Promise.resolve();
			const warmJob = d.warmLayers && !stop() ? d.warmLayers((f) => {
				warmed = f;
				report();
			}) : Promise.resolve();
			await Promise.all([fetchJob, warmJob]);
		})(), 9e4, cancelled)) : Promise.resolve(mark("layers", "off"));
		const surface = stage("surface", async () => {
			const prewarm = d.lander?.prewarm;
			if (typeof prewarm === "function") return withTimeout(prewarm.call(d.lander), 6e4, cancelled);
			return withTimeout(fetchSurfaceFiles(frac("surface"), cancelled), 6e4, cancelled);
		});
		await stage("pole", async () => {
			const views = d.warmViews();
			let ok = true;
			for (let i = 0; i < views.length; i++) {
				if (stop()) return false;
				setPose(viewer, views[i].pose);
				const t1 = performance.now();
				const got = await waitUntilLoaded(viewer, views[i].maxMs * POLE_TIME, d.imageryPending, d.cancelled, (f) => frac("pole")((i + f) / views.length));
				trace.push(`${views[i].label}: ${got ? "sharp" : "timed out"} after ${Math.round(performance.now() - t1)} ms, ${d.imageryPending?.() ?? 0} photo jobs left ${waitingKinds()}`);
				ok = got && ok;
			}
			return ok;
		});
		await Promise.all([
			science,
			surface,
			sky,
			layers
		]);
		if (stop()) return;
		// back to the opening view, at the graphics mode chosen now (it may have changed while loading)
		setPose(viewer, d.startView);
		await waitUntilLoaded(viewer, 6e3, d.imageryPending, d.cancelled);
		if (musicJob) await musicJob;
	} finally {
		offSound();
		// A destroyed viewer (React remount in development) must stay silent: the new viewer reports for itself.
		if (!viewer.isDestroyed()) {
			setPose(viewer, d.startView);
			for (const s of stages.values()) if (s.state === "waiting" || s.state === "loading") s.state = "later";
			finished = true;
			d.onProgress({
				pct: 100,
				step: t("start.step.ready"),
				done: true,
				stages: STAGES.map((id) => ({ ...stages.get(id) }))
			});
		}
	}
}

//# sourceMappingURL=data:application/json;base64,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RSxFQUFHLEVBQUU7R0FBRSxDQUFDO0VBQ3hIO0NBQ0Y7QUFDRiIsIm5hbWVzIjpbXSwic291cmNlcyI6WyJwcmVsb2FkLnRzIl0sInZlcnNpb24iOjMsInNvdXJjZXNDb250ZW50IjpbIi8vIFN0YXJ0LXVwIGxvYWRlci4gV2hpbGUgdGhlIHN0YXJ0IHNjcmVlbiBpcyB1cCB3ZSBnZXQgRVZFUllUSElORyByZWFkeSB0aGF0IHRoZSBmaXJzdCBtaW51dGVzIG5lZWQsXG4vLyBzbyBub3RoaW5nIGxvYWRzIGhhbGZ3YXkgb25jZSB0aGUgcGVyc29uIGlzIGluOlxuLy8gICBwaG90byAgICAgIHRoZSBNb29uJ3MgcGhvdG8gdGlsZXMgZm9yIHRoZSBvcGVuaW5nIHZpZXcgKHNoYXJwLCBub3RoaW5nIGxlZnQgdG8gZmV0Y2gpICsgdGhlIGxheWVyIGxlZ2VuZHNcbi8vICAgbW91bnRhaW5zICB0aGUgaGVpZ2h0IG1hcHMgKDQ2IE1CKSBhbmQgdGhlIDNEIGdyb3VuZCBidWlsdCBmcm9tIHRoZW0gYXQgdGhlIG9wZW5pbmcgdmlld1xuLy8gICBza3kgICAgICAgIHN0YXJzLCBNaWxreSBXYXksIEVhcnRoIGFuZCBTdW4gcGljdHVyZXMgZm9yIHRoZSBjaG9zZW4gZ3JhcGhpY3MgbW9kZVxuLy8gICBzY2llbmNlICAgIHRoZSBsYW5kaW5nLXNpdGUgY2FsY3VsYXRvciAoYmFja2dyb3VuZCB3b3JrZXIpIGhhcyB0aGUgaGVpZ2h0cyBhbmQgaGFzIGRvbmUgb25lIHJlYWwgY2FsY3VsYXRpb25cbi8vICAgcG9sZSAgICAgICBhIHF1aWNrLCBpbnZpc2libGUgdmlzaXQgdG8gdGhlIHNvdXRoLXBvbGUgdmlld3MgcGVvcGxlIGdvIHRvIGZpcnN0ICh0aWxlcywgM0QgZ3JvdW5kLCBzaGFkZXJzKVxuLy8gICBzdXJmYWNlICAgIHRoZSBcIlN0YW5kIGhlcmVcIiB2aWV3OiBpdHMgZ3JvdW5kIHNjYW5zLCByb2NrIG1vZGVscyBhbmQgc2hhZGVycyAobGFuZGVyLnByZXdhcm0oKSB3aGVuIHByZXNlbnQpXG4vLyAgIGxheWVycyAgICAgdGhlIGZpbGVzIGJlaGluZCB0aGUgTGF5ZXJzIHN3aXRjaGVzIChzb3V0aC1wb2xlIHNjaWVuY2UgbWFwcywgSGVpZ2h0IGNvbG91cnMpLCBzbyB0aGV5IHNob3cgYXQgb25jZVxuLy8gICBtdXNpYyAgICAgIHRoZSBtdXNpYyBmaWxlLCBzbyBpdCBjYW4gc3RhcnQgdGhlIG1vbWVudCB0aGUgcGVyc29uIGVudGVyc1xuLy8gKGFuZCBcImFwcFwiOiB0aGUgYXBwJ3Mgb3duIGNvZGUsIGRvd25sb2FkZWQgYnkgdGhlIHBhZ2UgYmVmb3JlIGFueSBvZiB0aGlzIHN0YXJ0czsgaW5kZXguaHRtbCBzaG93cyBpdCBsb2FkaW5nKVxuLy8gRWFjaCBzdGFnZSByZXBvcnRzIGl0cyByZWFsIHN0YXRlICh3YWl0aW5nIC8gbG9hZGluZyB3aXRoIGEgZnJhY3Rpb24gd2hlbiB3ZSBjYW4gY291bnQgaXQgLyBkb25lKS5cbi8vIEV2ZXJ5IHN0YWdlIGhhcyBhIHRpbWUgbGltaXQsIHNvIGEgc2xvdyBuZXR3b3JrIGRlbGF5cyB0aGUgc3RhcnQgYnV0IG5ldmVyIGJsb2NrcyBpdDogYSBzdGFnZSB0aGF0IHJ1bnNcbi8vIG91dCBvZiB0aW1lIGlzIHNob3duIGFzIFwiZmluaXNoZXMgaW4gdGhlIGJhY2tncm91bmRcIiBhbmQga2VlcHMgbG9hZGluZyBhZnRlciB0aGUgcGVyc29uIGVudGVycy5cblxuaW1wb3J0IHR5cGUgeyBWaWV3ZXIgfSBmcm9tICdjZXNpdW0nO1xuaW1wb3J0IHR5cGUgeyBDYW1lcmFQb3NlIH0gZnJvbSAnLi9uYXZpZ2F0aW9uJztcbmltcG9ydCB7IHNldHRpbmdzIH0gZnJvbSAnLi4vYXBwL3NldHRpbmdzJztcbmltcG9ydCB7IHByZWZldGNoTXVzaWMgfSBmcm9tICcuLi9hdWRpby9tdXNpYyc7XG5pbXBvcnQgeyB0IH0gZnJvbSAnLi4vaTE4bic7XG5pbXBvcnQgeyBhbmFseXNlU3BvdEFzeW5jIH0gZnJvbSAnLi4vc2NpZW5jZS9jbGllbnQnO1xuaW1wb3J0IHsgbG9hZE1hbmlmZXN0IH0gZnJvbSAnLi4vc2NpZW5jZS9sYXllclZhbHVlcyc7XG5cbmV4cG9ydCB0eXBlIFN0YWdlSWQgPSAnYXBwJyB8ICdwaG90bycgfCAnbW91bnRhaW5zJyB8ICdza3knIHwgJ2xheWVycycgfCAnc2NpZW5jZScgfCAncG9sZScgfCAnc3VyZmFjZScgfCAnbXVzaWMnO1xuLyoqIGxhdGVyID0gcmFuIG91dCBvZiB0aW1lLCBrZWVwcyBsb2FkaW5nIGluIHRoZSBiYWNrZ3JvdW5kOyBvZmYgPSBub3QgbmVlZGVkIChtdXNpYyBzd2l0Y2hlZCBvZmYpICovXG5leHBvcnQgdHlwZSBTdGFnZVN0YXRlID0gJ3dhaXRpbmcnIHwgJ2xvYWRpbmcnIHwgJ2RvbmUnIHwgJ2xhdGVyJyB8ICdvZmYnO1xuZXhwb3J0IGludGVyZmFjZSBTdGFnZSB7IGlkOiBTdGFnZUlkOyBzdGF0ZTogU3RhZ2VTdGF0ZTsgLyoqIDDigKYxIHdoaWxlIGxvYWRpbmcsIHdoZW4gaXQgY2FuIGJlIGNvdW50ZWQgKi8gZnJhYzogbnVtYmVyIHwgbnVsbDsgLyoqIGhvdyBsb25nIGl0IHRvb2sgKi8gbXM/OiBudW1iZXIgfVxuZXhwb3J0IGludGVyZmFjZSBMb2FkUHJvZ3Jlc3MgeyBwY3Q6IG51bWJlcjsgc3RlcDogc3RyaW5nOyBkb25lOiBib29sZWFuOyBzdGFnZXM6IFN0YWdlW10gfVxuXG5leHBvcnQgY29uc3QgU1RBR0VTOiBTdGFnZUlkW10gPSBbJ2FwcCcsICdwaG90bycsICdtb3VudGFpbnMnLCAnc2t5JywgJ2xheWVycycsICdzY2llbmNlJywgJ3BvbGUnLCAnc3VyZmFjZScsICdtdXNpYyddO1xuLyoqIFNoYXJlIG9mIHRoZSBvdmVyYWxsIHBlcmNlbnRhZ2UsIHJvdWdobHkgYnkgaG93IGxvbmcgZWFjaCBzdGFnZSB0YWtlcyBvbiBhIGZpcnN0IHZpc2l0LiAqL1xuY29uc3QgV0VJR0hUOiBSZWNvcmQ8U3RhZ2VJZCwgbnVtYmVyPiA9IHsgYXBwOiAwLCBwaG90bzogMTIsIG1vdW50YWluczogMzAsIHNreTogMTAsIGxheWVyczogMTIsIHNjaWVuY2U6IDgsIHBvbGU6IDE4LCBzdXJmYWNlOiAxNywgbXVzaWM6IDUgfTtcblxuLyoqIFRoZSBhcHAncyBjb2RlIGlzIGluIGJ5IHRoZSB0aW1lIGFueXRoaW5nIGhlcmUgcnVuczogdGhhdCByb3cgc3RhcnRzIG91dCBkb25lLCB3aXRoIHRoZSB0aW1lIHRoZSBwYWdlIHRvb2sgdG8gZ2V0IGl0LiAqL1xuY29uc3QgYXBwU3RhZ2UgPSAoKTogU3RhZ2UgPT4gKHsgaWQ6ICdhcHAnLCBzdGF0ZTogJ2RvbmUnLCBmcmFjOiBudWxsLCBtczogTWF0aC5yb3VuZChwZXJmb3JtYW5jZS5ub3coKSkgfSk7XG5jb25zdCBmcmVzaFN0YWdlID0gKGlkOiBTdGFnZUlkKTogU3RhZ2UgPT4gKGlkID09PSAnYXBwJyA/IGFwcFN0YWdlKCkgOiB7IGlkLCBzdGF0ZTogJ3dhaXRpbmcnLCBmcmFjOiBudWxsIH0pO1xuXG4vKiogVGhlIHN0YXRlIGJlZm9yZSBhbnl0aGluZyBoYXMgc3RhcnRlZCAodGhlIHN0YXJ0IHNjcmVlbiBkcmF3cyB0aGlzIG9uIGl0cyBmaXJzdCBmcmFtZSkuICovXG5leHBvcnQgZnVuY3Rpb24gaW5pdGlhbFByb2dyZXNzKCk6IExvYWRQcm9ncmVzcyB7XG4gIHJldHVybiB7IHBjdDogMCwgc3RlcDogdCgnc3RhcnQuc3RlcC5zdGFydCcpLCBkb25lOiBmYWxzZSwgc3RhZ2VzOiBTVEFHRVMubWFwKGZyZXNoU3RhZ2UpIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJlbG9hZERlcHMge1xuICBoZWlnaHRzUmVhZHk6IFByb21pc2U8dW5rbm93bj47XG4gIG5hbWVzUmVhZHk6IFByb21pc2U8dW5rbm93bj47XG4gIHNreVJlYWR5PzogUHJvbWlzZTx1bmtub3duPjtcbiAgLyoqIE51bWJlciBvZiBwaG90by10aWxlIGpvYnMgc3RpbGwgcnVubmluZyBpbiB0aGUgYmFja2dyb3VuZCB3b3JrZXJzICgwIHdoZW4gcXVpZXQpLiAqL1xuICBpbWFnZXJ5UGVuZGluZz86ICgpID0+IG51bWJlcjtcbiAgLyoqIFRoZSBcIlN0YW5kIGhlcmVcIiB2aWV3OyBwcmV3YXJtKCkgKHdoZW4gaXQgZXhpc3RzKSBsb2FkcyBpdHMgdGV4dHVyZXMgYW5kIG1vZGVscyBhbmQgY29tcGlsZXMgaXRzIHNoYWRlcnMuICovXG4gIGxhbmRlcj86IHsgcHJld2FybT86ICgpID0+IFByb21pc2U8dW5rbm93bj4gfTtcbiAgLyoqIFRoZSBmaWxlcyBiZWhpbmQgdGhlIExheWVycyBzd2l0Y2hlcywgZG93bmxvYWRlZCBpbnRvIHRoZSBicm93c2VyIGNhY2hlIHNvIHN3aXRjaGluZyBvbmUgb24gaXMgaW5zdGFudC4gKi9cbiAgbGF5ZXJGaWxlcz86ICgpID0+IFByb21pc2U8c3RyaW5nW10+O1xuICAvKiogRGVjb2RlIHN0b3JlZCBtYXBzIGFuZCBwcmVwYXJlIHRoZWlyIHByb3ZpZGVycyBiZWZvcmUgYSBMYXllcnMgc3dpdGNoIGNhbiBiZSB1c2VkLiAqL1xuICB3YXJtTGF5ZXJzPzogKG9uRnJhYzogKGZyYWM6IG51bWJlcikgPT4gdm9pZCkgPT4gUHJvbWlzZTx1bmtub3duPjtcbiAgLyoqIFRoZSB2aWV3IHRoZSB1c2VyIHdpbGwgc2VlIGZpcnN0LiAqL1xuICBzdGFydFZpZXc6IENhbWVyYVBvc2U7XG4gIC8qKiBWaWV3cyB0byB2aXNpdCBpbnZpc2libHkgKGNhbWVyYSBqdW1wcyB0aGVyZSwgdGlsZXMgbG9hZCwgc2hhZGVycyBjb21waWxlKSwgaW4gb3JkZXIuIENhbGxlZCBvbmNlIHRoZSBoZWlnaHQgbWFwIGlzIGxvYWRlZC4gKi9cbiAgd2FybVZpZXdzOiAoKSA9PiB7IHBvc2U6IENhbWVyYVBvc2U7IGxhYmVsOiBzdHJpbmc7IG1heE1zOiBudW1iZXIgfVtdO1xuICBvblByb2dyZXNzKHA6IExvYWRQcm9ncmVzcyk6IHZvaWQ7XG4gIC8qKiBTZXQgdG8gdHJ1ZSAoZS5nLiBieSBhIFwiU2tpcFwiIGJ1dHRvbikgdG8gZmluaXNoIGFzIHNvb24gYXMgcG9zc2libGUuICovXG4gIGNhbmNlbGxlZD86ICgpID0+IGJvb2xlYW47XG59XG5cbi8qKiBUaGUgc291dGgtcG9sZSB2aWV3cyBzZWUgZmFyIG92ZXIgdGhlIGhvcml6b24sIHdoZXJlIHRoZSBwaG90b3MgY29tZSBmcm9tIE5BU0EncyBzZXJ2ZXIgKHNsb3cgZnJvbSBmYXIgYXdheSk6XG4gKiAgZ2l2ZSBlYWNoIHZpZXcgdGhpcyBtYW55IHRpbWVzIGl0cyBvd24gdGltZSBsaW1pdCBiZWZvcmUgY2FsbGluZyBpdCBcImZpbmlzaGVzIGluIHRoZSBiYWNrZ3JvdW5kXCIuICovXG5jb25zdCBQT0xFX1RJTUUgPSAyLjU7XG5cbi8qKiBXaGljaCBraW5kcyBvZiBwaG90byBqb2JzIGFyZSBzdGlsbCB3YWl0aW5nIChmb3IgdGhlIHRyYWNlKSwgZS5nLiBcInRyZWvDlzEyIHN5bnRow5c0XCIuICovXG5mdW5jdGlvbiB3YWl0aW5nS2luZHMoKTogc3RyaW5nIHtcbiAgY29uc3QgdyA9IChnbG9iYWxUaGlzIGFzIHsgX19tb29uZGFJbWFnZXJ5PzogeyB3YWl0aW5nKCk6IHsga2luZDogc3RyaW5nIH1bXSB9IH0pLl9fbW9vbmRhSW1hZ2VyeT8ud2FpdGluZygpID8/IFtdO1xuICBjb25zdCBuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCB4IG9mIHcpIG4uc2V0KHgua2luZCwgKG4uZ2V0KHgua2luZCkgPz8gMCkgKyAxKTtcbiAgcmV0dXJuIFsuLi5uXS5tYXAoKFtrLCBjXSkgPT4gYCR7a33DlyR7Y31gKS5qb2luKCcgJyk7XG59XG5cbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpID0+IG5ldyBQcm9taXNlPHZvaWQ+KHIgPT4gc2V0VGltZW91dChyLCBtcykpO1xuLyoqIHRydWUgd2hlbiBgcGAgc2V0dGxlZCBpbiB0aW1lIChyZXNvbHZlZCBvciBmYWlsZWQpLCBmYWxzZSB3aGVuIHRoZSB0aW1lIHJhbiBvdXQgKi9cbmZ1bmN0aW9uIHdpdGhUaW1lb3V0PFQ+KHA6IFByb21pc2U8VD4sIG1zOiBudW1iZXIsIGNhbmNlbGxlZD86ICgpID0+IGJvb2xlYW4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgIGxldCBvdmVyID0gZmFsc2U7XG4gICAgY29uc3QgZW5kID0gKG9rOiBib29sZWFuKSA9PiB7IGlmICghb3ZlcikgeyBvdmVyID0gdHJ1ZTsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgY2xlYXJJbnRlcnZhbChwb2xsKTsgcmVzb2x2ZShvayk7IH0gfTtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gZW5kKGZhbHNlKSwgbXMpO1xuICAgIGNvbnN0IHBvbGwgPSBzZXRJbnRlcnZhbCgoKSA9PiB7IGlmIChjYW5jZWxsZWQ/LigpKSBlbmQoZmFsc2UpOyB9LCAxMDApOyAvLyBhIHNraXAgZW5kcyB0aGUgd2FpdCBhdCBvbmNlXG4gICAgcC50aGVuKCgpID0+IGVuZCh0cnVlKSwgKCkgPT4gZW5kKHRydWUpKTtcbiAgfSk7XG59XG5cbi8qKiBSZW5kZXIgZnJhbWVzIHVudGlsIHRoZSBnbG9iZSBoYXMgbm90aGluZyBsZWZ0IHRvIGxvYWQgZm9yIGEgZmV3IGZyYW1lcyBpbiBhIHJvdywgb3IgdGltZSBydW5zIG91dC5cbiAqICBgb25GcmFjYCBoZWFycyBob3cgbXVjaCBvZiB0aGUgcGhvdG8gd29yayBpcyBkb25lIChmcm9tIHRoZSBtb3N0IHRpbGUgam9icyBzZWVuIHdhaXRpbmcgYXQgb25jZSkuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd2FpdFVudGlsTG9hZGVkKHZpZXdlcjogVmlld2VyLCBtYXhNczogbnVtYmVyLCBwZW5kaW5nPzogKCkgPT4gbnVtYmVyLCBjYW5jZWxsZWQ/OiAoKSA9PiBib29sZWFuLCBvbkZyYWM/OiAoZjogbnVtYmVyKSA9PiB2b2lkKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHQwID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIGxldCBxdWlldCA9IDAsIHBlYWsgPSAxO1xuICB3aGlsZSAocGVyZm9ybWFuY2Uubm93KCkgLSB0MCA8IG1heE1zKSB7XG4gICAgaWYgKHZpZXdlci5pc0Rlc3Ryb3llZCgpIHx8IGNhbmNlbGxlZD8uKCkpIHJldHVybiBmYWxzZTtcbiAgICB2aWV3ZXIuc2NlbmUucmVxdWVzdFJlbmRlcigpO1xuICAgIC8vIHNldFRpbWVvdXQgYXMgd2VsbCBhcyByZXF1ZXN0QW5pbWF0aW9uRnJhbWU6IGEgdGFiIGluIHRoZSBiYWNrZ3JvdW5kIGdldHMgdmVyeSBmZXcgYW5pbWF0aW9uIGZyYW1lc1xuICAgIGF3YWl0IFByb21pc2UucmFjZShbbmV3IFByb21pc2U8dm9pZD4ociA9PiByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gcigpKSksIHNsZWVwKDUwKV0pO1xuICAgIGlmICh2aWV3ZXIuaXNEZXN0cm95ZWQoKSkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IG4gPSBwZW5kaW5nID8gcGVuZGluZygpIDogMDtcbiAgICBwZWFrID0gTWF0aC5tYXgocGVhaywgbik7XG4gICAgY29uc3QgZG9uZSA9IHZpZXdlci5zY2VuZS5nbG9iZS50aWxlc0xvYWRlZCAmJiBuID09PSAwO1xuICAgIG9uRnJhYz8uKGRvbmUgPyAxIDogTWF0aC5taW4oMC45NSwgMSAtIG4gLyBwZWFrKSk7XG4gICAgcXVpZXQgPSBkb25lID8gcXVpZXQgKyAxIDogMDtcbiAgICBpZiAocXVpZXQgPj0gNCAmJiBwZXJmb3JtYW5jZS5ub3coKSAtIHQwID4gMjUwKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbmNvbnN0IHNldFBvc2UgPSAodmlld2VyOiBWaWV3ZXIsIHA6IENhbWVyYVBvc2UpID0+IHtcbiAgdmlld2VyLmNhbWVyYS5zZXRWaWV3KHsgZGVzdGluYXRpb246IHAuZGVzdGluYXRpb24sIG9yaWVudGF0aW9uOiB7IGRpcmVjdGlvbjogcC5kaXJlY3Rpb24sIHVwOiBwLnVwIH0gfSk7XG4gIHZpZXdlci5zY2VuZS5yZXF1ZXN0UmVuZGVyKCk7XG59O1xuXG4vKiogVW50aWwgbGFuZGVyLnByZXdhcm0oKSBleGlzdHM6IGZldGNoIHRoZSBmaWxlcyB0aGUgU3RhbmQtaGVyZSB2aWV3IGFza3MgZm9yLCBzbyB0aGV5IGNvbWUgZnJvbSB0aGUgYnJvd3NlciBjYWNoZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZldGNoU3VyZmFjZUZpbGVzKG9uRnJhYzogKGY6IG51bWJlcikgPT4gdm9pZCwgY2FuY2VsbGVkOiAoKSA9PiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGJhc2UgPSBuZXcgVVJMKCcuL2xhbmRlci8nLCBkb2N1bWVudC5iYXNlVVJJKTtcbiAgY29uc3QgZmlsZXMgPSBbJ3JlZ29saXRoX2Eud2VicCcsICdyZWdvbGl0aF9iLndlYnAnLCAncmVnb2xpdGhfYy53ZWJwJ10ubWFwKGYgPT4gbmV3IFVSTChmLCBiYXNlKS5ocmVmKTtcbiAgLy8gdGhlIHJvY2sgbW9kZWxzOiBlYWNoIGdsVEYgbmFtZXMgaXRzIG93biBtZXNoIGFuZCBwaWN0dXJlIGZpbGVzXG4gIGNvbnN0IHJvY2tzID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogNyB9LCAoXywgaSkgPT4gbmV3IFVSTChgcm9ja3MvbW9vbl9yb2NrXzAke2kgKyAxfS9yb2NrLmdsdGZgLCBiYXNlKSk7XG4gIGNvbnN0IGxpc3RlZCA9IGF3YWl0IFByb21pc2UuYWxsKHJvY2tzLm1hcCh1ID0+IGZldGNoKHUpLnRoZW4ociA9PiAoci5vayA/IHIuanNvbigpIDogbnVsbCkpLnRoZW4oKGc6IHsgYnVmZmVycz86IHsgdXJpPzogc3RyaW5nIH1bXTsgaW1hZ2VzPzogeyB1cmk/OiBzdHJpbmcgfVtdIH0gfCBudWxsKSA9PlxuICAgIFsuLi4oZz8uYnVmZmVycyA/PyBbXSksIC4uLihnPy5pbWFnZXMgPz8gW10pXS5tYXAoeCA9PiB4LnVyaSkuZmlsdGVyKCh4KTogeCBpcyBzdHJpbmcgPT4gISF4ICYmICF4LnN0YXJ0c1dpdGgoJ2RhdGE6JykpLm1hcCh4ID0+IG5ldyBVUkwoeCwgdSkuaHJlZiksXG4gICkuY2F0Y2goKCkgPT4gW10gYXMgc3RyaW5nW10pKSk7XG4gIGZpbGVzLnB1c2goLi4ubGlzdGVkLmZsYXQoKSk7XG4gIGxldCBkb25lID0gMDtcbiAgLy8gYSBmZXcgYXQgYSB0aW1lOiB0aGUgbmV0d29yayBzdGF5cyBmcmVlIGZvciBhbnl0aGluZyBlbHNlIHRoZSBzdGFydC11cCBzdGlsbCBuZWVkc1xuICBjb25zdCBxdWV1ZSA9IFsuLi5maWxlc107XG4gIGNvbnN0IGxhbmUgPSBhc3luYyAoKSA9PiB7XG4gICAgZm9yIChsZXQgZiA9IHF1ZXVlLnNoaWZ0KCk7IGYgJiYgIWNhbmNlbGxlZCgpOyBmID0gcXVldWUuc2hpZnQoKSkge1xuICAgICAgYXdhaXQgZmV0Y2goZikudGhlbihyID0+IHIuYXJyYXlCdWZmZXIoKSkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgICBvbkZyYWMoKytkb25lIC8gZmlsZXMubGVuZ3RoKTtcbiAgICB9XG4gIH07XG4gIGF3YWl0IFByb21pc2UuYWxsKFtsYW5lKCksIGxhbmUoKSwgbGFuZSgpXSk7XG59XG5cbi8qKiBEb3dubG9hZCBmaWxlcyBpbnRvIHRoZSBicm93c2VyIGNhY2hlLCBhIGNvdXBsZSBhdCBhIHRpbWUsIHJlcG9ydGluZyBob3cgbWFueSBhcmUgaW4uIFRydWUgd2hlbiBhbGwgYXJyaXZlZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZldGNoRmlsZXMoZmlsZXM6IHN0cmluZ1tdLCBvbkZyYWM6IChmOiBudW1iZXIpID0+IHZvaWQsIGNhbmNlbGxlZDogKCkgPT4gYm9vbGVhbiwgbGFuZXMgPSAyKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGxldCBkb25lID0gMCwgb2sgPSB0cnVlO1xuICBjb25zdCBxdWV1ZSA9IFsuLi5maWxlc107XG4gIGNvbnN0IGxhbmUgPSBhc3luYyAoKSA9PiB7XG4gICAgZm9yIChsZXQgZiA9IHF1ZXVlLnNoaWZ0KCk7IGYgJiYgIWNhbmNlbGxlZCgpOyBmID0gcXVldWUuc2hpZnQoKSkge1xuICAgICAgY29uc3QgZ29vZCA9IGF3YWl0IGZldGNoKGYpLnRoZW4ociA9PiByLmFycmF5QnVmZmVyKCkudGhlbigoKSA9PiByLm9rKSkuY2F0Y2goKCkgPT4gZmFsc2UpO1xuICAgICAgb2sgPSBvayAmJiBnb29kO1xuICAgICAgb25GcmFjKCsrZG9uZSAvIGZpbGVzLmxlbmd0aCk7XG4gICAgfVxuICB9O1xuICBhd2FpdCBQcm9taXNlLmFsbChBcnJheS5mcm9tKHsgbGVuZ3RoOiBsYW5lcyB9LCBsYW5lKSk7XG4gIHJldHVybiBvayAmJiBkb25lID09PSBmaWxlcy5sZW5ndGg7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5QcmVsb2FkKHZpZXdlcjogVmlld2VyLCBkOiBQcmVsb2FkRGVwcyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzdG9wID0gKCkgPT4gdmlld2VyLmlzRGVzdHJveWVkKCkgfHwgISFkLmNhbmNlbGxlZD8uKCk7XG4gIGNvbnN0IGNhbmNlbGxlZCA9ICgpID0+ICEhZC5jYW5jZWxsZWQ/LigpO1xuICAvLyB3aGF0IGhhcHBlbmVkLCBmb3IgdGVzdHMgYW5kIGZvciBcIndoeSBkaWQgaXQgdGFrZSBzbyBsb25nXCIgKHdpbmRvdy5fX21vb25kYS5wcmVsb2FkVHJhY2UpXG4gIGNvbnN0IHRyYWNlOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBob29rID0gKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgX19tb29uZGE/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9KS5fX21vb25kYTtcbiAgaWYgKGhvb2spIGhvb2sucHJlbG9hZFRyYWNlID0gdHJhY2U7XG4gIGNvbnN0IHN0YWdlcyA9IG5ldyBNYXA8U3RhZ2VJZCwgU3RhZ2U+KFNUQUdFUy5tYXAoaWQgPT4gW2lkLCBmcmVzaFN0YWdlKGlkKV0pKTtcbiAgY29uc3QgYmVnYW4gPSBuZXcgTWFwPFN0YWdlSWQsIG51bWJlcj4oKTtcbiAgbGV0IGZpbmlzaGVkID0gZmFsc2UsIGxhc3RQY3QgPSAtMSwgbGFzdFNlbnQgPSAnJztcblxuICBjb25zdCBzZW5kID0gKCkgPT4ge1xuICAgIGlmIChmaW5pc2hlZCB8fCB2aWV3ZXIuaXNEZXN0cm95ZWQoKSkgcmV0dXJuO1xuICAgIGNvbnN0IGxpc3QgPSBTVEFHRVMubWFwKGlkID0+ICh7IC4uLnN0YWdlcy5nZXQoaWQpISB9KSk7XG4gICAgbGV0IGdvdCA9IDAsIGFsbCA9IDA7XG4gICAgZm9yIChjb25zdCBzIG9mIGxpc3QpIHtcbiAgICAgIGFsbCArPSBXRUlHSFRbcy5pZF07XG4gICAgICBnb3QgKz0gV0VJR0hUW3MuaWRdICogKHMuc3RhdGUgPT09ICdkb25lJyB8fCBzLnN0YXRlID09PSAnbGF0ZXInIHx8IHMuc3RhdGUgPT09ICdvZmYnID8gMSA6IHMuc3RhdGUgPT09ICdsb2FkaW5nJyA/IChzLmZyYWMgPz8gMCkgOiAwKTtcbiAgICB9XG4gICAgY29uc3QgcGN0ID0gTWF0aC5taW4oOTksIE1hdGguZmxvb3IoKDEwMCAqIGdvdCkgLyBhbGwpKTtcbiAgICBjb25zdCBjdXJyZW50ID0gbGlzdC5maW5kKHMgPT4gcy5zdGF0ZSA9PT0gJ2xvYWRpbmcnKTtcbiAgICBjb25zdCBrZXkgPSBsaXN0Lm1hcChzID0+IHMuc3RhdGUpLmpvaW4oKSArIHBjdDtcbiAgICBpZiAoa2V5ID09PSBsYXN0U2VudCAmJiBwY3QgPT09IGxhc3RQY3QpIHJldHVybjtcbiAgICBsYXN0U2VudCA9IGtleTsgbGFzdFBjdCA9IHBjdDtcbiAgICBkLm9uUHJvZ3Jlc3MoeyBwY3QsIHN0ZXA6IGN1cnJlbnQgPyB0KGBzdGFydC5zdGFnZS4ke2N1cnJlbnQuaWR9YCkgOiB0KCdzdGFydC5zdGVwLnN0YXJ0JyksIGRvbmU6IGZhbHNlLCBzdGFnZXM6IGxpc3QgfSk7XG4gIH07XG4gIGNvbnN0IG1hcmsgPSAoaWQ6IFN0YWdlSWQsIHN0YXRlOiBTdGFnZVN0YXRlLCBmcmFjOiBudW1iZXIgfCBudWxsID0gbnVsbCkgPT4ge1xuICAgIGNvbnN0IHMgPSBzdGFnZXMuZ2V0KGlkKSE7XG4gICAgaWYgKHN0YXRlID09PSAnbG9hZGluZycgJiYgIWJlZ2FuLmhhcyhpZCkpIGJlZ2FuLnNldChpZCwgcGVyZm9ybWFuY2Uubm93KCkpO1xuICAgIGlmIChzdGF0ZSAhPT0gJ2xvYWRpbmcnICYmIHN0YXRlICE9PSAnd2FpdGluZycgJiYgYmVnYW4uaGFzKGlkKSkgcy5tcyA9IE1hdGgucm91bmQocGVyZm9ybWFuY2Uubm93KCkgLSBiZWdhbi5nZXQoaWQpISk7XG4gICAgcy5zdGF0ZSA9IHN0YXRlOyBzLmZyYWMgPSBmcmFjO1xuICAgIHNlbmQoKTtcbiAgfTtcbiAgY29uc3QgZnJhYyA9IChpZDogU3RhZ2VJZCkgPT4gKGY6IG51bWJlcikgPT4ge1xuICAgIGNvbnN0IHMgPSBzdGFnZXMuZ2V0KGlkKSE7XG4gICAgaWYgKHMuc3RhdGUgIT09ICdsb2FkaW5nJyB8fCAocy5mcmFjICE9PSBudWxsICYmIE1hdGguYWJzKGYgLSBzLmZyYWMpIDwgMC4wMiAmJiBmIDwgMSkpIHJldHVybjtcbiAgICBzLmZyYWMgPSBmOyBzZW5kKCk7XG4gIH07XG4gIC8qKiBydW4gb25lIHN0YWdlOiBsb2FkaW5nIOKGkiBkb25lIHdoZW4gYGpvYmAgc2F5cyBpdCBmaW5pc2hlZCBpbiB0aW1lLCBvdGhlcndpc2UgXCJsYXRlclwiICovXG4gIGNvbnN0IHN0YWdlID0gYXN5bmMgKGlkOiBTdGFnZUlkLCBqb2I6ICgpID0+IFByb21pc2U8Ym9vbGVhbiB8IHZvaWQ+KSA9PiB7XG4gICAgbWFyayhpZCwgJ2xvYWRpbmcnKTtcbiAgICBsZXQgb2sgPSBmYWxzZTtcbiAgICB0cnkgeyBvayA9IChhd2FpdCBqb2IoKSkgIT09IGZhbHNlOyB9IGNhdGNoIHsgb2sgPSBmYWxzZTsgfVxuICAgIGlmICghdmlld2VyLmlzRGVzdHJveWVkKCkpIG1hcmsoaWQsIG9rICYmICFjYW5jZWxsZWQoKSA/ICdkb25lJyA6ICdsYXRlcicpO1xuICB9O1xuXG4gIC8vIG11c2ljOiBvbmx5IHdoZW4gaXQgaXMgc3dpdGNoZWQgb247IHN3aXRjaGluZyBpdCBvbiBkdXJpbmcgc3RhcnQtdXAgZmV0Y2hlcyBpdCB0aGVuXG4gIGxldCBtdXNpY0pvYjogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuICBjb25zdCBtdXNpYyA9ICgpID0+IHtcbiAgICBpZiAoIXNldHRpbmdzLmdldCgpLnNvdW5kKSB7IGlmIChzdGFnZXMuZ2V0KCdtdXNpYycpIS5zdGF0ZSA9PT0gJ3dhaXRpbmcnKSBtYXJrKCdtdXNpYycsICdvZmYnKTsgcmV0dXJuOyB9XG4gICAgaWYgKG11c2ljSm9iKSByZXR1cm47XG4gICAgbXVzaWNKb2IgPSBzdGFnZSgnbXVzaWMnLCAoKSA9PiB3aXRoVGltZW91dChwcmVmZXRjaE11c2ljKCksIDIwMDAwLCBjYW5jZWxsZWQpLnRoZW4ob2sgPT4gb2spKTtcbiAgfTtcbiAgY29uc3Qgb2ZmU291bmQgPSBzZXR0aW5ncy5zdWJzY3JpYmUoKHMsIHByZXYpID0+IHsgaWYgKHMuc291bmQgJiYgIXByZXYuc291bmQpIG11c2ljKCk7IH0pO1xuXG4gIHRyeSB7XG4gICAgc2VuZCgpO1xuICAgIG11c2ljKCk7XG4gICAgY29uc3QgbWFuaWZlc3QgPSB3aXRoVGltZW91dChsb2FkTWFuaWZlc3QoKSwgODAwMCwgY2FuY2VsbGVkKTsgLy8gdGhlIGxheWVyIGxlZ2VuZHMgKHNtYWxsKVxuICAgIGNvbnN0IHNreSA9IGQuc2t5UmVhZHkgPyBzdGFnZSgnc2t5JywgKCkgPT4gd2l0aFRpbWVvdXQoZC5za3lSZWFkeSEsIDMwMDAwLCBjYW5jZWxsZWQpKSA6IFByb21pc2UucmVzb2x2ZShtYXJrKCdza3knLCAnZG9uZScpKTtcblxuICAgIC8vIHRoZSBoZWlnaHQgbWFwcyBkb3dubG9hZCBmcm9tIHRoZSB2ZXJ5IHN0YXJ0LCB3aGlsZSB0aGUgb3BlbmluZyB2aWV3J3MgcGhvdG8gbG9hZHNcbiAgICBsZXQgaGVpZ2h0c09rID0gZmFsc2U7XG4gICAgbGV0IHBob3RvRG9uZSA9ICgpID0+IHt9O1xuICAgIGNvbnN0IHBob3RvRmluaXNoZWQgPSBuZXcgUHJvbWlzZTx2b2lkPihyID0+IHsgcGhvdG9Eb25lID0gcjsgfSk7XG4gICAgY29uc3QgbW91bnRhaW5zID0gc3RhZ2UoJ21vdW50YWlucycsIGFzeW5jICgpID0+IHtcbiAgICAgIGhlaWdodHNPayA9IGF3YWl0IHdpdGhUaW1lb3V0KGQuaGVpZ2h0c1JlYWR5LCA5MDAwMCwgY2FuY2VsbGVkKTtcbiAgICAgIGF3YWl0IHBob3RvRmluaXNoZWQ7XG4gICAgICBpZiAoc3RvcCgpKSByZXR1cm4gZmFsc2U7XG4gICAgICBhd2FpdCBzbGVlcCg2MCk7IC8vIHRoZSBtYXAgc3dhcHMgaW4gdGhlIDNEIGdyb3VuZCB3aGVuIHRoZSBoZWlnaHRzIGFycml2ZVxuICAgICAgc2V0UG9zZSh2aWV3ZXIsIGQuc3RhcnRWaWV3KTtcbiAgICAgIC8vIHRoZW4gdGhlIDNEIGdyb3VuZCBhdCB0aGUgb3BlbmluZyB2aWV3XG4gICAgICByZXR1cm4gaGVpZ2h0c09rICYmIGF3YWl0IHdhaXRVbnRpbExvYWRlZCh2aWV3ZXIsIDE1MDAwLCBkLmltYWdlcnlQZW5kaW5nLCBkLmNhbmNlbGxlZCk7XG4gICAgfSk7XG5cbiAgICAvLyB0aGUgb3BlbmluZyB2aWV3J3MgcGhvdG8sIG9uIHRoZSBzbW9vdGggYmFsbCAodGhlIDNEIGdyb3VuZCByZXBsYWNlcyBpdCBvbmNlIHRoZSBoZWlnaHRzIGFyZSBpbilcbiAgICBzZXRQb3NlKHZpZXdlciwgZC5zdGFydFZpZXcpO1xuICAgIGF3YWl0IHN0YWdlKCdwaG90bycsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IG9rID0gYXdhaXQgd2FpdFVudGlsTG9hZGVkKHZpZXdlciwgMjAwMDAsIGQuaW1hZ2VyeVBlbmRpbmcsIGQuY2FuY2VsbGVkLCBmcmFjKCdwaG90bycpKTtcbiAgICAgIGF3YWl0IG1hbmlmZXN0O1xuICAgICAgYXdhaXQgd2l0aFRpbWVvdXQoZC5uYW1lc1JlYWR5LCA2MDAwLCBjYW5jZWxsZWQpO1xuICAgICAgcmV0dXJuIG9rO1xuICAgIH0pLmZpbmFsbHkocGhvdG9Eb25lKTtcbiAgICBhd2FpdCBtb3VudGFpbnM7XG4gICAgaWYgKHN0b3AoKSkgcmV0dXJuO1xuXG4gICAgLy8gdGhlIGNhbGN1bGF0b3IgYW5kIHRoZSBTdGFuZC1oZXJlIHZpZXcgd29yayBpbiB0aGUgYmFja2dyb3VuZCAod29ya2VyIHRocmVhZCwgbmV0d29yaykgd2hpbGVcbiAgICAvLyB0aGUgY2FtZXJhIHZpc2l0cyB0aGUgc291dGgtcG9sZSB2aWV3c1xuICAgIGNvbnN0IHNjaWVuY2UgPSBzdGFnZSgnc2NpZW5jZScsICgpID0+IHtcbiAgICAgIGlmICghaGVpZ2h0c09rKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICAgIC8vIG9uZSByZWFsIGNhbGN1bGF0aW9uIGF0IHRoZSBmaXJzdCBzb3V0aC1wb2xlIHNwb3QgcGVvcGxlIHRyeTogdGhlIHdvcmtlciBoYXMgdGhlIGhlaWdodHMsIGl0c1xuICAgICAgLy8gODAgbSB0aWxlcyB0aGVyZSBhcmUgbG9hZGVkIGFuZCBpdHMgY29kZSBpcyB3YXJtZWQgdXBcbiAgICAgIGNvbnN0IGhvdXIgPSAzNjAwXzAwMDtcbiAgICAgIHJldHVybiB3aXRoVGltZW91dChhbmFseXNlU3BvdEFzeW5jKHsgbGF0OiAtODkuNDUsIGxvbjogLTEzNi43LCBtYXN0TTogMiwgc3RhcnRNczogTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gaG91cikgKiBob3VyLCBkYXlzOiAxNCB9LCA0MDAwMCksIDQwMDAwLCBjYW5jZWxsZWQpO1xuICAgIH0pO1xuICAgIC8vIERlY29kZSBsb2NhbCBzY2llbmNlIG1hcHMgd2hpbGUgcmVtb3RlIGhlaWdodCB0aWxlcyBkb3dubG9hZCwgc28gYSBzbG93IHNlcnZlciBjYW5ub3RcbiAgICAvLyBob2xkIHVwIHRoZSBtYXBzIHRoYXQgYXJlIGFscmVhZHkgc3RvcmVkIHdpdGggdGhlIGFwcC5cbiAgICBjb25zdCBsYXllcnMgPSBkLmxheWVyRmlsZXMgfHwgZC53YXJtTGF5ZXJzXG4gICAgICA/IHN0YWdlKCdsYXllcnMnLCBhc3luYyAoKSA9PiB3aXRoVGltZW91dCgoYXN5bmMgKCkgPT4ge1xuICAgICAgICBsZXQgZmV0Y2hlZCA9IGQubGF5ZXJGaWxlcyA/IDAgOiAxLCB3YXJtZWQgPSBkLndhcm1MYXllcnMgPyAwIDogMTtcbiAgICAgICAgY29uc3QgcmVwb3J0ID0gKCkgPT4gZnJhYygnbGF5ZXJzJykoZC5sYXllckZpbGVzICYmIGQud2FybUxheWVycyA/IGZldGNoZWQgKiAwLjQ1ICsgd2FybWVkICogMC41NSA6IGQubGF5ZXJGaWxlcyA/IGZldGNoZWQgOiB3YXJtZWQpO1xuICAgICAgICBjb25zdCBmZXRjaEpvYiA9IGQubGF5ZXJGaWxlcyA/IGQubGF5ZXJGaWxlcygpLnRoZW4oZmlsZXMgPT4gZmV0Y2hGaWxlcyhmaWxlcywgZiA9PiB7IGZldGNoZWQgPSBmOyByZXBvcnQoKTsgfSwgY2FuY2VsbGVkKSkgOiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgY29uc3Qgd2FybUpvYiA9IGQud2FybUxheWVycyAmJiAhc3RvcCgpID8gZC53YXJtTGF5ZXJzKGYgPT4geyB3YXJtZWQgPSBmOyByZXBvcnQoKTsgfSkgOiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgYXdhaXQgUHJvbWlzZS5hbGwoW2ZldGNoSm9iLCB3YXJtSm9iXSk7XG4gICAgICB9KSgpLCA5MDAwMCwgY2FuY2VsbGVkKSlcbiAgICAgIDogUHJvbWlzZS5yZXNvbHZlKG1hcmsoJ2xheWVycycsICdvZmYnKSk7XG4gICAgY29uc3Qgc3VyZmFjZSA9IHN0YWdlKCdzdXJmYWNlJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgcHJld2FybSA9IGQubGFuZGVyPy5wcmV3YXJtO1xuICAgICAgaWYgKHR5cGVvZiBwcmV3YXJtID09PSAnZnVuY3Rpb24nKSByZXR1cm4gd2l0aFRpbWVvdXQocHJld2FybS5jYWxsKGQubGFuZGVyKSwgNjAwMDAsIGNhbmNlbGxlZCk7XG4gICAgICByZXR1cm4gd2l0aFRpbWVvdXQoZmV0Y2hTdXJmYWNlRmlsZXMoZnJhYygnc3VyZmFjZScpLCBjYW5jZWxsZWQpLCA2MDAwMCwgY2FuY2VsbGVkKTtcbiAgICB9KTtcblxuICAgIGF3YWl0IHN0YWdlKCdwb2xlJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3Qgdmlld3MgPSBkLndhcm1WaWV3cygpO1xuICAgICAgbGV0IG9rID0gdHJ1ZTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdmlld3MubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKHN0b3AoKSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICBzZXRQb3NlKHZpZXdlciwgdmlld3NbaV0ucG9zZSk7XG4gICAgICAgIGNvbnN0IHQxID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICAgIGNvbnN0IGdvdCA9IGF3YWl0IHdhaXRVbnRpbExvYWRlZCh2aWV3ZXIsIHZpZXdzW2ldLm1heE1zICogUE9MRV9USU1FLCBkLmltYWdlcnlQZW5kaW5nLCBkLmNhbmNlbGxlZCwgZiA9PiBmcmFjKCdwb2xlJykoKGkgKyBmKSAvIHZpZXdzLmxlbmd0aCkpO1xuICAgICAgICB0cmFjZS5wdXNoKGAke3ZpZXdzW2ldLmxhYmVsfTogJHtnb3QgPyAnc2hhcnAnIDogJ3RpbWVkIG91dCd9IGFmdGVyICR7TWF0aC5yb3VuZChwZXJmb3JtYW5jZS5ub3coKSAtIHQxKX0gbXMsICR7ZC5pbWFnZXJ5UGVuZGluZz8uKCkgPz8gMH0gcGhvdG8gam9icyBsZWZ0ICR7d2FpdGluZ0tpbmRzKCl9YCk7XG4gICAgICAgIG9rID0gZ290ICYmIG9rO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG9rO1xuICAgIH0pO1xuICAgIGF3YWl0IFByb21pc2UuYWxsKFtzY2llbmNlLCBzdXJmYWNlLCBza3ksIGxheWVyc10pO1xuICAgIGlmIChzdG9wKCkpIHJldHVybjtcblxuICAgIC8vIGJhY2sgdG8gdGhlIG9wZW5pbmcgdmlldywgYXQgdGhlIGdyYXBoaWNzIG1vZGUgY2hvc2VuIG5vdyAoaXQgbWF5IGhhdmUgY2hhbmdlZCB3aGlsZSBsb2FkaW5nKVxuICAgIHNldFBvc2Uodmlld2VyLCBkLnN0YXJ0Vmlldyk7XG4gICAgYXdhaXQgd2FpdFVudGlsTG9hZGVkKHZpZXdlciwgNjAwMCwgZC5pbWFnZXJ5UGVuZGluZywgZC5jYW5jZWxsZWQpO1xuICAgIGlmIChtdXNpY0pvYikgYXdhaXQgbXVzaWNKb2I7XG4gIH0gZmluYWxseSB7XG4gICAgb2ZmU291bmQoKTtcbiAgICAvLyBBIGRlc3Ryb3llZCB2aWV3ZXIgKFJlYWN0IHJlbW91bnQgaW4gZGV2ZWxvcG1lbnQpIG11c3Qgc3RheSBzaWxlbnQ6IHRoZSBuZXcgdmlld2VyIHJlcG9ydHMgZm9yIGl0c2VsZi5cbiAgICBpZiAoIXZpZXdlci5pc0Rlc3Ryb3llZCgpKSB7XG4gICAgICBzZXRQb3NlKHZpZXdlciwgZC5zdGFydFZpZXcpO1xuICAgICAgZm9yIChjb25zdCBzIG9mIHN0YWdlcy52YWx1ZXMoKSkgaWYgKHMuc3RhdGUgPT09ICd3YWl0aW5nJyB8fCBzLnN0YXRlID09PSAnbG9hZGluZycpIHMuc3RhdGUgPSAnbGF0ZXInO1xuICAgICAgZmluaXNoZWQgPSB0cnVlO1xuICAgICAgZC5vblByb2dyZXNzKHsgcGN0OiAxMDAsIHN0ZXA6IHQoJ3N0YXJ0LnN0ZXAucmVhZHknKSwgZG9uZTogdHJ1ZSwgc3RhZ2VzOiBTVEFHRVMubWFwKGlkID0+ICh7IC4uLnN0YWdlcy5nZXQoaWQpISB9KSkgfSk7XG4gICAgfVxuICB9XG59XG4iXX0=