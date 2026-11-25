import adapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
export default {
    preprocess: vitePreprocess(),
    kit: {
        serviceWorker: { register: false },
        // rmsyncd serves the built output as static files with an
        // index.html SPA fallback (device/rmsyncd/src/server.rs).
        adapter: adapter({ fallback: 'index.html', precompress: true }),
        // Notebook shells are served at both canonical and slash-suffixed page URLs.
        paths: { relative: false },
        alias: { '@': 'src' },
    },
}
