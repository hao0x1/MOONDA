import { Columns, Question, SpeakerHigh, SpeakerSlash, Stack } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { settings } from './app/settings';
import { loadNames, type MoonName } from './data/names';
import { PLACES as PLACES_FOR_AI, type Place } from './data/places';
import { installLang, setLang, useT } from './i18n';
import { BASE_LAYERS, layerTitle, MARKER_LAYERS, scienceToLayer, type ScienceManifestEntry } from './moon/layers';
import { initialProgress } from './moon/preload';
import { MoonMap, type LoadProgress, type MapPin, type MapSelection, type MoonMapHandle } from './moon/MoonMap';
import { useSpot, useSpots, warmUp } from './science/client';
import { bodyFixedState } from './science/ephemeris';
import { loadManifest, useLayerValues } from './science/layerValues';
import type { AppBridge } from './ai/tools';
import { AiPanel } from './ui/AiPanel';
import { BATTERY_OPTIONS, Compare, CONTACT_OPTIONS, type CompareItem } from './ui/Compare';
import { LanderHud } from './ui/LanderHud';
import { LayersPanel, Legend } from './ui/LayersPanel';
import { StartScreen } from './ui/StartScreen';
import { MapControls } from './ui/MapControls';
import { ARRIVAL_MAX, ARRIVAL_MIN } from './ui/parseDate';
import { PlaceCard, selectionLatLon, selectionTitle, type Selection } from './ui/PlaceCard';
import { Search } from './ui/Search';
import { StatusLine } from './ui/StatusLine';
import { hoverStore } from './ui/stores';
import { TimeBar } from './ui/TimeBar';
import { installTips } from './ui/tips';
import { Welcome } from './ui/Welcome';

const COLORS = ['#a99ee8', '#d4b483', '#de94b6', '#82c2b3']; // quiet rings: lavender, sand, rose, sage
const LETTERS = ['A', 'B', 'C', 'D'];
const DEFAULT_ARRIVAL = Date.UTC(2026, 10, 18, 2, 0);

export default function App() {
  const map = useRef<MoonMapHandle>(null);
  const t = useT();
  const prefs = settings.use();
  useEffect(() => installLang(), []);
  const [names, setNames] = useState<MoonName[] | null>(null);
  const [manifest, setManifest] = useState<ScienceManifestEntry[]>([]);
  useEffect(() => { loadNames().then(setNames); loadManifest().then(setManifest); }, []);
  const scienceLayers = useMemo(() => manifest.map(scienceToLayer), [manifest]);
  const sciencePanelLayers = useMemo(() => scienceLayers.filter(l => l.id !== 'height'), [scienceLayers]);
  const heightDef = useMemo(() => {
    const base = BASE_LAYERS.find(l => l.id === 'height')!;
    const polar = scienceLayers.find(l => l.id === 'height');
    return polar ? { ...base, legend: polar.legend, units: polar.units } : base;
  }, [scienceLayers]);

  const [layers, setLayers] = useState<Record<string, boolean>>(() => Object.fromEntries([...BASE_LAYERS, ...MARKER_LAYERS].map(l => [l.id, l.defaultOn])));
  const [opacity, setOpacity] = useState<Record<string, number>>({});
  const [showLayers, setShowLayers] = useState(false);
  const [mapMode, setMapMode] = useState<'globe' | 'flat'>('globe');
  const mapModeRef = useRef(mapMode);
  useEffect(() => { mapModeRef.current = mapMode; }, [mapMode]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [arrival, setArrival] = useState(DEFAULT_ARRIVAL);
  const [days, setDays] = useState(14);
  const [cursor, setCursor] = useState(DEFAULT_ARRIVAL);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(6);
  const [mastM, setMastM] = useState(2);
  const [compare, setCompare] = useState<CompareItem[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [aiMounted, setAiMounted] = useState(false);   // once opened, the AI panel stays alive (hidden) so a running answer and the chat survive closing it
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => { if (showAi) setAiMounted(true); }, [showAi]);
  const [rightReach, setRightReach] = useState(false); // the box on the right reaches down to the map controls
  const [standing, setStanding] = useState(false);
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
  const bodies = useMemo(() => bodyFixedState(minute), [minute]);
  const ci = timeline ? Math.min(timeline.count - 1, Math.max(0, Math.round((cursor - timeline.startMs) / timeline.stepMs))) : 0;
  const sunNow = timeline ? { el: timeline.sunEl[ci], sky: timeline.sunSky[ci], part: timeline.sunPart[ci], az: timeline.sunAz[ci] } : null;
  const earthNow = timeline ? { el: timeline.earthEl[ci], sky: timeline.earthSky[ci], part: timeline.earthPart[ci], az: timeline.earthAz[ci] } : null;
  const earthNever = timeline ? Array.from(timeline.earthEl).every(v => v < 0) : false;
  const sky = useMemo(() => ({ sun: bodies.sun, earth: bodies.earth, sunPart: sunNow?.part ?? null, earthUp: earthNow ? earthNow.el > earthNow.sky : null }),
    [bodies, sunNow?.part, earthNow?.el, earthNow?.sky]); // eslint-disable-line react-hooks/exhaustive-deps

  const [faceAz, setFaceAz] = useState(0);
  const landerLive = useMemo(() => (standing && ready && sel ? { lat: sel.lat, lon: sel.lon, groundM: ready.horizon.groundM, mastM, skyline: ready.horizon, faceAz } : null),
    [standing, ready, sel?.lat, sel?.lon, mastM, faceAz]); // eslint-disable-line react-hooks/exhaustive-deps
  // While standing, a new arrival date / mission length makes the worker recalculate for a moment:
  // keep the view we have instead of dropping back to the map and fading in again.
  const lastLander = useRef(landerLive);
  if (landerLive) lastLander.current = landerLive; else if (!standing) lastLander.current = null;
  const lander = standing ? (landerLive ?? lastLander.current) : null;
  useEffect(() => { if (standing && !selection) setStanding(false); }, [standing, selection]);

  const [standWhenReady, setStandWhenReady] = useState(false);
  const stand = () => {
    if (!ready) { setStandWhenReady(true); return; }
    setFaceAz(sunNow && sunNow.el > -3 ? sunNow.az : earthNow?.az ?? 0);
    setShowLayers(false); setShowCompare(false); setWelcome(false);
    setStanding(true);
  };

  useEffect(() => { if (standWhenReady && ready) { setStandWhenReady(false); stand(); } }); // eslint-disable-line react-hooks/exhaustive-deps

  const onSelect = useCallback((s: MapSelection) => setSelection(s), []);
  const flyToSel = (s: Selection, tilted = false) => {
    const { lat, lon } = selectionLatLon(s);
    const d = s.type === 'name' ? s.name.diameterKm : 20;
    map.current?.flyTo(lat, lon, Math.min(2500, Math.max(25, d * 3.2)), tilted);
  };
  const pickName = (n: MoonName) => { const s: Selection = { type: 'name', name: n }; setStanding(false); setSelection(s); flyToSel(s); };
  const pickPlace = (p: Place) => { const s: Selection = { type: 'place', place: p }; setStanding(false); setSelection(s); flyToSel(s); };

  const nextLetter = () => { const used = new Set(compare.map(c => c.letter)); return LETTERS.findIndex(l => !used.has(l)); };
  const inCompare = !!sel && compare.some(c => Math.abs(c.lat - sel.lat) < 1e-6 && Math.abs(c.lon - sel.lon) < 1e-6 && c.startMs === arrival);
  const addCompare = () => {
    if (!selection || compare.length >= 4 || inCompare) return;
    const { lat, lon } = selectionLatLon(selection);
    const i = nextLetter();
    setCompare(c => [...c, { id: `${Date.now()}`, letter: LETTERS[i], color: COLORS[i], label: selectionTitle(selection, names), lat, lon, startMs: arrival }]);
    setShowLayers(false); setShowAi(false); setShowCompare(true);
  };
  /** The Compare button on the info panel: add this spot as a plan, or take it out again. */
  const toggleCompare = () => {
    if (!sel) return;
    if (inCompare) setCompare(c => c.filter(x => !(Math.abs(x.lat - sel.lat) < 1e-6 && Math.abs(x.lon - sel.lon) < 1e-6 && x.startMs === arrival)));
    else addCompare();
  };
  // The Layers box and the Compare drawer share the right-hand side: opening one closes the other.
  const toggleLayers = () => { setShowLayers(v => !v); setShowCompare(false); setShowAi(false); };
  const toggleCompareDrawer = () => { setShowCompare(v => !v); setShowLayers(false); setShowAi(false); };
  const toggleAi = () => { setShowAi(v => !v); setShowCompare(false); setShowLayers(false); };

  // Escape closes the top-most open thing (popovers, the search box and the lander view handle their own Escape first).
  const onEscape = useRef(() => {});
  onEscape.current = () => {
    if (standing) return;
    if (welcome) closeWelcome();
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
      if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey && !(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable))) {
        map.current?.setMapMode(mapModeRef.current === 'flat' ? 'globe' : 'flat');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const delayCompare = (it: CompareItem) => {
    if (compare.length >= 4) return;
    const i = nextLetter();
    setCompare(c => [...c, { ...it, id: `${Date.now()}`, letter: LETTERS[i], color: COLORS[i], label: `${it.label.replace(/ \(\+\d+ days\)$/, '')} (+3 days)`, startMs: it.startMs + 72 * 3600000 }]);
  };

  const pins: MapPin[] = useMemo(() => compare.map(c => ({ id: c.id, lat: c.lat, lon: c.lon, letter: c.letter, color: c.color })), [compare]);
  // Test hook (used by scripts/drive.mjs and scripts/lander-drive.mjs): jump to a spot or a time without clicking through the page.
  useEffect(() => {
    (window as unknown as { __moondaTest: unknown }).__moondaTest = {
      stand: (lat: number, lon: number) => { setSelection({ type: 'pin', lat, lon }); setStandWhenReady(true); },
      select: (lat: number, lon: number) => setSelection({ type: 'pin', lat, lon }),
      exit: () => setStanding(false),
      setTime: (ms: number) => { setPlaying(false); setCursor(ms); },
      setMast: setMastM, setDays, setArrival: setArrivalSafe,
      state: () => ({ standing, cursor, arrival, days, ready: !!ready, sunNow, earthNow,
        sunPart: timeline ? Array.from(timeline.sunPart) : null, startMs: timeline?.startMs, stepMs: timeline?.stepMs }),
    };
  });

  const activeLegends = sciencePanelLayers.filter(l => layers[l.id] && l.legend);
  const heightLegend = layers.height ? heightDef : undefined;
  const title = selection ? selectionTitle(selection, names) : '';

  const sunOn = layers.realSun !== false;
  const loading = !loadGone;

  // What the AI helper can see and do in the app (its tools call these).
  const aiBridge: AppBridge = {
    places: PLACES_FOR_AI,
    names: () => names,
    manifest: () => manifest,
    mission: () => {
      let need: [number, number] = [1, 1];
      try { const v = JSON.parse(localStorage.getItem('moonda.compare.needs') ?? ''); if (Array.isArray(v) && v.length === 2) need = [v[0], v[1]]; } catch { /* default needs */ }
      return { arrivalMs: arrival, days, mastM, batteryHours: BATTERY_OPTIONS[need[0]]?.hours ?? 72, contactHours: CONTACT_OPTIONS[need[1]]?.hours ?? 24 };
    },
    view: () => (selection && sel ? `selected "${title}" at ${sel.lat.toFixed(3)}, ${sel.lon.toFixed(3)}; ${compare.length} plan(s) in Compare` : `no spot selected; ${compare.length} plan(s) in Compare`),
    showOnMap: (lat, lon) => {
      const s: Selection = { type: 'pin', lat, lon };
      setStanding(false); setSelection(s); flyToSel(s, true);
    },
    addToCompare: (lat, lon, label) => {
      if (compare.length >= 4) return 'Compare already has 4 plans: remove one first.';
      if (compare.some(c => Math.abs(c.lat - lat) < 1e-4 && Math.abs(c.lon - lon) < 1e-4 && c.startMs === arrival)) return `${label} is already in Compare.`;
      const i = nextLetter();
      setCompare(c => [...c, { id: `${Date.now()}-${i}`, letter: LETTERS[i], color: COLORS[i], label, lat, lon, startMs: arrival }]);
      return `Added ${label} to Compare as plan ${LETTERS[i]}.`;
    },
  };

  return (
    <div className={`app${standing ? ' standing' : ''}${showCompare && !standing ? ' drawer-open' : ''}${showLayers && !standing ? ' layers-open' : ''}${showAi && !standing ? ' ai-open' : ''}${(showCompare || showLayers) && rightReach && !standing ? ' right-tall' : ''}`}>
      <MoonMap ref={map} layers={layers} opacity={opacity} scienceLayers={scienceLayers} names={names}
        selectedPin={sel} pins={pins} bodies={bodies} timeMs={minute} lander={lander} sky={standing ? sky : null}
        onSelect={onSelect} onHover={hoverStore.set} onLoadProgress={onLoadProgress} onMapMode={setMapMode} />
      <div id="cesium-credits" hidden />

      {!standing && (
        <header className="topbar">
          <Search names={names} selected={selection ? title : null} onPickName={pickName} onPickPlace={pickPlace} />
          <nav className="toolbar panel" aria-label={t('top.tools')}>
            <button type="button" className="tb goto" onClick={() => map.current?.flyWhole()}>{t('top.wholeMoon')}</button>
            <button type="button" className="tb goto" onClick={() => map.current?.flyPole()}>{t('top.southPole')}</button>
            <span className="toolbar-sep goto" aria-hidden="true" />
            <button type="button" className="tb" aria-pressed={showLayers} aria-expanded={showLayers} onClick={toggleLayers}><Stack size={18} /> {t('top.layers')}</button>
            <button type="button" className="tb" aria-pressed={showCompare} aria-expanded={showCompare} onClick={toggleCompareDrawer}>
              <Columns size={18} /> {t('top.compare')}{compare.length > 0 && <span className="tb-count" aria-label={t('top.plans', { n: compare.length })}>{compare.length}</span>}
            </button>
            <span className="toolbar-sep" aria-hidden="true" />
            <button type="button" className="tb lang" onClick={() => setLang(prefs.lang === 'en' ? 'km' : 'en')} data-tip={t('top.langTip')} lang={prefs.lang === 'en' ? 'km' : 'en'}>{prefs.lang === 'en' ? 'ខ្មែរ' : 'English'}</button>
            <button type="button" className="tb icon" onClick={() => settings.set({ sound: !prefs.sound })} aria-pressed={undefined} aria-label={prefs.sound ? t('top.soundOn') : t('top.soundOff')} data-tip={prefs.sound ? t('top.soundOn') : t('top.soundOff')}>
              {prefs.sound ? <SpeakerHigh size={18} /> : <SpeakerSlash size={18} />}
            </button>
            <button type="button" className="tb icon" onClick={() => setWelcome('intro')} aria-label={t('top.help')} data-tip={t('top.help')}><Question size={18} /></button>
          </nav>
        </header>
      )}

      {selection && !standing && (
        <PlaceCard selection={selection} names={names} spot={shown ?? spot} stale={stale} cursor={cursor} days={days} mastM={mastM}
          science={manifest} scienceValues={scienceValues} canCompare={compare.length < 4} inCompare={inCompare}
          onMast={setMastM} onClose={() => setSelection(null)} onZoom={() => flyToSel(selection, true)} onCompare={toggleCompare} onStand={stand} onPickName={pickName} />
      )}

      {standing && selection && (
        <LanderHud name={title} sun={sunNow} earth={earthNow} earthNeverRises={earthNever} mastM={mastM} timeline={timeline} cursor={cursor}
          onLook={(az, el) => map.current?.look(az, el)} onExit={() => setStanding(false)} />
      )}

      {showLayers && !standing && (
        <LayersPanel
          groups={[
            { title: 'Map', layers: BASE_LAYERS.map(l => (l.id === 'height' ? heightDef : l)) },
            { title: 'South-pole science maps', note: 'Long-term averages from NASA data, south of 80° S.', layers: sciencePanelLayers },
            { title: 'Markers', layers: MARKER_LAYERS },
          ]}
          state={layers} opacity={opacity}
          onToggle={(id, on) => setLayers(l => ({ ...l, [id]: on }))}
          onOpacity={(id, v) => setOpacity(o => ({ ...o, [id]: v }))}
          onClose={() => setShowLayers(false)} onReach={setRightReach} />
      )}

      {!showLayers && !standing && (activeLegends.length > 0 || heightLegend) && (
        <div className="legend-float panel" aria-label={t('map.colours')}>
          {heightLegend && <div className="legend-item"><b>{layerTitle(heightLegend)}</b><Legend stops={heightLegend.legend!} units={heightLegend.units} /></div>}
          {activeLegends.map(l => <div key={l.id} className="legend-item"><b>{layerTitle(l)}</b><Legend stops={l.legend!} units={l.units} /></div>)}
        </div>
      )}

      {showCompare && !standing && (
        <Compare items={compare} entries={compareEntries} days={days} elapsedFrac={(cursor - arrival) / (days * 86400000)}
          currentLabel={selection ? title : null} canAddCurrent={!!selection && !inCompare} onAddCurrent={addCompare}
          onRemove={id => setCompare(c => c.filter(x => x.id !== id))} onDelay={delayCompare}
          onFocus={it => { setSelection({ type: 'pin', lat: it.lat, lon: it.lon }); map.current?.flyTo(it.lat, it.lon, 40, true); }}
          onStand={it => { setSelection({ type: 'pin', lat: it.lat, lon: it.lon }); setArrivalSafe(it.startMs); setStandWhenReady(true); }}
          onClose={() => setShowCompare(false)} onReach={setRightReach} />
      )}

      {!standing && (
        <MapControls sunOn={sunOn} onSun={on => setLayers(l => ({ ...l, realSun: on }))} aiOpen={showAi} aiBusy={aiBusy && !showAi} onAi={toggleAi}
          onNorth={() => map.current?.resetNorth()} mapMode={mapMode} onMapMode={m => map.current?.setMapMode(m)} onZoom={f => map.current?.zoomBy(f)} />
      )}
      {aiMounted && <AiPanel bridge={aiBridge} hidden={!showAi || standing} onClose={() => setShowAi(false)} onBusy={setAiBusy} />}

      <TimeBar arrival={arrival} days={days} cursor={cursor} playing={playing} speed={speed} timeline={timeline}
        loading={spot?.status === 'loading' && !shown} spotLabel={null}
        onArrival={setArrivalSafe} onDays={setDays} onCursor={setCursor} onPlaying={setPlaying} onSpeed={setSpeed} />
      <StatusLine names={names} standingAt={standing && sel ? { lat: sel.lat, lon: sel.lon, label: title } : null} onCredits={() => setWelcome('sources')} />

      {welcome && !loading && (
        <Welcome showSources={welcome === 'sources'} onClose={closeWelcome}
          onPole={() => { closeWelcome(); map.current?.flyPole(); }} onExplore={() => { closeWelcome(); map.current?.flyWhole(); }} />
      )}
      {loading && <StartScreen progress={load} leaving={entered && load.done} onEnter={enterApp} onSkip={skipLoading} />}
    </div>
  );
}
