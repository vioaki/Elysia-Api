import { expect, test } from '@playwright/test'

test('desktop routes login, admin JSON, media and agent streams to the owned API', async ({ page }) => {
  await page.goto('/ui/')
  const calls: string[] = []
  await page.route('http://127.0.0.1:58765/**', async (route) => {
    calls.push(route.request().url())
    if (route.request().url().endsWith('/turn')) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: delta\ndata: {"text":"owned stream"}\n\n' })
    } else if (route.request().url().includes('/usage/assets/') || route.request().url().includes('/debug/pprof/')) {
      await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'owned media' })
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":{"status":"ok"}}' })
    }
  })
  const result = await page.evaluate(async () => {
    // Import the same Vite modules used by the real provider and pages.
    const api = await import('/src/lib/api.ts')
    const stream = await import('/src/lib/agent/sse.ts')
    const storage = await import('/src/lib/storage-keys.ts')
    // Populate the credential without notifying page subscribers; this check
    // exercises transport routing, not the app's login/navigation effects.
    localStorage.setItem(storage.STORAGE_KEYS.panelToken, 'desktop-test')
    const relative = api.apiUrl('/api/admin/health')
    api.setDesktopApiAddress('http://127.0.0.1:58765')
    await api.verifyToken('desktop-test')
    await api.request('/usage/logs', { query: { keyName: ['one', 'two'], limit: 2 } })
    const media = await api.api.usageAssetBlob('request-id', 'clip.bin')
    const events: string[] = []
    await stream.streamAgentEvents('/api/admin/agent/sessions/owned/turn', { prompt: 'test' }, event => events.push(event.type))
    const origin = api.apiOrigin()
    api.setDesktopApiAddress('http://192.168.1.10:8765')
    const configuredBind = api.apiOrigin()
    api.setDesktopApiAddress('')
    return { relative, origin, configuredBind, media: await media.text(), events, browserOrigin: api.apiOrigin(), reset: api.apiUrl('/api/admin/health') }
  })
  expect(result).toEqual({
    relative: '/api/admin/health', origin: 'http://127.0.0.1:58765', configuredBind: 'http://192.168.1.10:8765',
    media: 'owned media', events: ['delta'], browserOrigin: 'http://127.0.0.1:5274', reset: '/api/admin/health',
  })
  expect(calls).toEqual([
    'http://127.0.0.1:58765/api/admin/health',
    'http://127.0.0.1:58765/api/admin/usage/logs?keyName=one&keyName=two&limit=2',
    'http://127.0.0.1:58765/api/admin/usage/assets/request-id/clip.bin',
    'http://127.0.0.1:58765/api/admin/agent/sessions/owned/turn',
  ])
  const pprofRequest = page.waitForRequest('http://127.0.0.1:58765/debug/pprof/profile')
  const download = page.waitForEvent('download')
  await page.evaluate(async () => {
    const api = await import('/src/lib/api.ts')
    api.setDesktopApiAddress('http://127.0.0.1:58765')
    await api.downloadApiFile('/debug/pprof/profile')
    api.setDesktopApiAddress('')
  })
  expect((await pprofRequest).headers().authorization).toBe('Bearer desktop-test')
  expect((await download).suggestedFilename()).toBe('profile')
})
