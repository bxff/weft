<script lang="ts">
    import { page } from '$app/stores'
    import { docNav } from '$lib/docs/nav'
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'
    let { children } = $props()
    type TocItem = { title: string; url: string; depth: number }
    const toc = $derived(($page.data.toc ?? []) as TocItem[])

    // Mobile drawer: the sidebar collapses below the desktop breakpoint and is
    // revealed by the toggle.
    let navOpen = $state(false)
    const current = $derived(docNav.find((d) => d.url === $page.url.pathname)?.title ?? 'Docs')
</script>

<div class="wf-docs-shell">
    <SiteHeader />

    <!-- mobile-only: current page + toggle for the page list -->
    <button
        type="button"
        class="wf-docs-mobnav"
        aria-expanded={navOpen}
        onclick={() => (navOpen = !navOpen)}
    >
        <span>{current}</span>
        <span class="wf-docs-mobnav-caret" class:open={navOpen}>▾</span>
    </button>

    <div class="wf-docs-grid">
        <nav class="wf-docs-sidebar" class:is-open={navOpen}>
            {#each docNav as item (item.url)}
                <a
                    href={item.url}
                    class="wf-docs-navlink"
                    class:is-active={$page.url.pathname === item.url}
                    aria-current={$page.url.pathname === item.url ? 'page' : undefined}
                    onclick={() => (navOpen = false)}
                >
                    {item.title}
                </a>
            {/each}
        </nav>

        <article class="wf-docs-article">
            {@render children()}
        </article>

        <aside class="wf-docs-toc">
            {#each toc as t (t.url)}
                <a href={t.url} class="wf-docs-toclink">{t.title}</a>
            {/each}
        </aside>
    </div>

    <SiteFooter />
</div>
