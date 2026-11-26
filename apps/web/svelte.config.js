import adapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
export default {
    preprocess: vitePreprocess(),
    kit: {
        serviceWorker: { register: false },
        // Keep the public homepage separate from the client-only fallback.
        adapter: adapter({ fallback: '200.html', precompress: true }),
        // Notebook shells are served at both canonical and slash-suffixed page URLs.
        paths: { relative: false },
        alias: { '@': 'src' },
    },
}
