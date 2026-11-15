// What kind of device the page is on, asked the same way everywhere. The phone layout itself is plain CSS
// (ui/phone.css, the same two questions as media queries); these are for the few choices code has to make.

/** A phone held upright, or any window that narrow: panels become sheets across the bottom (ui/phone.css). */
export const isPhone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches;

/** The pointer is a finger and nothing finer: no hover, no keyboard to drive with. */
export const isTouch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
