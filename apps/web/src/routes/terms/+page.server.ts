import { renderMarkdownDoc } from '$lib/docs/render'
import source from './terms.md?raw'

export const ssr = true
export const prerender = true

export const load = () => renderMarkdownDoc('terms', source)
