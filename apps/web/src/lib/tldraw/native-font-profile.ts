import staged from './native-font-profile.generated.json'

type GlyphTable = Record<string, Record<string, number>>
type NativeFontProfile = {
    advances: GlyphTable
    staticAdvances: GlyphTable
    kerning: GlyphTable
}

export const nativeFontProfile = staged as NativeFontProfile | null
export const PROFILE_SANS = 'RM Profile Sans'
export const PROFILE_SERIF = 'RM Profile Serif'
