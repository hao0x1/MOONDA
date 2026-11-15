import { Columns, DotsThree, Gauge, Moon, Path, Question, SpeakerHigh, SpeakerSlash, Stack, Target, X } from '@phosphor-icons/react';
import { chooseQuality } from './app/quality';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { settings } from './app/settings';
import { loadNames, type MoonName } from './data/names';
import { PLACES as PLACES_FOR_AI, type Place } from './data/places';
import { installLang, setLang, useT } from './i18n';
import { BASE_LAYERS, HIDDEN_SCIENCE, layerDefaults, layerTitle, panelGroups, scienceToLayer, type ScienceManifestEntry } from './moon/layers';
import { landerLink } from './moon/lander';
import { roverLink, surfaceDistM, type Waypoint } from './moon/roverLink';
import { initialProgress } from './moon/preload';
import { MoonMap, type LoadProgress, type MapPin, type MapSelection, type MoonMapHandle } from './moon/MoonMap';
import { planRouteAsync, useSpot, useSpots, warmUp } from './science/client';
import type { RoutePrefer, RouteResult } from './science/route';
import { bodyFixedState, MOON_RADIUS_M } from './science/ephemeris';
import { loadManifest, useLayerValues } from './science/layerValues';
import type { AppBridge } from './ai/tools';
import { AiMark, AiPanel } from './ui/AiPanel';
import { usePhoneLayout } from './ui/PhoneSheet';
import { Compare, nextPlanIndex, planColour, planLetter, readNeeds, type CompareItem } from './ui/Compare';
import { LanderHud } from './ui/LanderHud';
import { LayerLegend, LayersPanel } from './ui/LayersPanel';
import { StartScreen } from './ui/StartScreen';
import { MapControls } from './ui/MapControls';
import { OverviewRouteButton, RouteTool } from './ui/RouteTool';
import { ARRIVAL_MAX, ARRIVAL_MIN } from './ui/parseDate';
import { PlaceCard, selectionLatLon, selectionTitle, type Selection } from './ui/PlaceCard';
import { Search } from './ui/Search';
import { StatusLine } from './ui/StatusLine';
import { hoverStore } from './ui/stores';
import { TimeBar } from './ui/TimeBar';
import { installTips } from './ui/tips';
import { tutorialStore } from './ui/tutorialStore';
import { Welcome } from './ui/Welcome';
import { setExploreNames } from './explore/context';
import { probeAt } from './explore/probe';
import type { RouteView } from './explore/RoutePanel';
import { SurfaceMap } from './explore/SurfaceMap';
import { RenderStopped, readGraphicsRecovery, saveGraphicsRecovery } from './ui/RenderStopped';

const DEFAULT_ARRIVAL = Date.UTC(2026, 10, 18, 2, 0);
const sameSpot = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;
interface Pin { lat: number; lon: number; label: string }
/** The planned drive: from one pin to another, what the search should look for, and the answer once it is in. */
interface PlannedRoute { from: Pin; to: Pin; prefer: RoutePrefer; status: 'working' | 'ready' | 'error'; result: RouteResult | null; /** counts the times it was asked for (a new number sends a new request) */ ask: number }
/**
 * Ask for a route. The same route that is already there (or being worked out) is kept as it is: asking again
 * would otherwise wait for ever for an answer nobody was asked for. One that failed is tried again.
 */
function askRoute(cur: PlannedRoute | null, from: Pin, to: Pin, prefer: RoutePrefer): PlannedRoute {
  if (cur && cur.status !== 'error' && sameSpot(cur.from, from) && sameSpot(cur.to, to) && cur.prefer === prefer) return cur;
  return { from, to, prefer, status: 'working', result: null, ask: (cur?.ask ?? 0) + 1 };
}

export default function App() {
  const map = useRef<MoonMapHandle>(null);
  const [graphicsRecovery] = useState(readGraphicsRecovery);
  const recoveryRover = useRef(graphicsRecovery?.rover ?? null);
  const recoveryApplied = useRef(false);
  const t = useT();
  const prefs = settings.use();
  const phone = usePhoneLayout();
  const [phoneMore, setPhoneMore] = useState(false);
  useEffect(() => installLang(), []);
  const [names, setNames] = useState<MoonName[] | null>(null);
  const [manifest, setManifest] = useState<ScienceManifestEntry[]>([]);
  useEffect(() => { loadNames().then(n => { setNames(n); setExploreNames(n); }); loadManifest().then(setManifest); }, []);
  const scienceLayers = useMemo(() => manifest.map(scienceToLayer), [manifest]);
  const sciencePanelLayers = useMemo(() => scienceLayers.filter(l => !HIDDEN_SCIENCE.has(l.id)), [scienceLayers]);
  const heightDef = useMemo(() => {
    const base = BASE_LAYERS.find(l => l.id === 'height')!;
    const polar = scienceLayers.find(l => l.id === 'height');
    return polar ? { ...base, legend: polar.legend, units: polar.units } : base;
  }, [scienceLayers]);

  const [layers, setLayers] = useState<Record<string, boolean>>(graphicsRecovery?.layers ?? layerDefaults);
  const [opacity, setOpacity] = useState<Record<string, number>>(graphicsRecovery?.opacity ?? {});
  const [showLayers, setShowLayers] = useState(false);
  const [mapMode, setMapMode] = useState<'globe' | 'flat'>('globe');
  const mapModeRef = useRef(mapMode);
  useEffect(() => { mapModeRef.current = mapMode; }, [mapMode]);
  const [selection, setSelection] = useState<Selection | null>(graphicsRecovery?.selection ?? null);
  const [arrival, setArrival] = useState(graphicsRecovery?.arrival ?? DEFAULT_ARRIVAL);
  const [days, setDays] = useState(graphicsRecovery?.days ?? 14);
  const [cursor, setCursor] = useState(graphicsRecovery?.cursor ?? DEFAULT_ARRIVAL);
  const minuteRef = useRef(DEFAULT_ARRIVAL);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(6);
  const [mastM, setMastM] = useState(graphicsRecovery?.mastM ?? 2);
  const [compare, setCompare] = useState<CompareItem[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [aiMounted, setAiMounted] = useState(false);   // once opened, the AI panel stays alive (hidden) so a running answer and the chat survive closing it
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => { if (showAi) setAiMounted(true); }, [showAi]);
  const [rightReach, setRightReach] = useState(false); // the box on the right reaches down to the map controls
  const [standing, setStanding] = useState(false);
  // Routes and the trail belong only to the current visit to the surface.
  const [route, setRoute] = useState<PlannedRoute | null>(null);
  // The overview keeps its own route when the surface visit ends.
  const [overviewRoute, setOverviewRoute] = useState<PlannedRoute | null>(null);
  const [routeArmed, setRouteArmed] = useState(false);
  const [overviewStart, setOverviewStart] = useState<Pin | null>(null);
  const [overviewPrefer, setOverviewPrefer] = useState<RoutePrefer>('fastest');
  const [surfaceMapOpen, setSurfaceMapOpen] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);
  // What is switched on inside the surface map belongs to that visit. It used to be the overview's own switches:
  // Water ice turned on down there followed you back up, where its colour key then sat on the screen with (at
  // most places) nothing on the Moon to explain it. The visit starts from the overview's switches and adds its own.
  const [surfaceLayers, setSurfaceLayers] = useState<Record<string, boolean>>({});
  const [surfaceOpacity, setSurfaceOpacity] = useState<Record<string, number>>({});
  const [surfacePrefer, setSurfacePrefer] = useState<RoutePrefer>('fastest');
  useEffect(() => {
    try { localStorage.removeItem('moonda.drives.v1'); } catch { /* storage may be disabled */ }
  }, []);
  const [welcome, setWelcome] = useState<false | 'intro' | 'sources'>(false); // the start screen replaced the first-run card; "?" still opens it
  const closeWelcome = () => { setWelcome(false); try { localStorage.setItem('moonda.welcome', '1'); } catch { /* private mode */ } };

  // Start-up: the map loads its data behind a full-screen loading screen and reports real progress.
  // The start screen stays until the person clicks Enter (enabled once everything is loaded).
  const [load, setLoad] = useState<LoadProgress>(initialProgress);
  const [entered, setEntered] = useState(false);
  const [loadGone, setLoadGone] = useState(false);
  const enterApp = useCallback(() => setEntered(true), []);
  // When start-up loading is done the height maps are in the browser cache: only then let the background
  // calculator load them (from the cache), instead of downloading the same 46 MB twice at the same time.
  const warmed = useRef(false);
  const onLoadProgress = useCallback((p: LoadProgress) => {
    setLoad(cur => (cur.done ? cur : p));
    if (p.done && !warmed.current) { warmed.current = true; warmUp(); }
  }, []);
  useEffect(() => {
    if (!entered || !load.done) return;
    const t = setTimeout(() => setLoadGone(true), 520); // after the fade-out
    return () => clearTimeout(t);
  }, [entered, load.done]);
  const skipLoading = () => {
    (window as unknown as { __moonda?: { skipLoading?: () => void } }).__moonda?.skipLoading?.();
    // if the map cannot answer for some reason, never leave the user stuck on the loading screen
    setTimeout(() => setLoad(cur => (cur.done ? cur : { ...cur, pct: 100, done: true })), 1500);
  };
  // Last resort: the map's loader has its own time limits (about 2 minutes at worst on a very slow network); never keep Enter off beyond that.
  useEffect(() => {
    const t = setTimeout(() => setLoad(cur => (cur.done ? cur : { ...cur, pct: 100, done: true })), 180000);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => installTips(), []);

  // A new arrival date keeps the same point in the mission (day 5 stays day 5) instead of jumping back to the landing.
  const prevArrival = useRef(arrival);
  useEffect(() => {
    const before = prevArrival.current;
    prevArrival.current = arrival;
    setCursor(c => arrival + Math.min(days * 86400000, Math.max(0, c - before)));
    setPlaying(false);
  }, [arrival, days]);
  /** The only way the arrival time is changed: never NaN, whole minutes, inside the years the Sun/Earth maths is checked for. */
  const setArrivalSafe = useCallback((ms: number) => {
    if (!Number.isFinite(ms)) return;
    setArrival(Math.min(ARRIVAL_MAX, Math.max(ARRIVAL_MIN, Math.round(ms / 60000) * 60000)));
  }, []);

  // Play: advance mission time.
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setCursor(c => {
        const next = c + dt * speed * 3600000;
        if (next >= arrival + days * 86400000) { setPlaying(false); return arrival + days * 86400000; }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, arrival, days]);

  const sel = selection ? selectionLatLon(selection) : null;
  const spot = useSpot(sel ? { lat: sel.lat, lon: sel.lon, mastM, startMs: arrival, days } : null);
  const ready = spot?.status === 'ready' ? spot : null;
  // While a new answer for the SAME place is being worked out (new date, mission length or panel height),
  // keep showing the previous one, dimmed, instead of blanking the panel and the time bar.
  const lastReady = useRef<{ key: string; entry: NonNullable<typeof ready> } | null>(null);
  const selKey = sel ? `${sel.lat},${sel.lon}` : '';
  if (ready) lastReady.current = { key: selKey, entry: ready };
  const shown = ready ?? (spot?.status === 'loading' && lastReady.current?.key === selKey ? lastReady.current.entry : null);
  const stale = !ready && !!shown;
  const timeline = shown?.timeline ?? null;
  const scienceValues = useLayerValues(manifest, sel?.lat ?? null, sel?.lon ?? null);

  const compareSpecs = useMemo(() => compare.map(c => ({ lat: c.lat, lon: c.lon, mastM, startMs: c.startMs, days })), [compare, mastM, days]);
  const compareEntries = useSpots(compareSpecs);

  // Sun & Earth for the current time (used by day/night shading and the lander view)
  const minute = Math.round(cursor / 60000) * 60000;
  minuteRef.current = minute;
  const bodies = useMemo(() => bodyFixedState(minute), [minute]);
  const ci = timeline ? Math.min(timeline.count - 1, Math.max(0, Math.round((cursor - timeline.startMs) / timeline.stepMs))) : 0;
  const sunNow = timeline ? { el: timeline.sunEl[ci], sky: timeline.sunSky[ci], part: timeline.sunPart[ci], az: timeline.sunAz[ci] } : null;
  const earthNow = timeline ? { el: timeline.earthEl[ci], sky: timeline.earthSky[ci], part: timeline.earthPart[ci], az: timeline.earthAz[ci] } : null;
  const earthNever = timeline ? Array.from(timeline.earthEl).every(v => v < 0) : false;
  const sky = useMemo(() => ({ sun: bodies.sun, earth: bodies.earth, sunPart: sunNow?.part ?? null, earthUp: earthNow ? earthNow.el > earthNow.sky : null }),
    [bodies, sunNow?.part, earthNow?.el, earthNow?.sky]); // eslint-disable-line react-hooks/exhaustive-deps

  const [faceAz, setFaceAz] = useState(graphicsRecovery?.az ?? 0);
  const landerLive = useMemo(() => (standing && ready && sel ? { lat: sel.lat, lon: sel.lon, groundM: ready.horizon.groundM, mastM, skyline: ready.horizon, faceAz, rover: recoveryRover.current } : null),
    [standing, ready, sel?.lat, sel?.lon, mastM, faceAz]); // eslint-disable-line react-hooks/exhaustive-deps
  // While standing, a new arrival date / mission length makes the worker recalculate for a moment:
  // keep the view we have instead of dropping back to the map and fading in again.
  const lastLander = useRef(landerLive);
  if (landerLive) lastLander.current = landerLive; else if (!standing) lastLander.current = null;
  const lander = standing ? (landerLive ?? lastLander.current) : null;
  const captureRecovery = useRef(() => {});
  captureRecovery.current = () => {
    if (!load.done) return;
    const p = roverLink.pose;
    saveGraphicsRecovery({ at: Date.now(), entered, view: map.current?.captureView() ?? null, selection, standing,
      rover: standing && p.on ? { lat: p.lat, lon: p.lon, headingDeg: p.headingDeg } : null,
      surfaceView: landerLink.view, az: landerLink.az, el: landerLink.el,
      arrival, cursor, days, mastM, layers, opacity });
  };
  useEffect(() => {
    let lost = false, timer: ReturnType<typeof setTimeout> | undefined;
    const reloadVisible = () => {
      if (!lost || document.hidden || timer) return;
      try {
        const previous = Number(sessionStorage.getItem('moonda.graphics-reloaded'));
        if (previous && Date.now() - previous < 5 * 60_000) return;
      } catch { return; } // Keep the manual Reload button when storage is unavailable.
      timer = setTimeout(() => {
        timer = undefined;
        if (document.hidden) return;
        try { sessionStorage.setItem('moonda.graphics-reloaded', String(Date.now())); } catch { return; }
        location.reload();
      }, 700);
    };
    const onLoss = () => {
      if (lost) return;
      lost = true; captureRecovery.current();
      landerLink.setWalk(false); setContextLost(true);
      reloadVisible();
    };
    const visibility = () => {
      if (document.hidden) { if (!lost) captureRecovery.current(); }
      else {
        if (!lost) { try { sessionStorage.removeItem('moonda.graphics-recovery.v1'); } catch { /* Storage may be disabled. */ } }
        reloadVisible();
      }
    };
    window.addEventListener('moonda-context-lost', onLoss);
    document.addEventListener('visibilitychange', visibility);
    return () => { clearTimeout(timer); window.removeEventListener('moonda-context-lost', onLoss); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => {
    if (!load.done || !graphicsRecovery || recoveryApplied.current) return;
    recoveryApplied.current = true;
    if (graphicsRecovery.entered) setEntered(true);
    if (!graphicsRecovery.standing) {
      if (graphicsRecovery.view) map.current?.restoreView(graphicsRecovery.view);
      return;
    }
    setStanding(true);
    const off = landerLink.subscribe(() => {
      if (landerLink.phase !== 'ready') return;
      off();
      landerLink.setView(graphicsRecovery.surfaceView);
      map.current?.look(graphicsRecovery.az, graphicsRecovery.el);
      recoveryRover.current = null;
    });
    return off;
  }, [load.done, graphicsRecovery]);
  useEffect(() => { if (standing && !selection) setStanding(false); }, [standing, selection]);

  const [standWhenReady, setStandWhenReady] = useState(false);
  const stand = () => {
    if (!ready) { setStandWhenReady(true); return; }
    setFaceAz(sunNow && sunNow.el > -3 ? sunNow.az : earthNow?.az ?? 0);
    setShowLayers(false); setShowCompare(false); setWelcome(false);
    setSurfaceMapOpen(false); setRoute(null);
    setSurfaceLayers({}); setSurfaceOpacity({}); setSurfacePrefer('fastest');
    roverLink.startTrail();
    setStanding(true);
  };

  useEffect(() => { if (standWhenReady && ready) { setStandWhenReady(false); stand(); } }); // eslint-disable-line react-hooks/exhaustive-deps

  const title = selection ? selectionTitle(selection, names) : '';
  const onSelect = useCallback((s: MapSelection) => {
    setSelection(s);
    if (phone) {
      setShowLayers(false); setShowCompare(false); setShowAi(false); setPhoneMore(false);
      const { lat, lon } = selectionLatLon(s);
      const view = map.current?.captureView();
      const km = view && !view.flat ? Math.max(25, (Math.hypot(...view.position) - MOON_RADIUS_M) / 1000) : 60;
      map.current?.flyTo(lat, lon, km);
    }
  }, [phone]);
  const toggleOverviewRoute = () => {
    if (routeArmed) { setRouteArmed(false); return; }
    if (!sel) return;
    setOverviewStart({ ...sel, label: title });
    setRouteArmed(true);
  };
  const chooseOverviewDestination = (lat: number, lon: number) => {
    if (!routeArmed || !overviewStart) return;
    setOverviewRoute(r => askRoute(r, overviewStart, { lat, lon, label: '' }, overviewPrefer));
  };
  const preferOverviewRoute = (prefer: RoutePrefer) => {
    setOverviewPrefer(prefer);
    setOverviewRoute(r => r ? askRoute(r, r.from, r.to, prefer) : r);
  };
  useEffect(() => {
    if (routeArmed && (!sel || !overviewStart || !sameSpot(sel, overviewStart))) setRouteArmed(false);
  }, [routeArmed, sel?.lat, sel?.lon, overviewStart]); // eslint-disable-line react-hooks/exhaustive-deps
  const overviewKey = overviewRoute ? `${overviewRoute.from.lat},${overviewRoute.from.lon},${overviewRoute.to.lat},${overviewRoute.to.lon},${overviewRoute.prefer},${mastM},${overviewRoute.ask}` : '';
  useEffect(() => {
    if (!overviewRoute) return;
    const ac = new AbortController(), ask = overviewRoute.ask;
    setOverviewRoute(r => r && r.ask === ask && r.status !== 'working' ? { ...r, status: 'working' } : r);
    planRouteAsync({ from: overviewRoute.from, to: overviewRoute.to, mastM, prefer: overviewRoute.prefer, timeMs: minuteRef.current }, ac.signal).then(
      result => setOverviewRoute(r => r && r.ask === ask && !ac.signal.aborted ? { ...r, status: 'ready', result } : r),
      err => { if (!ac.signal.aborted && (err as Error)?.name !== 'AbortError') setOverviewRoute(r => r && r.ask === ask ? { ...r, status: 'error', result: null } : r); },
    );
    return () => ac.abort();
  }, [overviewKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!standing) return;
    setRouteArmed(false);
    const carried = overviewRoute;
    if (!carried || !sel || !sameSpot(sel, carried.from)) return;
    // Once the landing frame exists, the surface planner can avoid its small craters and rocks.
    let handed = false;
    const handOver = () => {
      if (handed || landerLink.phase !== 'ready' || !roverLink.spot || !sameSpot(roverLink.spot, carried.from)) return;
      handed = true;
      setRoute({ ...carried, status: 'working', result: null, ask: carried.ask + 1 });
    };
    const off = landerLink.subscribe(handOver);
    handOver();
    return off;
  }, [standing]); // eslint-disable-line react-hooks/exhaustive-deps
  const planSurfaceRoute = (lat: number, lon: number) => {
    const p = roverLink.pose;
    if (!standing || !p.on) return;
    const from = { lat: p.lat, lon: p.lon, label: title };
    // The generic flag name follows the language switch instead of keeping the tap's language.
    const to = { lat, lon, label: '' };
    setRoute(r => askRoute(r, from, to, surfacePrefer));
  };
  // (the kind can be chosen before there is a destination: it is kept for the route that follows)
  const preferSurfaceRoute = (prefer: RoutePrefer) => {
    const p = roverLink.pose;
    setSurfacePrefer(prefer);
    setRoute(r => r && p.on ? askRoute(r, { lat: p.lat, lon: p.lon, label: title }, r.to, prefer) : r);
  };
  // The route is worked out in the background whenever its ends or what to look for change.
  const routeKey = route ? `${route.from.lat},${route.from.lon},${route.to.lat},${route.to.lon},${route.prefer},${mastM},${route.ask}` : '';
  useEffect(() => {
    if (!route) return;
    const ac = new AbortController();
    const ask = route.ask;
    planRouteAsync({ from: route.from, to: route.to, mastM, prefer: route.prefer, timeMs: minuteRef.current, spot: roverLink.spot ?? undefined }, ac.signal).then(
      result => setRoute(r => (r && r.ask === ask && !ac.signal.aborted ? { ...r, status: 'ready', result } : r)),
      err => { if (!ac.signal.aborted && (err as Error)?.name !== 'AbortError') setRoute(r => (r && r.ask === ask ? { ...r, status: 'error', result: null } : r)); },
    );
    return () => ac.abort();
  }, [routeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const routeHere = standing ? route : null;
  // "Right now" along the route follows the time bar: the Sun and Earth are looked for again at 48 places along it,
  // a moment after the time stops changing (a few milliseconds of work; the route itself does not depend on the time)
  const [routeNow, setRouteNow] = useState<{ for: RouteResult; sun: number; earth: number } | null>(null);
  const routeResult = route?.result?.ok ? route.result : null;
  useEffect(() => {
    if (!routeResult) return;
    const id = setTimeout(() => {
      const path = routeResult.path, n = path.length / 2, samples = Math.min(n, 48);
      let sun = 0, earth = 0, got = 0;
      for (let k = 0; k < samples; k++) {
        const i = samples === 1 ? 0 : Math.round(k * (n - 1) / (samples - 1));
        const pr = probeAt(path[i * 2], path[i * 2 + 1], mastM, bodies.sun, bodies.earth, minute);
        if (!pr) continue;
        got++; if (pr.sunPart > 0.001) sun++; if (pr.earthPart > 0.001) earth++;
      }
      if (got) setRouteNow({ for: routeResult, sun: sun / got, earth: earth / got });
    }, 350);
    return () => clearTimeout(id);
  }, [routeResult, minute, mastM]); // eslint-disable-line react-hooks/exhaustive-deps
  const routeView: RouteView | null = routeHere ? { status: routeHere.status, to: routeHere.to, prefer: routeHere.prefer, result: routeHere.result,
    now: routeNow && routeNow.for === routeHere.result ? { sun: routeNow.sun, earth: routeNow.earth } : null } : null;
  // The pins shown as waypoints while on the surface: where you landed, where you are going, and the Compare pins.
  // The planned route also gets a small guide a few dozen metres ahead of the rover, moved along as it drives.
  useEffect(() => {
    if (!standing || !sel) { roverLink.setWaypoints([]); return; }
    const base: Waypoint[] = [{ id: 'start', kind: 'start', lat: sel.lat, lon: sel.lon, label: t('ex.wp.start') }];
    if (routeHere) base.push({ id: 'dest', kind: 'dest', lat: routeHere.to.lat, lon: routeHere.to.lon, label: routeHere.to.label || t('ex.wp.dest') });
    for (const c of compare) if (!sameSpot(c, sel) && !(routeHere && sameSpot(c, routeHere.to))) base.push({ id: `pin-${c.id}`, kind: 'pin', lat: c.lat, lon: c.lon, label: c.label, letter: c.letter, color: c.color });
    roverLink.setWaypoints(base);
    const path = routeHere?.result?.ok ? routeHere.result.path : null;
    if (!path || path.length < 6) return;
    let last = 0, at = -1;
    return roverLink.subscribe(() => {
      const now = performance.now(), p = roverLink.pose;
      if (!p.on || now - last < 400) return;
      last = now;
      // the nearest point of the route, then about 40 m further along it
      let best = 0, bd = Infinity;
      for (let i = 0; i < path.length; i += 2) { const d = (path[i] - p.lat) ** 2 + ((path[i + 1] - p.lon) * Math.cos(p.lat * Math.PI / 180)) ** 2; if (d < bd) { bd = d; best = i; } }
      let i = best, run = 0;
      while (i + 2 < path.length && run < 40) { run += surfaceDistM(path[i], path[i + 1], path[i + 2], path[i + 3]); i += 2; }
      if (i === at) return;
      at = i;
      // (right by the destination its own marker is enough)
      const near = i + 2 >= path.length;
      roverLink.setWaypoints(near ? base : [...base, { id: 'next', kind: 'next', lat: path[i], lon: path[i + 1], label: t('ex.wp.next') }]);
    });
  }, [standing, sel?.lat, sel?.lon, routeHere?.to.lat, routeHere?.to.lon, routeHere?.result, compare, prefs.lang]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every exit is immediate. No position, route or drive is stored.
  const requestExit = useCallback(() => {
    landerLink.setWalk(false);
    setSurfaceMapOpen(false);
    setStanding(false);
    setRoute(null); setRouteNow(null);
    roverLink.setWaypoints([]);
    roverLink.startTrail();
  }, []);
  useEffect(() => {
    if (!standing) {
      setSurfaceMapOpen(false); setRoute(null); roverLink.startTrail();
      if (landerLink.phase !== 'off') {
        const off = landerLink.subscribe(() => {
          if (landerLink.phase === 'off') { roverLink.startTrail(); off(); }
        });
        return off;
      }
    }
  }, [standing]);
  const openSurfaceMap = useCallback(() => {
    // Parking clears held drive keys and releases a captured mouse before the map receives input.
    landerLink.setWalk(false);
    if (document.pointerLockElement) document.exitPointerLock();
    setSurfaceMapOpen(true);
  }, []);
  // The big surface map covers the 3D view: hold the 3D drawing still while it is open, so the map zooms smoothly.
  useEffect(() => {
    const held = standing && surfaceMapOpen;
    map.current?.setRenderPaused(held);
    return () => { if (held) map.current?.setRenderPaused(false); };
  }, [standing, surfaceMapOpen]);
  const keyState = useRef({ standing, surfaceMapOpen });
  keyState.current = { standing, surfaceMapOpen };
  useEffect(() => {
    const handle = (ev: KeyboardEvent) => {
      const state = keyState.current;
      if (!state.standing) return;
      const typing = (ev.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable], [role=slider]');
      if (ev.type === 'keydown' && !typing && ev.key.toLowerCase() === 'm' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        if (!ev.repeat) {
          if (state.surfaceMapOpen) setSurfaceMapOpen(false); else openSurfaceMap();
        }
        return;
      }
      if (state.surfaceMapOpen) {
        // Keep Tab and button activation available to the dialog, but stop surface controls even if focus escaped it.
        if (ev.key === 'Escape') {
          ev.preventDefault(); ev.stopImmediatePropagation();
          if (ev.type === 'keydown') setSurfaceMapOpen(false);
        } else if (['w', 'a', 's', 'd', 'v', 'l', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '+', '-', '=', '_'].includes(ev.key.toLowerCase())) {
          ev.stopImmediatePropagation();
        }
      }
    };
    window.addEventListener('keydown', handle, true);
    window.addEventListener('keyup', handle, true);
    return () => { window.removeEventListener('keydown', handle, true); window.removeEventListener('keyup', handle, true); };
  }, [openSurfaceMap]);
  const flyToSel = (s: Selection, tilted = false) => {
    const { lat, lon } = selectionLatLon(s);
    const d = s.type === 'name' ? s.name.diameterKm : 20;
    map.current?.flyTo(lat, lon, Math.min(2500, Math.max(25, d * 3.2)), tilted);
  };
  const pickName = (n: MoonName) => { if (phone) { setShowLayers(false); setShowCompare(false); setShowAi(false); setPhoneMore(false); } const s: Selection = { type: 'name', name: n }; setStanding(false); setSelection(s); flyToSel(s); };
  const pickPlace = (p: Place) => { if (phone) { setShowLayers(false); setShowCompare(false); setShowAi(false); setPhoneMore(false); } const s: Selection = { type: 'place', place: p }; setStanding(false); setSelection(s); flyToSel(s); };

  const inCompare = !!sel && compare.some(c => Math.abs(c.lat - sel.lat) < 1e-6 && Math.abs(c.lon - sel.lon) < 1e-6 && c.startMs === arrival);
  const addCompare = () => {
    if (!selection) return;
    const { lat, lon } = selectionLatLon(selection);
    const id = crypto.randomUUID(), label = selectionTitle(selection, names);
    setCompare(c => {
      if (c.some(item => sameSpot(item, { lat, lon }) && item.startMs === arrival)) return c;
      const index = nextPlanIndex(c);
      return [...c, { id, letter: planLetter(index), color: planColour(index), label, lat, lon, startMs: arrival }];
    });
    setShowLayers(false); setShowAi(false); setShowCompare(true);
  };
  /** The Compare button on the info panel: add this spot as a plan, or take it out again. */
  const toggleCompare = () => {
    if (!sel) return;
    if (inCompare) setCompare(c => c.filter(x => !(Math.abs(x.lat - sel.lat) < 1e-6 && Math.abs(x.lon - sel.lon) < 1e-6 && x.startMs === arrival)));
    else addCompare();
  };
  // The Layers box and the Compare drawer share the right-hand side: opening one closes the other.
  const toggleLayers = () => {
    // the south-pole maps are decoded as the box opens, so the first switch shows its map at once
    if (!showLayers) map.current?.warmLayers();
    setShowLayers(v => !v); setShowCompare(false); setShowAi(false);
  };
  const toggleCompareDrawer = () => { setShowCompare(v => !v); setShowLayers(false); setShowAi(false); };
  const toggleAi = () => { setShowAi(v => !v); setShowCompare(false); setShowLayers(false); };

  // Escape closes the top-most open thing (popovers, the search box and the lander view handle their own Escape first).
  const onEscape = useRef(() => {});
  onEscape.current = () => {
    if (standing) return;
    if (phone && phoneMore) setPhoneMore(false);
    else if (routeArmed) setRouteArmed(false);
    else if (welcome) closeWelcome();
    else if (showLayers) setShowLayers(false);
    else if (showAi) setShowAi(false);
    else if (showCompare) setShowCompare(false);
    else if (selection) setSelection(null);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape.current();
      // M: globe <-> flat map (not while typing; the map ignores it while standing on the Moon)
      const a = document.activeElement as HTMLElement | null;
      if (!keyState.current.standing && (e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey && !(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable))) {
        map.current?.setMapMode(mapModeRef.current === 'flat' ? 'globe' : 'flat');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const addCompareDate = (it: CompareItem, startMs: number) => {
    if (!Number.isFinite(startMs)) return;
    const landing = Math.min(ARRIVAL_MAX, Math.max(ARRIVAL_MIN, Math.round(startMs / 60000) * 60000));
    const id = crypto.randomUUID(), label = it.label.replace(/ \(\+\d+ days\)$/, '');
    setCompare(c => {
      if (c.some(item => sameSpot(item, it) && item.startMs === landing)) return c;
      const index = nextPlanIndex(c);
      return [...c, { ...it, id, letter: planLetter(index), color: planColour(index), label, startMs: landing }];
    });
  };
  const changeCompareDate = (it: CompareItem, startMs: number) => {
    if (!Number.isFinite(startMs)) return;
    const landing = Math.min(ARRIVAL_MAX, Math.max(ARRIVAL_MIN, Math.round(startMs / 60000) * 60000));
    setCompare(c => {
      const current = c.find(item => item.id === it.id);
      if (!current || current.startMs === landing || c.some(item => item.id !== it.id && sameSpot(item, current) && item.startMs === landing)) return c;
      return c.map(item => item.id === it.id ? { ...item, startMs: landing } : item);
    });
  };

  const pins: MapPin[] = useMemo(() => compare.map(c => ({ id: c.id, lat: c.lat, lon: c.lon, letter: c.letter, color: c.color })), [compare]);
  // Test hook (used by scripts/drive.mjs and scripts/lander-drive.mjs): jump to a spot or a time without clicking through the page.
  useEffect(() => {
    (window as unknown as { __moondaTest: unknown }).__moondaTest = {
      stand: (lat: number, lon: number) => { setSelection({ type: 'pin', lat, lon }); setStandWhenReady(true); },
      select: (lat: number, lon: number) => setSelection({ type: 'pin', lat, lon }),
      selectPlace: (id: string) => { const place = PLACES_FOR_AI.find(p => p.id === id); if (place) setSelection({ type: 'place', place }); },
      exit: requestExit,
      setTime: (ms: number) => { setPlaying(false); setCursor(ms); },
      setMast: setMastM, setDays, setArrival: setArrivalSafe, setLanguage: setLang,
      state: () => ({ standing, surfaceMapOpen, route: routeView, cursor, arrival, days, ready: !!ready, sunNow, earthNow,
        overviewRoute, routeArmed, selected: sel,
        sunPart: timeline ? Array.from(timeline.sunPart) : null, startMs: timeline?.startMs, stepMs: timeline?.stepMs }),
    };
  });

  const mapLayersHere = useMemo(() => ({ ...layers, ...surfaceLayers }), [layers, surfaceLayers]);
  const mapOpacityHere = useMemo(() => ({ ...opacity, ...surfaceOpacity }), [opacity, surfaceOpacity]);
  const activeLegends = sciencePanelLayers.filter(l => layers[l.id] && l.legend);
  const heightLegend = layers.height ? heightDef : undefined;

  const sunOn = layers.realSun !== false;
  const loading = !loadGone;
  const phoneSheetOpen = phone && !standing && !!(selection || showLayers || showCompare || showAi || phoneMore || routeArmed || overviewRoute);

  // What the AI helper can see and do in the app (its tools call these).
  const aiBridge: AppBridge = {
    places: PLACES_FOR_AI,
    names: () => names,
    manifest: () => manifest,
    mission: () => { const n = readNeeds(); return { arrivalMs: arrival, days, mastM, batteryHours: n.batteryH, contactHours: n.contactH }; },
    view: () => (selection && sel ? `selected "${title}" at ${sel.lat.toFixed(3)}, ${sel.lon.toFixed(3)}; ${compare.length} plan(s) in Compare` : `no spot selected; ${compare.length} plan(s) in Compare`),
    showOnMap: (lat, lon) => {
      const s: Selection = { type: 'pin', lat, lon };
      setStanding(false); setSelection(s); flyToSel(s, true);
    },
    addToCompare: (lat, lon, label) => {
      if (compare.some(c => Math.abs(c.lat - lat) < 1e-4 && Math.abs(c.lon - lon) < 1e-4 && c.startMs === arrival)) return `${label} is already in Compare.`;
      const id = crypto.randomUUID();
      setCompare(c => {
        if (c.some(item => Math.abs(item.lat - lat) < 1e-4 && Math.abs(item.lon - lon) < 1e-4 && item.startMs === arrival)) return c;
        const index = nextPlanIndex(c);
        return [...c, { id, letter: planLetter(index), color: planColour(index), label, lat, lon, startMs: arrival }];
      });
      return t('cmp.added', { name: label });
    },
  };

  return (
    <div className={`app${standing ? ' standing' : ''}${showCompare && !standing ? ' drawer-open' : ''}${showLayers && !standing ? ' layers-open' : ''}${showAi && !standing ? ' ai-open' : ''}${(showCompare || showLayers) && rightReach && !standing ? ' right-tall' : ''}`}>
      <MoonMap ref={map} layers={layers} opacity={opacity} scienceLayers={scienceLayers} names={names}
        selectedPin={sel} pins={pins} bodies={bodies} timeMs={minute} lander={lander} sky={standing ? sky : null}
        overviewRoute={overviewRoute?.result ?? null} routeDestination={overviewRoute?.to ?? null}
        choosingDestination={routeArmed && !standing} onRouteDestination={chooseOverviewDestination}
        onSelect={onSelect} onHover={hoverStore.set} onLoadProgress={onLoadProgress} onMapMode={setMapMode} onRenderError={setRenderError} />
      <div id="cesium-credits" hidden />

      {!standing && (
        <header className="topbar">
          <Search names={names} selected={selection ? title : null} onPickName={pickName} onPickPlace={pickPlace} />
          <nav className="toolbar" aria-label={t('top.tools')}>
            <div className="toolbar-island toolbar-goto panel">
              <button type="button" className="tb goto" onClick={() => map.current?.flyWhole()} data-tip={t('top.wholeMoon.tip')}><Moon size={16} /> {t('top.wholeMoon')}</button>
              <button type="button" className="tb goto" onClick={() => map.current?.flyPole()} data-tip={t('top.southPole.tip')}><Target size={16} /> {t('top.southPole')}</button>
            </div>
            <button type="button" className="tb toolbar-island panel" aria-pressed={showLayers} aria-expanded={showLayers} onClick={toggleLayers} data-tip={showLayers ? undefined : t('top.layers.tip')}><Stack size={18} /> {t('top.layers')}</button>
            <button type="button" className="tb toolbar-island panel" aria-pressed={showCompare} aria-expanded={showCompare} onClick={toggleCompareDrawer} data-tip={showCompare ? undefined : t('top.compare.tip')}>
              <Columns size={18} /> {t('top.compare')}{compare.length > 0 && <span className="tb-count" aria-label={t('top.plans', { n: compare.length })}>{compare.length}</span>}
            </button>
            <button type="button" className="tb lang toolbar-island panel" onClick={() => setLang(prefs.lang === 'en' ? 'km' : 'en')} data-tip={t('top.langTip')} lang={prefs.lang === 'en' ? 'km' : 'en'}>{prefs.lang === 'en' ? 'ខ្មែរ' : 'English'}</button>
            <button type="button" className="tb icon toolbar-island panel" onClick={() => settings.set({ sound: !prefs.sound })} aria-pressed={undefined} aria-label={prefs.sound ? t('top.soundOn') : t('top.soundOff')} data-tip={prefs.sound ? t('top.soundOn') : t('top.soundOff')}>
              {prefs.sound ? <SpeakerHigh size={18} /> : <SpeakerSlash size={18} />}
            </button>
            {/* the graphics mode from the start screen, switchable later too (it applies at once, src/app/quality.ts) */}
            <button type="button" className="tb icon toolbar-island panel" onClick={() => chooseQuality(prefs.quality === 'full' ? 'light' : 'full')} aria-label={t(prefs.quality === 'full' ? 'top.gfxFull' : 'top.gfxLight')} data-tip={t(prefs.quality === 'full' ? 'top.gfxFull' : 'top.gfxLight')}>
              <Gauge size={18} weight={prefs.quality === 'full' ? 'fill' : 'regular'} />
            </button>
            <button type="button" className="tb toolbar-island toolbar-tutorial panel" onClick={() => { closeWelcome(); tutorialStore.start(); }} data-tip={t('top.tutorial.tip')}>{t('top.tutorial')}</button>
            <button type="button" className="tb icon toolbar-island panel" onClick={() => setWelcome('intro')} aria-label={t('top.help')} data-tip={t('top.help')}><Question size={18} /></button>
          </nav>
          {phone && <nav className="phone-toolbar panel" aria-label={t('top.tools')}>
            <button type="button" aria-pressed={showLayers} aria-expanded={showLayers} onClick={() => { setPhoneMore(false); toggleLayers(); }}>
              <Stack size={21} /><span>{t('top.layers')}</span>
            </button>
            <button type="button" aria-pressed={showCompare} aria-expanded={showCompare} onClick={() => { setPhoneMore(false); toggleCompareDrawer(); }}>
              <Columns size={21} /><span>{t('top.compare')}</span>{compare.length > 0 && <b className="phone-tool-count">{compare.length}</b>}
            </button>
            <button type="button" aria-label={t('ai.title')} aria-pressed={showAi} aria-expanded={showAi} onClick={() => { setPhoneMore(false); toggleAi(); }}>
              <AiMark size={21} /><span>MOONDA AI</span>
            </button>
            <button type="button" aria-label={t(sel ? 'route.button' : 'route.pickFirst')} aria-pressed={routeArmed} disabled={!sel}
              onClick={() => { setPhoneMore(false); setShowLayers(false); setShowCompare(false); setShowAi(false); toggleOverviewRoute(); }}>
              <Path size={21} /><span>{t('route.title')}</span>
            </button>
            <button type="button" aria-label={t('top.tools')} aria-expanded={phoneMore} aria-pressed={phoneMore}
              onClick={() => { setShowLayers(false); setShowCompare(false); setShowAi(false); setPhoneMore(v => !v); }}>
              <DotsThree size={23} weight="bold" /><span>{prefs.lang === 'en' ? 'More' : 'ផ្សេងទៀត'}</span>
            </button>
          </nav>}
          {phone && phoneMore && <section className="phone-more panel" role="dialog" aria-label={t('top.tools')}>
            <header><h2>{t('top.tools')}</h2><button type="button" aria-label={t('common.close')} onClick={() => setPhoneMore(false)}><X size={20} /></button></header>
            <button type="button" onClick={() => { setPhoneMore(false); setSelection(null); map.current?.flyWhole(); }}><Moon size={20} />{t('top.wholeMoon')}</button>
            <button type="button" onClick={() => { setPhoneMore(false); setSelection(null); map.current?.flyPole(); }}><Target size={20} />{t('top.southPole')}</button>
            <button type="button" onClick={() => setLang(prefs.lang === 'en' ? 'km' : 'en')} lang={prefs.lang === 'en' ? 'km' : 'en'}>{prefs.lang === 'en' ? 'ខ្មែរ' : 'English'}</button>
            <button type="button" aria-pressed={prefs.sound} aria-label={t(prefs.sound ? 'top.soundOn' : 'top.soundOff')} onClick={() => settings.set({ sound: !prefs.sound })}>{prefs.sound ? <SpeakerHigh size={20} /> : <SpeakerSlash size={20} />}{t('start.music')}</button>
            <button type="button" aria-label={t(prefs.quality === 'full' ? 'top.gfxFull' : 'top.gfxLight')} onClick={() => chooseQuality(prefs.quality === 'full' ? 'light' : 'full')}><Gauge size={20} />{t('start.graphics')}: {t(`start.mode.${prefs.quality}`)}</button>
            <button type="button" onClick={() => { setPhoneMore(false); closeWelcome(); tutorialStore.start(); }}>{t('top.tutorial')}</button>
            <button type="button" onClick={() => { setPhoneMore(false); setWelcome('intro'); }}><Question size={20} />{t('top.help')}</button>
          </section>}
        </header>
      )}

      {selection && !standing && !(phone && (showLayers || showCompare || showAi || phoneMore || routeArmed || overviewRoute)) && (
        <PlaceCard selection={selection} names={names} spot={shown ?? spot} stale={stale} cursor={cursor} days={days} mastM={mastM}
          science={manifest} scienceValues={scienceValues} inCompare={inCompare}
          onMast={setMastM} onSeek={setCursor} onClose={() => setSelection(null)} onZoom={() => flyToSel(selection, true)} onCompare={toggleCompare} onStand={stand} />
      )}

      {standing && selection && (
        <LanderHud name={title} sun={sunNow} earth={earthNow} earthNeverRises={earthNever} mastM={mastM} timeline={timeline} cursor={cursor}
          onLook={(az, el) => map.current?.look(az, el)} onExit={requestExit}
          layers={mapLayersHere} opacity={mapOpacityHere} layerDefs={panelGroups(scienceLayers, { ...heightDef, rasterSources: scienceLayers.find(l => l.id === 'height')?.rasterSources })[0].layers}
          bodies={bodies} timeKey={minute} route={routeHere?.result?.ok ? routeHere.result : null} names={names} onOpenMap={openSurfaceMap} />
      )}
      {standing && surfaceMapOpen && (
        <SurfaceMap placeName={title} bodies={bodies} timeKey={minute} mastM={mastM} names={names}
          layers={mapLayersHere} opacity={mapOpacityHere} layerDefs={panelGroups(scienceLayers, { ...heightDef, rasterSources: scienceLayers.find(l => l.id === 'height')?.rasterSources })[0].layers}
          onLayersChange={change => setSurfaceLayers(cur => { const all = { ...layers, ...cur }, next = typeof change === 'function' ? change(all) : change; return Object.fromEntries(Object.entries(next).filter(([id, on]) => on !== !!layers[id])); })}
          onOpacityChange={change => setSurfaceOpacity(cur => { const all = { ...opacity, ...cur }; return typeof change === 'function' ? change(all) : change; })}
          route={routeView} prefer={surfacePrefer} onClose={() => setSurfaceMapOpen(false)} onPlan={planSurfaceRoute}
          onPrefer={preferSurfaceRoute} onClear={() => setRoute(null)} />
      )}

      {showLayers && !standing && (
        <LayersPanel
          groups={panelGroups(scienceLayers, heightDef)}
          state={layers} opacity={opacity}
          onToggle={(id, on) => setLayers(l => ({ ...l, [id]: on }))}
          onOpacity={(id, v) => setOpacity(o => ({ ...o, [id]: v }))}
          onClose={() => setShowLayers(false)} onReach={setRightReach} />
      )}

      {!showLayers && !standing && (activeLegends.length > 0 || heightLegend) && (
        <div className="legend-float panel" aria-label={t('map.colours')}>
          {/* each key can switch its own map off: the key is often the only sign that a map is on at all */}
          {[...(heightLegend ? [heightLegend] : []), ...activeLegends].map(l => <div key={l.id} className="legend-item">
            <b>{layerTitle(l)}<button type="button" className="legend-hide" aria-label={t('map.legend.hide', { name: layerTitle(l) })} data-tip={t('map.legend.hide', { name: layerTitle(l) })}
              onClick={() => setLayers(cur => ({ ...cur, [l.id]: false }))}><X size={13} /></button></b>
            <LayerLegend layer={l} />
          </div>)}
        </div>
      )}

      {showCompare && !standing && (
        <Compare items={compare} entries={compareEntries} days={days} elapsedFrac={(cursor - arrival) / (days * 86400000)}
          currentLabel={selection ? title : null} canAddCurrent={!!selection && !inCompare} onAddCurrent={addCompare}
          onRemove={id => setCompare(c => c.filter(x => x.id !== id))} onAddDate={addCompareDate} onChangeDate={changeCompareDate}
          onFocus={it => { setSelection({ type: 'pin', lat: it.lat, lon: it.lon }); map.current?.flyTo(it.lat, it.lon, 40, true); }}
          onStand={it => { setSelection({ type: 'pin', lat: it.lat, lon: it.lon }); setArrivalSafe(it.startMs); setStandWhenReady(true); }}
          onClose={() => setShowCompare(false)} onReach={setRightReach} />
      )}

      {!standing && (
        <MapControls sunOn={sunOn} onSun={on => setLayers(l => ({ ...l, realSun: on }))} aiOpen={showAi} aiBusy={aiBusy && !showAi} onAi={toggleAi}
          onNorth={() => map.current?.resetNorth()} mapMode={mapMode} onMapMode={m => map.current?.setMapMode(m)} onZoom={f => map.current?.zoomBy(f)} />
      )}
      {aiMounted && <AiPanel bridge={aiBridge} hidden={!showAi || standing} onClose={() => setShowAi(false)} onBusy={setAiBusy} />}

      {!standing && <>
        <OverviewRouteButton selected={!!sel} armed={routeArmed} onClick={toggleOverviewRoute} />
        {!(phone && (showLayers || showCompare || showAi || phoneMore)) && <RouteTool route={overviewRoute?.result ?? null} busy={overviewRoute?.status === 'working'} failed={overviewRoute?.status === 'error'}
          prefer={overviewPrefer} armed={routeArmed} onPrefer={preferOverviewRoute}
          onClear={() => { setOverviewRoute(null); setRouteArmed(false); }} />}
      </>}

      <TimeBar key={phoneSheetOpen ? 'phone-sheet' : 'map'} arrival={arrival} days={days} cursor={cursor} playing={playing} speed={speed} timeline={timeline}
        loading={spot?.status === 'loading' && !shown} spotLabel={null}
        onArrival={setArrivalSafe} onDays={setDays} onCursor={setCursor} onPlaying={setPlaying} onSpeed={setSpeed} />
      <StatusLine names={names} standingAt={standing && sel ? { lat: sel.lat, lon: sel.lon, label: title } : null} onCredits={() => setWelcome('sources')} />

      {welcome && !loading && (
        <Welcome showSources={welcome === 'sources'} onClose={closeWelcome}
          onPole={() => { closeWelcome(); map.current?.flyPole(); }} onExplore={() => { closeWelcome(); map.current?.flyWhole(); }} />
      )}
      {loading && <StartScreen progress={load} leaving={entered && load.done} onEnter={enterApp} onSkip={skipLoading} />}
      {(renderError || contextLost) && <RenderStopped message={renderError ?? ''} contextLost={contextLost} />}
    </div>
  );
}
