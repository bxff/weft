<script lang="ts">
    import type { PageData } from './$types'
    let { data }: { data: PageData } = $props()
</script>

<svelte:head>
    <title>{data.title} · weft</title>
    {#if data.description}<meta name="description" content={data.description} />{/if}
</svelte:head>

<h1 class="wf-docs-title">{data.title}</h1>
{#if data.description}<p class="wf-docs-desc">{data.description}</p>{/if}
<!-- eslint-disable-next-line svelte/no-at-html-tags (build-time rendered markdown) -->
{@html data.html}
