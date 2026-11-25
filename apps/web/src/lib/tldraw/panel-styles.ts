/**
 * Shared look for every wf-panel's contents, composed instead of ad-hoc
 * inline styles so panels stay consistent: 12px mono rows, no separators,
 * active row = subtle fill, 10px muted metadata, bordered ghost actions.
 */
import type { CSSProperties } from 'react'

export const MONO = "'JetBrains Mono', ui-monospace, monospace"

/** One list row. Works for <button> and <div> alike; pass `active` for the
 *  filled current-item state. */
export function panelRow(active = false): CSSProperties {
    return {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '4px 6px',
        background: active ? 'var(--gray-2)' : 'transparent',
        color: active ? 'var(--gray-f)' : 'var(--gray-b)',
        border: 'none',
        borderRadius: 3,
        fontFamily: MONO,
        fontSize: 12,
    }
}

/** Muted secondary text inside a row (timestamps, authors, orientation). */
export const rowMeta: CSSProperties = {
    color: 'var(--gray-6)',
    fontSize: 10,
}

/** Small ghost action button inside/under rows (restore, hide, + layer). */
export const rowAction: CSSProperties = {
    fontFamily: MONO,
    fontSize: 10,
    padding: '2px 8px',
    borderRadius: 3,
    border: '1px solid var(--gray-3)',
    background: 'transparent',
    color: 'var(--gray-9)',
    cursor: 'pointer',
}

/** Prose blocks inside a panel, same 12px as rows. */
export const panelProse: CSSProperties = {
    padding: 10,
    fontSize: 12,
    lineHeight: 1.6,
}
