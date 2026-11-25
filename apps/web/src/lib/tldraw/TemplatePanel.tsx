/**
 * Template picker: choose a reMarkable page template from the user's synced
 * set. Writes via PATCH /api/documents/:doc/pages/:page; the daemon applies
 * it to the device's .content on its next pull. The underlay swaps
 * immediately via the optimistic onPicked callback.
 */
import { useEffect, useState } from 'react'
import { apiBase } from '../settings'
import { announceDockOpen, onOtherDockOpen } from './dock'
import { authHeaders } from '../authedAsset'
import { panelRow, rowMeta } from './panel-styles'

interface TemplateInfo {
    name: string
    kind: 'json' | 'image'
    displayName: string
    orientation: string | null
    categories: string[]
}

export function TemplatePanel({
    docId,
    pageId,
    current,
    onPicked,
}: {
    docId: string
    pageId: string
    current: string | null
    onPicked: (name: string) => void
}) {
    const [open, setOpen] = useState(false)
    useEffect(() => onOtherDockOpen('template', () => setOpen(false)), [])
    const [templates, setTemplates] = useState<TemplateInfo[] | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!open || templates !== null) return
        let cancelled = false
        void (async () => {
            try {
                const r = await fetch(`${apiBase()}/api/templates`, {
                    headers: await authHeaders(),
                })
                if (!r.ok) throw new Error(`templates ${r.status}`)
                const body = (await r.json()) as { templates: TemplateInfo[] }
                if (!cancelled) setTemplates(body.templates)
            } catch (e) {
                if (!cancelled) setError(String(e))
            }
        })()
        return () => {
            cancelled = true
        }
    }, [open, templates])

    const pick = async (name: string) => {
        setBusy(true)
        setError(null)
        try {
            const r = await fetch(`${apiBase()}/api/documents/${docId}/pages/${pageId}`, {
                method: 'PATCH',
                headers: {
                    ...(await authHeaders()),
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ template: name }),
            })
            if (!r.ok) throw new Error(`set template ${r.status}`)
            onPicked(name)
            setOpen(false)
        } catch (e) {
            setError(String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <>
            <button
                data-testid="template-toggle"
                className="wf-dock-item"
                data-active={open}
                style={{ cursor: 'pointer' }}
                onClick={() =>
                    setOpen((o) => {
                        if (!o) announceDockOpen('template')
                        return !o
                    })
                }
            >
                template
            </button>
            {open && (
                <div data-testid="template-panel" className="wf-panel">
                    <div className="wf-panel-head">page template</div>
                    <div className="wf-panel-body">
                    {error && <div style={{ color: 'var(--red)', padding: 6 }}>{error}</div>}
                    {templates === null && !error && (
                        <div style={{ color: 'var(--gray-7)', padding: 6 }}>loading…</div>
                    )}
                    {templates !== null &&
                        ['Blank', ...templates.filter((t) => t.kind === 'json').map((t) => t.name)].map(
                            (name) => {
                                const info = templates.find((t) => t.name === name)
                                const active = name === (current ?? 'Blank')
                                return (
                                    <button
                                        key={name}
                                        data-testid={`template-pick-${name}`}
                                        disabled={busy || active}
                                        onClick={() => void pick(name)}
                                        style={{
                                            ...panelRow(active),
                                            cursor: active ? 'default' : 'pointer',
                                        }}
                                    >
                                        <span>{info?.displayName ?? name}</span>
                                        <span style={rowMeta}>
                                            {info?.orientation === 'landscape' ? 'LS' : ''}
                                        </span>
                                    </button>
                                )
                            },
                        )}
                    </div>
                </div>
            )}
        </>
    )
}
