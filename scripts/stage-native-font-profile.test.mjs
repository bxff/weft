import {test, expect} from 'bun:test'
import {createHash} from 'node:crypto'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gzipSync} from 'node:zlib'

test('only stages complete, hash-pinned font data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-profile-test.'))
    try {
        mkdirSync(join(dir,'apps/web/src/lib/tldraw'),{recursive:true})
        const manifest = join(dir, 'apps/web/src/lib/tldraw/native-font-profile.generated.json')
        writeFileSync(manifest, 'null\n')
        const font = Buffer.alloc(1024)
        font.writeUInt32BE(0x00010000)
        const fonts = Object.fromEntries(
            ['regular','medium','bold','italic','bold-italic','serif','serif-bold'].map(k=>[k,font.toString('base64')]),
        )
        const data = {version:1,fonts,advances:{sans32:{W:.8}},staticAdvances:{sansRegular:{W:.8}},kerning:{sansRegular:{WA:-50}}}
        const archive = join(dir,'profile.gz')
        const stage = (bytes, hash = createHash('sha256').update(bytes).digest('hex')) => {
            writeFileSync(archive,bytes)
            return Bun.spawnSync(['node','scripts/stage-native-font-profile.mjs',archive,hash,dir])
        }
        const encode=(x)=>gzipSync(JSON.stringify(x))
        expect(stage(encode(data), '0'.repeat(64)).exitCode).not.toBe(0)
        expect(stage(encode({...data,kerning:{outside:{WA:-50}}})).exitCode).not.toBe(0)
        expect(stage(encode({...data,fonts:{...fonts,regular:'bm90IGEgZm9udA=='}})).exitCode).not.toBe(0)
        expect(readFileSync(manifest,'utf8')).toBe('null\n')
        expect(stage(encode(data)).exitCode).toBe(0)
        expect(JSON.parse(readFileSync(manifest,'utf8')).kerning.sansRegular.WA).toBe(-50)
        expect(readFileSync(join(dir,'apps/web/static/fonts/native-profile/regular.ttf'))).toEqual(font)
    } finally { rmSync(dir,{recursive:true,force:true}) }
})
