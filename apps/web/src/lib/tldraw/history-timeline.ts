/**
 * Pure timeline shaping for the history panel. Consecutive edit ops by the
 * same author within RUN_GAP_MS merge into one "edits (N)" row that restores
 * to the run's last op. Reverts and checkpoints break runs and stand alone.
 * Output is newest-first.
 */

export interface HistoryPoint {
    seq: number
    ts: number
    kind: 'op' | 'revert' | 'snapshot'
    author: string | null
    /** snapshot points only: the snapshot's own seq — the restore handle for
     *  checkpoints (their op seq is ambiguous: every tablet push shares it). */
    snapSeq?: number
    /** snapshot points only: pinned by a restore (merges into the 'revert'
     *  row instead of appearing as a phantom extra checkpoint). */
    revertSnap?: boolean
}

export interface TimelineRow {
    /** The op seq this row restores to (the run's last op). */
    seq: number
    ts: number
    kind: 'edits' | 'revert' | 'checkpoint'
    count: number
    author?: string | null
    /** checkpoint rows: restore via POST /revert { toSnapshot: snapSeq }. */
    snapSeq?: number
}

export const RUN_GAP_MS = 90_000

export function groupTimeline(points: HistoryPoint[]): TimelineRow[] {
    const rows: TimelineRow[] = []
    for (const p of points) {
        if (p.kind === 'snapshot') {
            // A restore writes a marker op and pins a snapshot of the restored
            // state: one user action. Fold the snapshot into the preceding
            // 'revert' row (it carries the restore handle) rather than showing
            // a phantom extra checkpoint.
            const last = rows[rows.length - 1]
            if (p.revertSnap && last && last.kind === 'revert' && last.snapSeq === undefined) {
                last.snapSeq = p.snapSeq
                last.ts = p.ts
                continue
            }
            rows.push({ seq: p.seq, ts: p.ts, kind: 'checkpoint', count: 1, snapSeq: p.snapSeq })
            continue
        }
        if (p.kind === 'revert') {
            rows.push({ seq: p.seq, ts: p.ts, kind: 'revert', count: 1 })
            continue
        }
        const last = rows[rows.length - 1]
        if (last && last.kind === 'edits' && last.author === p.author && p.ts - last.ts < RUN_GAP_MS) {
            last.seq = p.seq
            last.ts = p.ts
            last.count++
        } else {
            rows.push({ seq: p.seq, ts: p.ts, kind: 'edits', count: 1, author: p.author })
        }
    }
    return rows.reverse()
}

/**
 * Human label for an op author. 'web'/null -> 'browser', daemon -> 'tablet',
 * UUID-shaped -> 'browser' (legacy web installs pushed the engine author UUID
 * before historyAuthor existed; never show a raw UUID). Anything else is a
 * third-party app's self-chosen name, shown as-is.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function authorLabel(author: string | null | undefined): string {
    if (!author || author === 'web') return 'browser'
    if (author === 'rmsyncd' || author === 'tablet') return 'tablet'
    if (UUID_RE.test(author)) return 'browser'
    return author
}

/** Compact relative time for timeline rows. */
export function ago(ts: number, now = Date.now()): string {
    const s = Math.max(0, Math.round((now - ts) / 1000))
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.round(s / 60)}m ago`
    if (s < 86400) return `${Math.round(s / 3600)}h ago`
    return `${Math.round(s / 86400)}d ago`
}
