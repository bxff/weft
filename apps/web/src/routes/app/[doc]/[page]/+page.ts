// Build one public editor shell. The browser resolves the real notebook URL
// and loads the page through the existing authenticated API.
export const ssr = true
export const prerender = true
export const entries = () => [{ doc: 'shell', page: 'shell' }]
