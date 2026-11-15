import 'cesium/Build/Cesium/Widgets/widgets.css';
import './styles.css';
import './styles-km.css';
import { createRoot } from 'react-dom/client';
import App from './App';
import { Tutorial } from './ui/Tutorial';
import { installMusic } from './audio/music';
// Last on purpose, after App and every stylesheet its parts bring in: the phone layout restates their rules.
import './ui/phone.css';

// The start screen's space video (index.html) goes first: wait until it can play (at most 2.5 s) before
// the app starts and begins downloading the Moon data, so the two do not fight over the connection.
function introReady(): Promise<void> {
  const v = document.getElementById('intro-video') as HTMLVideoElement | null;
  if (!v || v.readyState >= 3) return Promise.resolve();
  return new Promise(res => {
    const done = () => { clearTimeout(t); v.removeEventListener('canplay', done); v.removeEventListener('error', done); res(); };
    const t = setTimeout(done, 2500);
    v.addEventListener('canplay', done); v.addEventListener('error', done);
  });
}

// Short windows: the panels and the bottom row are drawn a little smaller so everything fits without the visitor
// zooming the browser out (styles.css, --z). Full size at 860 px of height and more, never under 0.78.
const fitWindow = () => document.documentElement.style.setProperty('--z', Math.max(0.78, Math.min(1, window.innerHeight / 860)).toFixed(3));
fitWindow();
window.addEventListener('resize', fitWindow);

// No StrictMode: it would build the heavy 3D globe twice in development.
// Then the music (it plays on the start screen), then the app.
void introReady().then(() => {
  installMusic();
  createRoot(document.getElementById('root')!).render(<><App /><Tutorial /></>);
});
