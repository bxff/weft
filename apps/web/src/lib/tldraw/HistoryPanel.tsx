/**
 * History panel: the page's edit timeline + one-click restore over /history
 * and /revert. Every edit is an op in the keep-all log, so any point is
 * restorable; a restore never deletes history (the revert is itself an op).
 * Canvas refreshes because /revert emits page.changed + ops.appended and the
 * op-mode session re-bootstraps from the pinned checkpoint.
 */

import { announceDockOpen, onOtherDockOpen } from './dock'
import { useCallback, useEffect, useState } from 'react'
import { apiBase } from '../settings'
import { authHeaders } from '../authedAsset'
import { ago, authorLabel, groupTimeline, type HistoryPoint, type TimelineRow } from './history-timeline'
import { panelRow, rowAction, rowMeta } from './panel-styles'

export function HistoryPanel({ docId, pageId }: { docId: string; pageId: string }) {
    const [open, setOpen] = useState(false)
    useEffect(() => onOtherDockOpen('history', () => setOpen(false)), [])
    const [rows, setRows] = useState<TimelineRow[]>([])
    const [head, setHead] = useState(0)
    // Truncation floor: points below it were deleted by retention and cannot
    // be restored (server answers 410). 0 = keep-all.
    const [floor, setFloor] = useState(0)
    // Newest snapshot's own seq: the checkpoint that is (part of) the current
    // state. Checkpoint restorability is judged against this, not the op head,
    // because tablet-authored checkpoints all share op seq 0.
    const [maxSnap, setMaxSnap] = useState(0)
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            const r = await fetch(
                `${apiBase()}/api/documents/${docId}/pages/${pageId}/history?limit=500`,
                { headers: await authHeaders() },
            )
            if (!r.ok) throw new Error(`history ${r.status}`)
            const body = (await r.json()) as {
                points: HistoryPoint[]
                head: number
                floor?: number
            }
            setRows(groupTimeline(body.points))
            setHead(body.head)
            setFloor(body.floor ?? 0)
            setMaxSnap(
                body.points.reduce((m, p) => Math.max(m, p.snapSeq ?? 0), 0),
            )
        } catch (e) {
            setError(String(e))
        }
    }, [docId, pageId])

    useEffect(() => {
        if (open) void load()
    }, [open, load])

    const restore = useCallback(
        async (target: { toSeq: number } | { toSnapshot: number }, key: string) => {
            setBusy(key)
            setError(null)
            try {
                const r = await fetch(
                    `${apiBase()}/api/documents/${docId}/pages/${pageId}/revert`,
                    {
                        method: 'POST',
                        headers: { ...(await authHeaders()), 'content-type': 'application/json' },
                        body: JSON.stringify(target),
                    },
                )
                if (!r.ok) throw new Error(`revert ${r.status}`)
                await load()
            } catch (e) {
                setError(String(e))
            } finally {
                setBusy(null)
            }
        },
        [docId, pageId, load],
    )

    // Clear this page's history: frees storage, live page untouched,
    // irreversible (hence the two-click confirm).
    const [confirmClear, setConfirmClear] = useState(false)
    const clearHistory = useCallback(async () => {
        setBusy('clear-history')
        setError(null)
        try {
            const r = await fetch(
                `${apiBase()}/api/documents/${docId}/pages/${pageId}/clear-history`,
                { method: 'POST', headers: await authHeaders() },
            )
            if (!r.ok) throw new Error(`clear ${r.status}`)
            await load()
        } catch (e) {
            setError(String(e))
        } finally {
            setBusy(null)
        }
    }, [docId, pageId, load])

    const badge: React.CSSProperties = {
        cursor: 'pointer',
    }

    return (
        <>
            <button
                data-testid="history-toggle"
                className="wf-dock-item"
                data-active={open}
                style={badge}
                onClick={() =>
                    setOpen((v) => {
                        if (!v) announceDockOpen('history')
                        return !v
                    })
                }
            >
                history
            </button>
            {open && (
                <div data-testid="history-panel" className="wf-panel">
                    <div className="wf-panel-head">history</div>
                    <div className="wf-panel-body">
                    {error && (
                        <div style={{ color: 'var(--gray-7)', padding: 6 }}>{error}</div>
                    )}
                    {!error && rows.length === 0 && (
                        <div style={{ padding: 6, color: 'var(--gray-5)' }}>no history yet</div>
                    )}
                    {rows.map((row, i) => {
                        // Rows with a snapshot handle (checkpoints and merged
                        // restore rows) restore by snapshot seq: op seqs can't
                        // tell tablet pushes apart (all seq 0), and a stored
                        // snapshot survives op truncation, so no floor check.
                        // Restorable unless it is the current state. Edit runs
                        // keep the op-seq path.
                        const restorable =
                            row.snapSeq !== undefined
                                ? row.snapSeq !== maxSnap || head > row.seq
                                : row.seq < head && row.seq >= floor
                        const busyKey = `${row.kind}-${row.snapSeq ?? row.seq}`
                        const label = (
                            <span>
                                {row.kind === 'edits'
                                    ? `edits (${row.count})`
                                    : row.kind === 'revert'
                                      ? 'restored ⤺'
                                      : 'checkpoint'}
                                {row.kind === 'edits' && (
                                    <span style={{ ...rowMeta, marginLeft: 6 }}>
                                        {authorLabel(row.author)}
                                    </span>
                                )}
                            </span>
                        )
                        // the newest non-restorable row is the current state
                        const isCurrent = i === 0 && !restorable
                        const when = (
                            <span style={rowMeta}>
                                {busy === busyKey
                                    ? '…'
                                    : isCurrent
                                      ? `current · ${ago(row.ts)}`
                                      : ago(row.ts)}
                            </span>
                        )
                        // the whole row is the control: restorable rows click
                        // to restore, the current state sits filled and inert
                        if (!restorable) {
                            return (
                                <div
                                    key={`${row.seq}-${row.kind}-${i}`}
                                    data-testid="history-row"
                                    style={panelRow(isCurrent)}
                                >
                                    {label}
                                    {when}
                                </div>
                            )
                        }
                        return (
                            <button
                                key={`${row.seq}-${row.kind}-${i}`}
                                data-testid="history-row"
                                data-restore={
                                    row.snapSeq !== undefined ? `snap-${row.snapSeq}` : `${row.seq}`
                                }
                                disabled={busy !== null}
                                onClick={() =>
                                    void restore(
                                        row.snapSeq !== undefined
                                            ? { toSnapshot: row.snapSeq }
                                            : { toSeq: row.seq },
                                        busyKey,
                                    )
                                }
                                style={{
                                    ...panelRow(),
                                    cursor: busy === null ? 'pointer' : 'wait',
                                }}
                            >
                                {label}
                                {when}
                            </button>
                        )
                    })}
                    {rows.length > 0 && (
                        <div style={{ padding: '8px 6px 2px', textAlign: 'right' }}>
                            <button
                                data-testid="history-clear"
                                disabled={busy !== null}
                                onClick={() => {
                                    if (!confirmClear) {
                                        setConfirmClear(true)
                                        return
                                    }
                                    setConfirmClear(false)
                                    void clearHistory()
                                }}
                                style={{
                                    ...rowAction,
                                    color: confirmClear ? 'var(--red)' : 'var(--gray-6)',
                                }}
                            >
                                {confirmClear
                                    ? 'really clear? frees space, cannot be undone'
                                    : 'clear history…'}
                            </button>
                        </div>
                    )}
                    </div>
                </div>
            )}
        </>
    )
}
