import { renderMarkdownDoc } from '$lib/docs/render'
import source from './privacy.md?raw'

export const ssr = true
export const prerender = true

export const load = () => renderMarkdownDoc('privacy', source)
