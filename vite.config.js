import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig(({ command }) => ({
  build: {
    // CRXJS writes a localhost-dependent loader while Vite is serving. Keep
    // that output away from the production folder users load in Chrome.
    outDir: command === 'serve' ? 'dist-dev' : 'dist',
    rollupOptions: {
      input: {
        popup: 'src/popup/popup.html',
        options: 'src/options/options.html',
        offscreen: 'src/offscreen/offscreen.html'
      }
    }
  },
  plugins: [crx({ manifest })]
}));
