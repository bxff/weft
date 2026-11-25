<script lang="ts">
    import '../app.css'
    import { onMount } from 'svelte'
    let { children } = $props()

    onMount(() => {
        // Crash telemetry (GlitchTip). Inert unless PUBLIC_SENTRY_DSN was set at build.
        void import('$lib/telemetry').then((m) => m.installGlobalHandlers())
        // Pending offline edits are the one client-side thing that isn't a
        // refetchable cache: ask the browser not to evict storage under disk
        // pressure. Denial just leaves best-effort behavior.
        void (async () => {
            try {
                await navigator.storage?.persist?.()
            } catch {
                // unsupported or denied: fine
            }
        })()
        // Replica LRU sweep, off the critical path (never touches a replica
        // with unpushed work; see replicaSweep.ts).
        void import('$lib/replicaSweep').then((m) => m.sweepReplicas())
    })
</script>

{@render children()}
