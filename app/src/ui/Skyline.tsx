// "What the lander sees": a 360° strip of the skyline, with the paths the Sun and Earth
// take across the sky during the mission. Where a path dips behind the grey hills, that
// body is blocked.

import { useT } from '../i18n';
import type { SpotTimeline } from '../science/analysis';
import type { HorizonResult } from '../science/terrain';

interface Props { horizon: HorizonResult; timeline: SpotTimeline; cursorIndex: number; height?: number }

export function Skyline({ horizon, timeline, cursorIndex, height = 190 }: Props) {
  const t = useT();
  const W = 720, H = height, padL = 30, padB = 20, padT = 10;
  const sky = horizon.elevations;
  let lo = Infinity, hi = -Infinity;
  for (const v of sky) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let i = 0; i < timeline.count; i++) {
    lo = Math.min(lo, timeline.sunEl[i], timeline.earthEl[i]);
    hi = Math.max(hi, timeline.sunEl[i], timeline.earthEl[i]);
  }
  lo = Math.max(-12, Math.floor(lo - 0.5));
  hi = Math.min(35, Math.ceil(hi + 1));
  const x = (az: number) => padL + (az / 360) * (W - padL);
  const y = (el: number) => padT + ((hi - el) / (hi - lo)) * (H - padT - padB);

  let ground = `M ${x(0)} ${H - padB}`;
  for (let i = 0; i < sky.length; i++) ground += ` L ${x(i * horizon.stepDeg).toFixed(1)} ${y(sky[i]).toFixed(1)}`;
  ground += ` L ${x(360)} ${y(sky[0]).toFixed(1)} L ${x(360)} ${H - padB} Z`;

  const path = (az: Float32Array, el: Float32Array) => {
    let d = '';
    const step = Math.max(1, Math.floor(timeline.count / 700));
    for (let i = 0; i < timeline.count; i += step) {
      const jump = i > 0 && Math.abs(az[i] - az[Math.max(0, i - step)]) > 180;
      d += `${d === '' || jump ? 'M' : 'L'} ${x(az[i]).toFixed(1)} ${y(el[i]).toFixed(1)} `;
    }
    return d;
  };
  const ticks: number[] = [];
  const tickStep = hi - lo > 20 ? 5 : hi - lo > 8 ? 2 : 1;
  for (let v = Math.ceil(lo / tickStep) * tickStep; v <= hi; v += tickStep) ticks.push(v);
  const c = Math.min(timeline.count - 1, Math.max(0, cursorIndex));
  const sunUp = timeline.sunEl[c] > timeline.sunSky[c];
  const earthUp = timeline.earthEl[c] > timeline.earthSky[c];

  return (
    <svg className="skyline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('skyline.aria')}>
      <defs>
        <linearGradient id="hill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#5b616d" /><stop offset="1" stopColor="#22252c" /></linearGradient>
        <clipPath id="plot"><rect x={padL} y={padT} width={W - padL} height={H - padT - padB} /></clipPath>
      </defs>
      {ticks.map(v => (
        <g key={v}>
          <line x1={padL} x2={W} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.07)'} strokeDasharray={v === 0 ? '4 4' : undefined} />
          <text x={padL - 6} y={y(v) + 4} fill="#6f7685" fontSize="11" textAnchor="end">{v}°</text>
        </g>
      ))}
      <g clipPath="url(#plot)">
        <path d={path(timeline.sunAz, timeline.sunEl)} fill="none" stroke="#e2c07f" strokeWidth="1.6" opacity="0.85" />
        <path d={path(timeline.earthAz, timeline.earthEl)} fill="none" stroke="#8eb1db" strokeWidth="1.6" opacity="0.85" />
        <path d={ground} fill="url(#hill)" stroke="#9aa1ad" strokeWidth="1" />
        <circle cx={x(timeline.earthAz[c])} cy={y(timeline.earthEl[c])} r="7" fill={earthUp ? '#8eb1db' : 'none'} stroke="#8eb1db" strokeWidth="2" />
        <circle cx={x(timeline.sunAz[c])} cy={y(timeline.sunEl[c])} r="7" fill={sunUp ? '#e2c07f' : 'none'} stroke="#e2c07f" strokeWidth="2" />
      </g>
      {['N', 'E', 'S', 'W', 'N'].map((dir, i) => <text key={i} x={x(i * 90)} y={H - 5} fill="#a3a9b5" fontSize="11" textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>{dir}</text>)}
    </svg>
  );
}
