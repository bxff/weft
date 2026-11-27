<script lang="ts">
    import LegalPage from '$lib/components/LegalPage.svelte'
    import type { PageData } from './$types'

    let { data }: { data: PageData } = $props()
</script>

<LegalPage {data} />
