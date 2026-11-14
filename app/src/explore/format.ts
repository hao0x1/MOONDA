/** Distances and driving times shared by the map and its route panel. */
export function fmtDist(m: number): string {
  return m < 995 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 9950 ? 1 : 0)} km`;
}
export function fmtMinutes(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
