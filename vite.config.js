import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        popup: 'src/popup/popup.html',
        options: 'src/options/options.html',
        offscreen: 'src/offscreen/offscreen.html'
      }
    }
  },
  plugins: [crx({ manifest })]
});
