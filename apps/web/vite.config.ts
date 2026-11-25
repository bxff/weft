import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// No dev proxy: the app talks to a cloud server by absolute URL
// (PUBLIC_CLOUD_URL or the localStorage override). The tablet is a sync agent,
// not an API server, so there is nothing to proxy to.
export default defineConfig({
    envPrefix: ['VITE_', 'PUBLIC_'],
    plugins: [tailwindcss(), sveltekit(), {
        name: 'weft-relative-dynamic-preloads',
        apply: 'build',
        config: {
            order: 'post',
            handler(config) {
                const renderBuiltUrl = config.experimental?.renderBuiltUrl
                if (!renderBuiltUrl) return
                return {
                    experimental: {
                        renderBuiltUrl(filename, context) {
                            // The shell uses absolute links, but Vite resolves JS preloads from the importing module.
                            if (!context.ssr && context.hostType === 'js') return { relative: true }
                            return renderBuiltUrl(filename, context)
                        },
                    },
                }
            },
        },
    }],
    optimizeDeps: {
        // pre-bundle up front: late discovery mid-session forces a page
        // reload (breaks e2e runs and the first real user interaction)
        include: ['@tiptap/core', '@tiptap/starter-kit'],
    },
})
