// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// The human registry site. The machine discovery layer (keys.json + per-module
// index.yaml) is copied into public/registry/ by scripts/prepare.mjs and served
// verbatim — doze fetches it; the generated HTML pages live alongside it.
export default defineConfig({
	site: 'https://registry.doze-dev.com',
	// Hashed assets live under a registry-owned prefix: the router function
	// (functions/[[path]].js) serves /registry* and /_registry-assets* as
	// they are and maps a registry host's root onto /registry.
	build: { assets: '_registry-assets' },
	vite: { plugins: [tailwindcss()] },
});
