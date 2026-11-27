import { readFile, writeFile } from 'node:fs/promises'
const relay = new URL(process.env.PUBLIC_CLOUD_URL ?? '')
if (relay.protocol !== 'https:' || relay.href !== relay.origin + '/') {
    throw new Error('PUBLIC_CLOUD_URL must be an HTTPS origin for Pages')
}
const source = await readFile(new URL('./pages-library-proxy.mjs', import.meta.url), 'utf8')
const build = new URL('../apps/web/build/', import.meta.url)
await writeFile(new URL('_worker.js', build), source + '\nexport default libraryProxy(' + JSON.stringify(relay.origin) + ')\n')
await writeFile(new URL('_routes.json', build), JSON.stringify({ version: 1, include: ['/api/documents'], exclude: [] }) + '\n')
