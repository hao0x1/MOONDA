// Real pictures of the Sun and Earth, used wherever the interface talks about them (made by
// data-prep/ui_glyphs.py from NASA SDO and NASA Blue Marble), plus the few icons we draw ourselves.

const base = import.meta.env.BASE_URL;
export const SUN_URL = `${base}ui/sun.webp`;
export const EARTH_URL = `${base}ui/earth.webp`;

interface GlyphProps { size?: number; /** dimmed and grey: "not in view right now" */ off?: boolean; className?: string }

export function SunGlyph({ size = 20, off, className }: GlyphProps) {
  return <img className={`glyph sun${off ? ' off' : ''}${className ? ` ${className}` : ''}`} src={SUN_URL} width={size} height={size} alt="" draggable={false} />;
}

export function EarthGlyph({ size = 20, off, className }: GlyphProps) {
  return <img className={`glyph earth${off ? ' off' : ''}${className ? ` ${className}` : ''}`} src={EARTH_URL} width={size} height={size} alt="" draggable={false} />;
}

/** A compass needle: red half points north. Turn it with `rotate`. */
export function CompassNeedle({ size = 24, rotate = 0 }: { size?: number; rotate?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} style={{ transform: `rotate(${rotate}deg)` }} aria-hidden="true">
      <path d="M12 2.2 15.4 12H8.6Z" fill="#ff5f52" />
      <path d="M12 21.8 8.6 12h6.8Z" fill="#d9dbe0" />
      <circle cx="12" cy="12" r="1.5" fill="#15161a" />
    </svg>
  );
}
