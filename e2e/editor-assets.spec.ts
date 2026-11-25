import { expect, test } from '@playwright/test'
import type { Editor } from 'tldraw'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const PAGE = '/app/22222222-2222-4222-a222-222222222222/bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'

test('the editor loads its icon sprite and all native text faces from the app', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const sdkAsset = /\/(?:IBMPlex|Shantell_Sans-Informal).*\.woff2$|\/0_merged(?:\.[\w-]+)?\.svg$/
    const externalAssets: string[] = []
    const localAssets = new Set<string>()
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin) return route.continue()
        if (sdkAsset.test(url.pathname)) externalAssets.push(url.href)
        return route.abort()
    })
    page.on('response', (response) => {
        const url = new URL(response.url())
        if (response.ok() && url.origin === origin && sdkAsset.test(url.pathname)) {
            localAssets.add(url.pathname)
        }
    })

    await page.goto(PAGE)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.evaluate(async () => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        editor.store.mergeRemoteChanges(() => {
            for (const font of ['mono', 'sans', 'serif', 'draw'] as const) {
                editor.createShape({
                    type: 'text',
                    props: {
                        font,
                        richText: {
                            type: 'doc',
                            content: [{
                                type: 'paragraph',
                                content: [
                                    { type: 'text', text: 'regular ' },
                                    { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] },
                                    { type: 'text', text: 'italic ', marks: [{ type: 'italic' }] },
                                    { type: 'text', text: 'bold italic', marks: [{ type: 'bold' }, { type: 'italic' }] },
                                ],
                            }],
                        },
                    },
                })
            }
        })
        await editor.fonts.loadRequiredFontsForCurrentPage()
    })

    expect(externalAssets).toEqual([])
    await expect.poll(() => [...localAssets].filter((path) => path.endsWith('.woff2'))).toHaveLength(16)
    await expect.poll(() => [...localAssets].filter((path) => path.endsWith('.svg'))).toHaveLength(1)
    const loaded = await page.evaluate(() => [...document.fonts]
        .filter((face) => face.family.startsWith('tldraw_') && face.status === 'loaded')
        .map((face) => `${face.family}:${face.style}:${face.weight}`))
    for (const family of ['mono', 'sans', 'serif', 'draw']) {
        for (const style of ['normal', 'italic']) {
            for (const weight of ['normal', 'bold']) {
                expect(loaded).toContain(`tldraw_${family}:${style}:${weight}`)
            }
        }
    }
})
