const listPath = '/api/documents'
const privateHeaders = {
    'cache-control': 'private, no-store',
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff',
}

export function libraryProxy(origin, requestUpstream = fetch) {
    const target = new URL(listPath, origin)
    const error = (status, message) => Response.json({ error: message }, { status, headers: privateHeaders })
    return {
        async fetch(request, env) {
            const url = new URL(request.url)
            if (url.pathname !== listPath) return env.ASSETS.fetch(request)
            if (request.method !== 'GET') return error(405, 'Method not allowed')
            if (request.headers.get('sec-fetch-site') === 'cross-site' ||
                (request.headers.get('origin') && request.headers.get('origin') !== url.origin)) {
                return error(403, 'Same-origin requests only')
            }
            const authorization = request.headers.get('authorization')
            if (!authorization?.startsWith('Bearer ')) return error(401, 'Sign in required')
            let upstream
            try {
                upstream = await requestUpstream(target, {
                    headers: { authorization, accept: 'application/json', 'cache-control': 'no-store' },
                    redirect: 'manual',
                    cache: 'no-store',
                })
            } catch {
                return error(502, 'Relay unavailable')
            }
            if (!upstream.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
                upstream.status === 304 || (upstream.status >= 300 && upstream.status < 400)) {
                return error(502, 'Unexpected relay response')
            }
            return new Response(upstream.body, { status: upstream.status, headers: privateHeaders })
        },
    }
}
