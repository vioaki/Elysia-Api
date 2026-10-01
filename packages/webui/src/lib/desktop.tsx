import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSWRConfig } from 'swr'
import { setDesktopApiAddress } from './api'
import { clearToken } from './auth'
import { clearAssetCache } from './asset-blob-cache'

export interface DesktopView {
  status: string
  message: string
  hasChild: boolean
  apiAddress: string | null
  port: number
  dataDir: string
  version: string
  autostart: boolean
  firstRun: boolean
  update: { status: string; version: string | null; downloaded: number; total: number | null; message: string }
}

export type DesktopCommand = 'start_backend' | 'stop_backend' | 'set_port' | 'choose_data_directory'
  | 'open_data_directory' | 'open_log' | 'copy_api_address' | 'copy_panel_token'
  | 'check_updates' | 'install_update' | 'cancel_update' | 'set_autostart' | 'show_panel' | 'quit_app'

interface NativeBridge {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> }
  event: { listen<T>(event: string, listener: (event: { payload: T }) => void): Promise<() => void> }
}

const bridge = (window as Window & { __TAURI__?: NativeBridge }).__TAURI__
interface DesktopContextValue {
  enabled: boolean
  state: DesktopView | null
  ready: boolean
  error: string
  pending: Set<string>
  settingsRequest: number
  refresh(): Promise<void>
  invoke(command: DesktopCommand, args?: Record<string, unknown>): Promise<void>
}
const DesktopContext = createContext<DesktopContextValue>(null!)

export function DesktopProvider({ children }: { children: ReactNode }) {
  const { mutate } = useSWRConfig()
  const [state, setState] = useState<DesktopView | null>(null)
  const [error, setError] = useState('')
  const [apiReady, setApiReady] = useState(false)
  const [pending, setPending] = useState(new Set<string>())
  const [settingsRequest, setSettingsRequest] = useState(0)
  const inFlight = useRef(new Set<string>())
  const dataDirectory = useRef<string | null>(null)
  const apply = useCallback((next: DesktopView) => {
    if (dataDirectory.current !== null && dataDirectory.current !== next.dataDir) {
      clearToken()
      void mutate(() => true, undefined, { revalidate: false })
      clearAssetCache()
    }
    dataDirectory.current = next.dataDir
    try {
      setDesktopApiAddress(next.apiAddress || '')
      setApiReady(!!next.apiAddress)
      setError('')
    } catch (caught) {
      setApiReady(false)
      setError(`API 地址无效：${String(caught)}`)
    }
    setState(next)
  }, [mutate])
  const refresh = useCallback(async () => {
    if (!bridge) return
    try { apply(await bridge.core.invoke<DesktopView>('desktop_state')) }
    catch (caught) { setError(String(caught)) }
  }, [apply])

  useEffect(() => {
    if (!bridge) return
    let active = true
    const unlisten: (() => void)[] = []
    void (async () => {
      try {
        const cleanup = await bridge.event.listen<DesktopView>('desktop-state', ({ payload }) => { if (active) apply(payload) })
        if (!active) { cleanup(); return }
        unlisten.push(cleanup)
        const settingsCleanup = await bridge.event.listen('desktop-settings', () => { if (active) setSettingsRequest((value) => value + 1) })
        if (!active) { settingsCleanup(); return }
        unlisten.push(settingsCleanup)
        const initial = await bridge.core.invoke<DesktopView>('desktop_state')
        if (active) apply(initial)
      } catch (caught) { if (active) setError(String(caught)) }
    })()
    return () => { active = false; unlisten.forEach((cleanup) => cleanup()) }
  }, [apply])

  const invoke = useCallback(async (command: DesktopCommand, args?: Record<string, unknown>) => {
    if (!bridge || inFlight.current.has(command)) return
    inFlight.current.add(command)
    setPending(new Set(inFlight.current))
    try {
      await bridge.core.invoke(command, args)
      if (command !== 'quit_app') await refresh()
    } finally {
      inFlight.current.delete(command)
      setPending(new Set(inFlight.current))
    }
  }, [refresh])

  return <DesktopContext.Provider value={{ enabled: !!bridge, state, ready: !bridge || apiReady && !!state && !state.firstRun && ['running', 'ready'].includes(state.status), error, pending, settingsRequest, refresh, invoke }}>{children}</DesktopContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- optional native hook accompanies its provider
export function useDesktop() { return useContext(DesktopContext) }
