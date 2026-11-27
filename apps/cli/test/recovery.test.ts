import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareNotebookRestore, submitNotebookRestore } from '../src/recovery'

const doc = '12345678-1234-1234-1234-123456789abc'
const page = '23456789-1234-1234-1234-123456789abc'
const deleted = '34567890-1234-1234-1234-123456789abc'
const base = 'base'
const ink = 'new ink'
const image = 'mock image'
const sha = (v: string) => createHash('sha256').update(v).digest('hex')
const paths: string[] = []
afterEach(() => { for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }) })

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'weft-restore-cli-test-'))
    paths.push(root)
    const nativeDirectory = join(root, 'native')
    const recoveryDirectory = join(root, 'recovery')
    const checkpointDir = join(recoveryDirectory, doc, page)
    mkdirSync(checkpointDir, { recursive: true })
    mkdirSync(join(nativeDirectory, doc, page), { recursive: true })
    writeFileSync(join(nativeDirectory, `${doc}.metadata`), JSON.stringify({
        type: 'DocumentType', visibleName: 'Current name', parent: 'a-folder',
    }))
    writeFileSync(join(nativeDirectory, `${doc}.content`), JSON.stringify({
        cPages: { pages: [{ id: deleted, deleted: { value: 1 } }, { id: page }] },
    }))
    writeFileSync(join(nativeDirectory, doc, `${page}.rm`), ink)
    writeFileSync(join(nativeDirectory, doc, page, 'photo.png'), image)
    writeFileSync(join(checkpointDir, `${sha(base)}.rm`), base)
    const overlay = { shapes: [{ shapeId: 'shape:arrow', props: { weftArrowLinks: [{ toId: 'shape:text', props: {} }] } }] }
    writeFileSync(join(checkpointDir, 'checkpoint.json'), JSON.stringify({
        version: 1, overlay, nativeSha256: sha(base), assets: [{ name: 'photo.png', sha256: sha(image) }],
    }))
    return { opts: { notebookId: doc, recoveryDirectory, nativeDirectory }, overlay, checkpointDir }
}

test('plans one current notebook and preserves overlay, exact base and newer ink', () => {
    const { opts, overlay } = fixture()
    const restore = prepareNotebookRestore(opts)
    expect(restore.notebook).toEqual({ id: doc, type: 'notebook', parent: '', name: 'Current name', pages: [{ id: page }] })
    expect(restore.pages).toEqual([{
        id: page, overlay, nativeSha256: sha(base), nativeBase64: btoa(base), currentNativeBase64: btoa(ink),
        assets: [{ name: 'photo.png', sha256: sha(image), base64: btoa(image) }],
    }])
    writeFileSync(join(opts.nativeDirectory, doc, `${page}.rm`), base)
    expect(prepareNotebookRestore(opts).pages[0]).not.toHaveProperty('currentNativeBase64')
})

test('fails closed on asset version mismatch, missing checkpoint or symlink', () => {
    const { opts, checkpointDir } = fixture()
    const asset = join(opts.nativeDirectory, doc, page, 'photo.png')
    writeFileSync(asset, 'replacement')
    expect(() => prepareNotebookRestore(opts)).toThrow('asset hash mismatch')
    rmSync(asset)
    const other = join(opts.nativeDirectory, 'other.png')
    writeFileSync(other, image)
    symlinkSync(other, asset)
    expect(() => prepareNotebookRestore(opts)).toThrow('must not be symlinks')
    rmSync(join(checkpointDir, 'checkpoint.json'))
    expect(() => prepareNotebookRestore(opts)).toThrow()
})

test('can recover the prior generation only from a verified hash-named fallback', () => {
    const { opts, checkpointDir } = fixture()
    writeFileSync(join(opts.nativeDirectory, doc, page, 'photo.png'), 'replacement')
    const fallback = join(checkpointDir, `${sha(image)}.asset`)
    writeFileSync(fallback, image)
    expect(prepareNotebookRestore(opts).pages[0]?.assets[0]?.base64).toBe(btoa(image))
    writeFileSync(fallback, 'bad fallback')
    expect(() => prepareNotebookRestore(opts)).toThrow('asset hash mismatch')
})

test('uses atomic notebook import once, with no automatic redirects or pairing', async () => {
    const { opts } = fixture()
    const restore = prepareNotebookRestore(opts)
    let count = 0
    const capture = (async (url: URL, init: RequestInit) => {
        count++
        expect(url.toString()).toBe('https://relay.example/api/recovery/notebook')
        expect(init.method).toBe('POST')
        expect(init.redirect).toBe('error')
        expect(new Headers(init.headers).get('x-api-key')).toBe('key')
        expect(JSON.parse(init.body as string)).toEqual(restore)
        return Response.json({ ok: true, notebookId: doc }, { status: 201 })
    }) as typeof fetch
    await submitNotebookRestore({ cloud: 'https://relay.example', apiKey: 'key', restore, fetch: capture })
    expect(count).toBe(1)
    await expect(submitNotebookRestore({ cloud: 'http://relay.example', apiKey: 'key', restore, fetch: capture })).rejects.toThrow('HTTPS')
    await expect(submitNotebookRestore({
        cloud: 'https://relay.example', apiKey: 'key', restore,
        fetch: (async () => new Response('<html></html>')) as typeof fetch,
    })).rejects.toThrow('did not confirm')
})

test('CLI dry run verifies copied directories without a token or network request', () => {
    const { opts } = fixture()
    const r = spawnSync(process.execPath, [
        new URL('../src/cli.ts', import.meta.url).pathname, 'restore-notebook', '--dry-run', '--cloud', 'https://unreachable.example',
        '--notebook', opts.notebookId, '--recovery-dir', opts.recoveryDirectory, '--native-dir', opts.nativeDirectory,
    ], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Verified 1 page(s). Nothing uploaded or changed.')
})

test('rejects unsupported source documents and an oversized request before upload', () => {
    const f = fixture()
    const catalog = join(f.opts.nativeDirectory, `${doc}.content`)
    writeFileSync(catalog, JSON.stringify({ fileType: 'pdf', cPages: { pages: [{ id: page }] } }))
    expect(() => prepareNotebookRestore(f.opts)).toThrow('PDF and EPUB restore')
    writeFileSync(catalog, JSON.stringify({ cPages: { pages: [{ id: page, template: { value: 'Grid' } }] } }))
    expect(() => prepareNotebookRestore(f.opts)).toThrow('blank-template')
    writeFileSync(catalog, JSON.stringify({ cPages: { pages: [{ id: page }] } }))
    writeFileSync(join(f.opts.nativeDirectory, doc, `${page}.rm`), Buffer.alloc(13 * 1024 * 1024))
    expect(() => prepareNotebookRestore(f.opts)).toThrow('16 MiB limit')
})
