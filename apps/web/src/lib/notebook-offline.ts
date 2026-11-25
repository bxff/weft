import { base } from '$app/paths'

let registration: Promise<ServiceWorkerRegistration> | undefined

/** The first editor opens before the worker can see its asset requests. */
export function registerNotebookWorker(): () => void {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return () => {}

    const workers = navigator.serviceWorker
    const seen = new Set<string>()
    const paths = new Set<string>()
    let disposed = false
    function flush() {
        if (disposed || !workers.controller || !paths.size) return
        workers.controller.postMessage({ type: 'cache-notebook-assets', paths: [...paths] })
        paths.clear()
    }

    // Capture only public assets that have already been requested. Allowlist
    // membership and caching policy are checked again in the worker.
    function collect(entries: readonly PerformanceEntry[]) {
        for (const entry of entries) {
            const url = new URL(entry.name, location.href)
            if (url.origin === location.origin && !url.search &&
                (url.pathname.startsWith(`${base}/_app/immutable/`) || url.pathname.startsWith(`${base}/fonts/`))) {
                if (seen.has(url.pathname)) continue
                seen.add(url.pathname)
                paths.add(url.pathname)
            }
        }
        flush()
    }

    // An uncontrolled request can finish after the worker takes control.
    // Keep observing the first visit until this editor closes.
    const observer = !workers.controller && typeof PerformanceObserver !== 'undefined'
        ? new PerformanceObserver(list => collect(list.getEntries()))
        : undefined
    observer?.observe({ type: 'resource', buffered: true })
    function onController() {
        if (!workers.controller) return
        collect([...performance.getEntriesByType('resource'), ...(observer?.takeRecords() ?? [])])
    }
    workers.addEventListener('controllerchange', onController)
    registration ??= workers.register(`${base}/service-worker.js`)
    void registration.catch(() => { registration = undefined })
    return () => {
        disposed = true
        observer?.disconnect()
        workers.removeEventListener('controllerchange', onController)
    }
}
