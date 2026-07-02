// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// The human registry site. The machine discovery layer (keys.json + per-module
// index.yaml) is copied into public/registry/ by scripts/prepare.mjs and served
// verbatim — doze fetches it; the generated HTML pages live alongside it.
export default defineConfig({
	site: 'https://doze.nerdmenot.in',
	// Hashed assets live under a registry-owned prefix: the router function
	// (functions/[[path]].js) proxies everything OUTSIDE /registry* and
	// /_registry-assets* to the docs site, and the docs site has its own
	// /_astro — the two must not collide.
	build: { assets: '_registry-assets' },
	vite: { plugins: [tailwindcss()] },
});
