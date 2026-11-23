import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// React app + Tailwind CSS v4 + the Cloudflare Vite plugin (runs the Hono Worker and a local D1 in `vite dev`,
// and emits the Worker plus static assets for `wrangler deploy` in `vite build`).
export default defineConfig({ plugins: [react(), tailwindcss(), cloudflare()] });
