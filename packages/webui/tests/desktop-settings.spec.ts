import { expect, test, type Page } from '@playwright/test'
import type { DesktopView } from '../src/lib/desktop'

const stopped: DesktopView = {
  status: 'stopped', message: '服务已停止。', hasChild: false, apiAddress: 'http://127.0.0.1:8765', port: 8765,
  dataDir: '/test/elysia-data', version: '1.0.0', autostart: false, firstRun: false,
  update: { status: 'idle', version: null, downloaded: 0, total: null, message: '启动时自动检查更新。' },
}

async function nativeFixture(page: Page, initial: DesktopView, authenticated = false) {
  const requests: string[] = []
  await page.route('**/api/admin/**', async (route) => {
    requests.push(route.request().url())
    const path = new URL(route.request().url()).pathname
    const data = path.endsWith('/runtime-config') ? {
      host: '127.0.0.1', port: 8765, panelAccessToken: '', databasePath: '/test/elysia.db', defaultDatabasePath: '/test/elysia.db',
      logLevel: 'info', httpTimeout: 120, enablePprof: false,
      usageLog: { persistEnabled: true, retentionDays: 0, maxContentMB: 0, maxRecords: 0, bodyMaxKB: 0, bodyOnErrorOnly: true, externalizeMedia: false, cleanupIntervalMinutes: 60 },
      systemLog: { retentionDays: 0, maxRecords: 0, maxContentMB: 0 },
    } : path.endsWith('/custom-protocols') || /\/usage\/(trend|by-model|by-model-daily)$/.test(path) ? []
      : path.endsWith('/seq') ? { seq: 0 } : path.endsWith('/health') ? { status: 'ok', database: true, memory: { alloc: 0, sys: 0, numGC: 0 } }
        : path.endsWith('/usage/storage') ? null : path.endsWith('/usage/maintenance') ? { state: 'idle', phase: 'idle' } : { items: [], total: 0 }
    await route.fulfill({ json: { ok: true, data }, headers: { 'access-control-allow-origin': '*' } })
  })
  await page.addInitScript(({ initial, authenticated }) => {
    if (authenticated) localStorage.setItem('elysia-webui.panel-token', 'manual-login')
    const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>()
    const fixture = {
      state: initial,
      calls: [] as { name: string; args?: Record<string, unknown> }[],
      emit(event: string, payload: unknown) { for (const listener of listeners.get(event) || []) listener({ payload }) },
      update(next: typeof initial) { this.state = next; this.emit('desktop-state', next) },
    }
    Object.assign(window, {
      __desktopFixture: fixture,
      __TAURI__: {
        core: { async invoke(name: string, args?: Record<string, unknown>) {
          fixture.calls.push({ name, args })
          if (name === 'desktop_state') return fixture.state
          if (name === 'start_backend') fixture.update({ ...fixture.state, firstRun: false, hasChild: true, status: 'running', message: '服务运行中。' })
          if (name === 'stop_backend') fixture.update({ ...fixture.state, hasChild: false, status: 'stopped', message: '服务已停止。' })
          if (name === 'set_port') fixture.update({ ...fixture.state, port: args?.port as number, apiAddress: `http://127.0.0.1:${args?.port}` })
          if (name === 'choose_data_directory') fixture.update({ ...fixture.state, dataDir: '/test/old-data', message: '已选择原数据目录。' })
          if (name === 'cancel_update') fixture.update({ ...fixture.state, update: { ...fixture.state.update, status: 'available', message: '已取消下载，当前服务未受影响。' } })
        } },
        event: { async listen(event: string, callback: (event: { payload: unknown }) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set())
          listeners.get(event)!.add(callback)
          return () => listeners.get(event)?.delete(callback)
        } },
      },
    })
  }, { initial, authenticated })
  return requests
}

test('ordinary browser login has no native desktop controls', async ({ page }) => {
  await page.goto('/#/login')
  await expect(page.getByRole('button', { name: '立即登录' })).toBeVisible()
  await expect(page.getByRole('button', { name: '应用设置' })).toHaveCount(0)
})

test('first run chooses original data without server requests or automatic login', async ({ page }) => {
  const requests = await nativeFixture(page, { ...stopped, firstRun: true })
  await page.goto('/#/login')
  await expect(page.getByRole('heading', { name: '准备开始使用' })).toBeVisible()
  await page.getByRole('button', { name: '选择原有数据目录', exact: true }).click()
  await expect(page.getByText('/test/old-data', { exact: true })).toBeVisible()
  expect(requests).toEqual([])
  await page.getByRole('button', { name: '使用当前目录并启动', exact: true }).click()
  await expect(page.getByRole('button', { name: '立即登录' })).toBeVisible()
  await expect(page.getByLabel('访问令牌 Panel Access Token')).toHaveValue('')
  await page.getByRole('button', { name: '应用设置', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '应用设置' })).toBeVisible()
})

test('desktop settings stay within runtime and recover after stopping the owned service', async ({ page }) => {
  const requests = await nativeFixture(page, { ...stopped, status: 'running', hasChild: true }, true)
  await page.goto('/#/runtime?tab=desktop')
  await expect(page.getByRole('tab', { name: '桌面应用', exact: true })).toHaveAttribute('data-state', 'active')
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'API 端口', exact: true })).toBeDisabled()
  expect(requests.some((url) => url.endsWith('/runtime-config'))).toBe(false)
  await page.getByRole('button', { name: '停止服务', exact: true }).click()
  await expect(page.getByRole('button', { name: '启动服务', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  const port = page.getByRole('spinbutton', { name: 'API 端口', exact: true })
  await port.fill('9001')
  await page.getByRole('button', { name: '保存端口', exact: true }).click()
  await expect(page.getByText('http://127.0.0.1:9001', { exact: true })).toBeVisible()
})

test('native settings menu selects the integrated tab and retains unsaved service edits', async ({ page }) => {
  await nativeFixture(page, { ...stopped, status: 'running', hasChild: true }, true)
  await page.goto('/#/runtime')
  const host = page.getByRole('textbox', { name: '监听 Host', exact: true })
  await host.fill('0.0.0.0')
  await page.evaluate(() => (window as Window & { __desktopFixture: { emit(event: string, payload: unknown): void } }).__desktopFixture.emit('desktop-settings', null))
  await expect(page.getByRole('tab', { name: '桌面应用', exact: true })).toHaveAttribute('data-state', 'active')
  await page.getByRole('tab', { name: '基础设置', exact: true }).click()
  await expect(host).toHaveValue('0.0.0.0')
})

test('native menu opens login settings without replaying the request after manual login', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await nativeFixture(page, { ...stopped, status: 'running', hasChild: true })
  await page.goto('/#/login')
  await expect(page.getByRole('button', { name: '立即登录' })).toBeVisible()
  await page.evaluate(() => (window as Window & { __desktopFixture: { emit(event: string, payload: unknown): void } }).__desktopFixture.emit('desktop-settings', null))
  const dialog = page.getByRole('dialog', { name: '应用设置' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByLabel('访问令牌 Panel Access Token').fill('manually-entered-token')
  await page.getByRole('button', { name: '立即登录' }).click()
  await expect(page).toHaveURL(/#\/overview$/)
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: '应用设置' })).toHaveCount(0)
})

test('invalid native API address preserves recovery controls without issuing server requests', async ({ page }) => {
  const requests = await nativeFixture(page, stopped, true)
  await page.goto('/#/runtime?tab=desktop')
  await expect(page.getByRole('button', { name: '启动服务', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const fixture = (window as Window & { __desktopFixture: { state: DesktopView; update(next: DesktopView): void } }).__desktopFixture
    fixture.update({ ...fixture.state, apiAddress: 'http://bad host:8765', status: 'running', hasChild: true })
  })
  await expect(page.getByRole('alert')).toContainText('API 地址无效')
  await expect(page.getByRole('button', { name: '停止服务', exact: true })).toBeEnabled()
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  expect(requests).toEqual([])
})

test('native settings menu remains open in logged in recovery without changing routes', async ({ page }) => {
  const requests = await nativeFixture(page, stopped, true)
  await page.goto('/#/overview')
  await expect(page.getByRole('button', { name: '启动服务', exact: true })).toBeVisible()
  await page.evaluate(() => (window as Window & { __desktopFixture: { emit(event: string, payload: unknown): void } }).__desktopFixture.emit('desktop-settings', null))
  await expect(page.getByRole('dialog', { name: '应用设置' })).toBeVisible()
  await expect(page).toHaveURL(/#\/overview$/)
  expect(requests).toEqual([])
})

test('changing data directories clears the previous login and requires a manual token', async ({ page }) => {
  await nativeFixture(page, stopped, true)
  await page.goto('/#/overview')
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await page.getByRole('button', { name: '选择原有数据目录', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('elysia-webui.panel-token'))).toBeNull()
  await page.getByRole('button', { name: '启动服务', exact: true }).click()
  await expect(page.getByLabel('访问令牌 Panel Access Token')).toHaveValue('')
})

test('unhealthy live child can be stopped and update download remains cancellable', async ({ page }) => {
  await nativeFixture(page, { ...stopped, status: 'error', hasChild: true, message: '健康检查未通过。', update: { ...stopped.update, status: 'downloading', downloaded: 20, total: 100 } }, true)
  await page.goto('/#/runtime?tab=desktop')
  await expect(page.getByRole('button', { name: '停止服务', exact: true })).toBeEnabled()
  await expect(page.getByRole('spinbutton', { name: 'API 端口', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '选择原有数据目录', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '取消下载', exact: true }).click()
  await expect(page.getByText('已取消下载，当前服务未受影响。', { exact: true })).toBeVisible()
})
