import { renderDoc, docSlugs } from '$lib/docs/render'
import { error } from '@sveltejs/kit'
import type { PageServerLoad, EntryGenerator } from './$types'

// Prerendered at build (Shiki runs build-time only; nothing ships to client).
export const prerender = true

export const entries: EntryGenerator = () => [
    { slug: '' },
    ...docSlugs.filter((s) => s !== 'index').map((s) => ({ slug: s })),
]

export const load: PageServerLoad = async ({ params }) => {
    const slug = params.slug && params.slug.length ? params.slug : 'index'
    const doc = await renderDoc(slug)
    if (!doc) throw error(404, 'Not found')
    return doc
}
