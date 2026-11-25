/** Shared renderer configuration for the application and local SDK comparison. */
import { DEFAULT_THEME } from 'tldraw'
import { RmDrawShapeUtil } from './RmDrawShapeUtil'
import { DeviceTextShapeUtil } from './DeviceTextShapeUtil'
import { richTextConfig } from './device-text-extensions'

// Match the native palette without removing existing SDK color values.
const weftTheme = structuredClone(DEFAULT_THEME)
for (const mode of ['light', 'dark'] as const) {
    const palette = weftTheme.colors[mode]
    palette.orange = structuredClone(palette.red)
    palette['light-violet'] = structuredClone(palette.violet)
}

export const weftRendererOptions = {
    shapeUtils: [RmDrawShapeUtil, DeviceTextShapeUtil],
    options: {
        // One z-index band per shape remains within the signed 32-bit range.
        maxShapesPerPage: 32_768,
    },
    themes: { default: weftTheme },
    textOptions: { tipTapConfig: richTextConfig },
}
