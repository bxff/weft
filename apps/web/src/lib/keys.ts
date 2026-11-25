/**
 * API-key management client. Keys let a third-party app act on the user's
 * notes via the same cloud API. Management calls require a session token: an
 * API key cannot mint/list/revoke keys.
 */
import { apiBase } from './settings'
import { getAuthToken } from './auth'

export interface ApiKey {
    id: string
    label: string
    token: string
    preview: string
    createdAt: number
    lastUsedAt: number | null
}

export interface Device {
    id: string
    label: string
    token: string
    preview: string
    createdAt: number
    lastUsedAt: number | null
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await getAuthToken()
    return fetch(`${apiBase()}${path}`, {
        ...init,
        headers: {
            ...(init.headers as Record<string, string>),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
    })
}

export async function listKeys(): Promise<ApiKey[]> {
    const r = await authed('/api/keys')
    if (!r.ok) throw new Error(`list keys: ${r.status}`)
    return ((await r.json()) as { keys: ApiKey[] }).keys
}

/** Returns the full secret (shown to the user once). */
export async function createKey(label: string): Promise<{ id: string; key: string }> {
    const r = await authed('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label }),
    })
    if (!r.ok) throw new Error(`create key: ${r.status}`)
    return (await r.json()) as { id: string; key: string }
}

export async function revokeKey(id: string): Promise<void> {
    const r = await authed(`/api/keys/${id}`, { method: 'DELETE' })
    if (!r.ok) throw new Error(`revoke key: ${r.status}`)
}

// paired devices (tablet pairing tokens)

export async function listDevices(): Promise<Device[]> {
    const r = await authed('/api/devices')
    if (!r.ok) throw new Error(`list devices: ${r.status}`)
    return ((await r.json()) as { devices: Device[] }).devices
}

export async function revokeDevice(id: string): Promise<void> {
    const r = await authed(`/api/devices/${id}`, { method: 'DELETE' })
    if (!r.ok) throw new Error(`revoke device: ${r.status}`)
}
