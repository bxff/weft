import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const digest = /^[0-9a-f]{64}$/
const assetName = /^[a-zA-Z0-9_-]{1,64}\.(?:png|jpe?g)$/
const maxFileBytes = 32 * 1024 * 1024
const maxAssetBytes = 20 * 1024 * 1024
const maxRequestBytes = 16 * 1024 * 1024

function object(v: unknown): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Invalid recovery record')
    return v as Record<string, unknown>
}

function hash(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

function verifiedRead(root: string, parts: string[], max = maxFileBytes): Buffer {
    const path = join(root, ...parts)
    const real = realpathSync(path)
    if (relative(root, real) !== relative(root, path)) throw Error('Recovery inputs must not be symlinks')
    const stat = lstatSync(real)
    if (!stat.isFile() || stat.size > max) throw Error('Invalid or oversized recovery file')
    const bytes = readFileSync(real)
    if (bytes.length > max) throw Error('Oversized recovery file')
    return bytes
}

function readJson(root: string, parts: string[]): Record<string, unknown> {
    return object(JSON.parse(verifiedRead(root, parts).toString('utf8')))
}

type Page = { id: string }

/** This deliberately accepts only the current notebook catalog format, not a second native catalog parser. */
function notebookPages(content: Record<string, unknown>): Page[] {
    const raw = object(content.cPages).pages
    if (!Array.isArray(raw)) throw Error('Only current-format native notebooks can be restored')
    const seen = new Set<string>()
    const pages: Page[] = []
    for (const p of raw) {
        const page = object(p)
        if ('deleted' in page) continue
        const id = page.id
        if (typeof id !== 'string' || !uuid.test(id) || seen.has(id)) throw Error('Invalid or duplicate native page ID')
        seen.add(id)
        const template = page.template == null ? undefined : object(page.template).value
        if (template != null && template !== '' && template !== 'Blank') {
            throw Error('This restore command currently supports blank-template notebooks only')
        }
        pages.push({ id })
    }
    if (!pages.length || pages.length > 256) throw Error('Restore requires 1–256 live native pages')
    return pages
}

/** Source consists of copies; acquisition and tablet pairing remain separate. */
export function prepareNotebookRestore(opts: { notebookId: string; recoveryDirectory: string; nativeDirectory: string }) {
    const id = opts.notebookId
    if (!uuid.test(id)) throw Error('Expected the native notebook UUID')
    const recovery = realpathSync(resolve(opts.recoveryDirectory))
    const native = realpathSync(resolve(opts.nativeDirectory))
    const nativeMetadata = readJson(native, [`${id}.metadata`])
    const nativeContent = readJson(native, [`${id}.content`])
    if (nativeMetadata.type !== 'DocumentType' || nativeMetadata.deleted === true || nativeMetadata.parent === 'trash') {
        throw Error('The selected notebook is not a live native document')
    }
    if (nativeContent.fileType != null && nativeContent.fileType !== '' && nativeContent.fileType !== 'notebook') {
        throw Error('PDF and EPUB restore are outside this notebook-only command')
    }
    const name = nativeMetadata.visibleName
    if (typeof name !== 'string' || !name.trim() || name.length > 256) throw Error('Invalid native notebook name')
    const pageList = notebookPages(nativeContent)
    let bodyByteBudget = 0
    const pages = pageList.map(({ id: page }) => {
        const c = readJson(recovery, [id, page, 'checkpoint.json'])
        const nativeSha256 = c.nativeSha256
        if (c.version !== 1 || typeof nativeSha256 !== 'string' || !digest.test(nativeSha256)) {
            throw Error(`Invalid recovery checkpoint for page ${page}`)
        }
        const overlay = object(c.overlay)
        if (!Array.isArray(overlay.shapes)) throw Error(`Missing editable state for page ${page}`)
        const nativeBase = verifiedRead(recovery, [id, page, `${nativeSha256}.rm`])
        if (hash(nativeBase) !== nativeSha256) throw Error(`Recovery base hash mismatch for page ${page}`)
        const current = verifiedRead(native, [id, `${page}.rm`])
        const currentSha256 = hash(current)
        if (!Array.isArray(c.assets)) throw Error(`Missing asset manifest for page ${page}`)
        // The manifest names the exact assets this recovery checkpoint covers.
        const seen = new Set<string>()
        const assets = c.assets.map((raw: unknown) => {
            const { name, sha256 } = object(raw)
            if (typeof name !== 'string' || !assetName.test(name) || seen.has(name) || typeof sha256 !== 'string' || !digest.test(sha256)) {
                throw Error(`Invalid asset manifest for page ${page}`)
            }
            seen.add(name)
            const local = [id, page, name]
            let bytes = existsSync(join(native, ...local)) ? verifiedRead(native, local, maxAssetBytes) : undefined
            if (!bytes || hash(bytes) !== sha256) {
                // A failed same-name replacement can leave the older checkpoint's
                // verified bytes alongside it so that generation remains usable.
                const fallback = [id, page, `${sha256}.asset`]
                bytes = existsSync(join(recovery, ...fallback)) ? verifiedRead(recovery, fallback, maxAssetBytes) : undefined
            }
            if (!bytes || hash(bytes) !== sha256) throw Error(`Recovery asset hash mismatch for page ${page}: ${name}`)
            return { name, sha256, base64: bytes.toString('base64') }
        })
        const record = {
            id: page,
            nativeSha256,
            nativeBase64: nativeBase.toString('base64'),
            ...(currentSha256 === nativeSha256 ? {} : { currentNativeBase64: current.toString('base64') }),
            overlay,
            assets,
        }
        bodyByteBudget += Buffer.byteLength(JSON.stringify(record))
        if (bodyByteBudget > maxRequestBytes) throw Error('Restore request exceeds the 16 MiB limit')
        return record
    })
    const restore = {
        version: 1,
        notebook: { id, name, parent: '', type: 'notebook', pages: pageList },
        pages,
    }
    serializeRestore(restore)
    return restore
}

function serializeRestore(restore: unknown): string {
    const body = JSON.stringify(restore)
    if (Buffer.byteLength(body) > maxRequestBytes) throw Error('Restore request exceeds the 16 MiB limit')
    return body
}

export async function submitNotebookRestore(opts: {
    cloud: string
    apiKey: string
    restore: ReturnType<typeof prepareNotebookRestore>
    fetch?: typeof fetch
}) {
    const url = new URL(opts.cloud)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
        throw Error('Use an HTTPS relay URL (HTTP is only allowed on localhost)')
    }
    const r = await (opts.fetch ?? fetch)(new URL('api/recovery/notebook', url.toString().replace(/\/?$/, '/')), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey },
        body: serializeRestore(opts.restore),
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
    })
    if (r.status !== 200 && r.status !== 201) throw Error(`Restore failed (HTTP ${r.status}). The tablet has not been linked or changed.`)
    const result = await r.json().catch(() => null)
    if (!result || result.ok !== true || result.notebookId !== opts.restore.notebook.id) {
        throw Error('The relay did not confirm the restore. Check the destination before continuing.')
    }
}
