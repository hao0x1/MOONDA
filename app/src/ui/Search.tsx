import { MagnifyingGlass, MapPin, Mountains, Rocket, X } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatLatLon, searchNames, type MoonName } from '../data/names';
import { PLACES, type Place } from '../data/places';
import { tMaybe, useT } from '../i18n';
import { IconButton, Wordmark } from './kit';

interface Props {
  names: MoonName[] | null;
  /** Name of what is selected on the map right now (null = nothing): the box forgets an old search once the selection moves on. */
  selected: string | null;
  onPickName(n: MoonName): void;
  onPickPlace(p: Place): void;
}

type Hit = { kind: 'place'; place: Place } | { kind: 'name'; name: MoonName };

/** The top-left pill: the MOONDA mark and the search box in one piece, as wide as the info panel below it. */
export function Search({ names, selected, onPickName, onPickPlace }: Props) {
  const t = useT();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const picked = useRef<string | null>(null); // the name last chosen from the list
  // The map selection changed to something that was not picked here: an old search text would be misleading.
  useEffect(() => {
    if (picked.current !== null && selected !== picked.current && document.activeElement !== input.current) { picked.current = null; setQ(''); }
  }, [selected]);
  const hits = useMemo<Hit[]>(() => {
    const text = q.trim().toLowerCase();
    if (!text) return [];
    const places: Hit[] = PLACES.filter(p => p.name.toLowerCase().includes(text)).slice(0, 4).map(place => ({ kind: 'place', place }));
    const ns: Hit[] = names ? searchNames(names, q, 8 - places.length).map(name => ({ kind: 'name', name })) : [];
    return [...places, ...ns];
  }, [q, names]);

  const choose = (h: Hit) => {
    if (h.kind === 'place') onPickPlace(h.place); else onPickName(h.name);
    const name = h.kind === 'place' ? h.place.name : h.name.name;
    picked.current = name;
    setOpen(false); setQ(name);
    (document.activeElement as HTMLElement | null)?.blur();
  };
  const showList = open && q.trim().length > 0;
  /** The small grey line under a result: what kind of place it is. */
  const subLine = (h: Hit) => {
    if (h.kind === 'name') return `${tMaybe(`kind.${h.name.kind}`, h.name.kind)}${h.name.diameterKm ? ` · ${Math.round(h.name.diameterKm)} km` : ''}`;
    if (h.place.kind === 'artemis') return t('search.sub.artemis');
    if (h.place.kind === 'spot') return t('place.kind.spot');
    if (h.place.kind === 'ice') return t('search.sub.ice');
    if (h.place.kind === 'planned') return t('search.sub.planned', { date: h.place.date ?? '' });
    if (h.place.what === 'impact') return t('search.sub.impact', { date: h.place.date ?? '' });
    return t('search.sub.landing', { date: h.place.date ?? '' });
  };

  return (
    <div className="search">
      <div className="searchbar panel">
        <div className="brand"><Wordmark /></div>
        <MagnifyingGlass size={16} className="search-icon" aria-hidden="true" />
        <input ref={input} value={q} placeholder={t('search.placeholder')} aria-label={t('search.placeholder')} data-tip={showList ? undefined : t('search.tip')}
          role="combobox" aria-expanded={showList && hits.length > 0} aria-controls="search-results" aria-autocomplete="list"
          onChange={e => { picked.current = null; setQ(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { setActive(a => Math.min(hits.length - 1, a + 1)); e.preventDefault(); }
            if (e.key === 'ArrowUp') { setActive(a => Math.max(0, a - 1)); e.preventDefault(); }
            if (e.key === 'Enter' && hits[active]) choose(hits[active]);
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); (e.target as HTMLInputElement).blur(); }
          }} />
        {q && <IconButton label={t('search.clear')} size="sm" onClick={() => { picked.current = null; setQ(''); setOpen(false); input.current?.focus(); }}><X size={15} /></IconButton>}
      </div>
      {showList && (
        <div className="search-results panel" id="search-results" role="listbox">
          {hits.length === 0 && <div className="search-none">{t('search.none', { q: q.trim() })}</div>}
          {hits.map((h, i) => (
            <button key={h.kind === 'place' ? h.place.id : h.name.idx} type="button" role="option" aria-selected={i === active} className="result"
              data-tip={t('search.result.tip', { name: h.kind === 'place' ? h.place.name : h.name.name })}
              onMouseDown={e => e.preventDefault()} onClick={() => choose(h)} onMouseEnter={() => setActive(i)}>
              <span className="result-icon">{h.kind === 'place' ? (h.place.kind === 'artemis' ? <MapPin weight="fill" color="var(--artemis)" /> : h.place.kind === 'spot' ? <MapPin weight="fill" color="var(--sun)" /> : <Rocket />) : <Mountains />}</span>
              <span className="result-text">
                <span className="result-name">{h.kind === 'place' ? h.place.name : h.name.name}</span>
                <span className="result-sub">
                  {subLine(h)}
                  {' · '}{formatLatLon(h.kind === 'place' ? h.place.lat : h.name.lat, h.kind === 'place' ? h.place.lon : h.name.lon, 1)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
