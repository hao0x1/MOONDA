import 'cesium/Build/Cesium/Widgets/widgets.css';
import './styles.css';
import './styles-km.css';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installMusic } from './audio/music';

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

// No StrictMode: it would build the heavy 3D globe twice in development.
// Then the music (it plays on the start screen), then the app.
void introReady().then(() => {
  installMusic();
  createRoot(document.getElementById('root')!).render(<App />);
});
