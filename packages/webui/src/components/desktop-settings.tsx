import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Copy, Download, FolderOpen, HardDrive, Loader2, Monitor, Play, Power, RefreshCw, Square } from 'lucide-react'
import { useDesktop, type DesktopCommand } from '@/lib/desktop'
import { formatBytes } from '@/lib/utils'
import { BrandMark } from './brand-mark'
import { ThemeToggle } from './theme-toggle'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { SettingRow, SettingSection } from './ui/setting-card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'
import { useToast } from './ui/use-toast'

export function DesktopSettings({ recovery = false }: { recovery?: boolean }) {
  const desktop = useDesktop()
  const state = desktop.state
  const toast = useToast()
  const [port, setPort] = useState('8765')
  const savedPort = state?.port
  useEffect(() => { if (savedPort) setPort(String(savedPort)) }, [savedPort])
  if (!desktop.enabled) return null

  async function action(command: DesktopCommand, args?: Record<string, unknown>) {
    try {
      await desktop.invoke(command, args)
      if (command === 'copy_api_address') toast.success('API 地址已复制')
      if (command === 'copy_panel_token') toast.success('面板令牌已复制', '请在登录页面手动输入令牌。')
      if (command === 'set_port') toast.success('端口已保存')
    } catch (caught) { toast.error('操作未完成', String(caught)) }
  }
  function savePort(event: FormEvent) {
    event.preventDefault()
    const value = Number(port)
    if (!Number.isInteger(value) || value < 1 || value > 65535) { toast.error('端口必须是 1 至 65535 之间的整数'); return }
    void action('set_port', { port: value })
  }

  if (!state) return (
    <div className="space-y-4" role="status">
      <p className="text-sm text-muted-foreground">{desktop.error || '正在连接本机服务…'}</p>
      <Button onClick={() => void desktop.refresh()}><RefreshCw />重试连接</Button>
    </div>
  )

  const update = state.update
  const running = ['running', 'ready'].includes(state.status)
  const hasChild = state.hasChild ?? running
  const changing = ['starting', 'stopping'].includes(state.status)
  const installing = update.status === 'installing'
  const locked = hasChild || changing || installing
  const download = ['downloading', 'verifying'].includes(update.status)
  const status = state.firstRun ? '首次启动' : ({ running: '运行中', ready: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', error: '需要处理' } as Record<string, string>)[state.status] || '正在连接'
  const busy = (command: DesktopCommand) => desktop.pending.has(command)

  return (
    <div className="max-w-[1100px] space-y-8">
      {desktop.error && <p role="alert" className="break-words text-sm text-ember">{desktop.error}</p>}
      <SettingSection icon={Monitor} title="桌面应用" description={`版本 ${state.version} · 关闭窗口后服务继续运行`} badge={<span className="rounded-full bg-wash px-2.5 py-0.5 text-2xs text-primary">{status}</span>}>
        <SettingRow label="本机服务" description={state.message || '启动服务后即可使用 API 与控制台。'}>
          {!hasChild && <Button variant="primary" disabled={changing || installing || busy('start_backend')} onClick={() => void action('start_backend')}><Play />{state.firstRun ? '使用当前目录并启动' : state.status === 'error' ? '重试启动' : '启动服务'}</Button>}
          {hasChild && <Button disabled={state.status === 'stopping' || installing || busy('stop_backend')} onClick={() => void action('stop_backend')}><Square />停止服务</Button>}
        </SettingRow>
        <SettingRow label="API 地址" description={<code className="break-all font-mono text-xs">{state.apiAddress || '服务尚未就绪'}</code>}>
          <Button disabled={!state.apiAddress} onClick={() => void action('copy_api_address')}><Copy />复制地址</Button>
          <Button disabled={!state.dataDir || state.firstRun} onClick={() => void action('copy_panel_token')}><Copy />复制面板令牌</Button>
        </SettingRow>
        <SettingRow label="API 端口" htmlFor="desktop-port" description="停止服务后可修改；端口冲突时不会自动换端口。">
          <form onSubmit={savePort} className="flex items-center gap-2">
            <Input id="desktop-port" type="number" inputMode="numeric" min={1} max={65535} step={1} required className="w-28 font-mono" value={port} onChange={(event) => setPort(event.target.value)} disabled={locked} aria-describedby="desktop-port-description" />
            <Button type="submit" disabled={locked || busy('set_port')}>保存端口</Button>
          </form>
        </SettingRow>
        {!recovery && <SettingRow label="登录系统时启动" htmlFor="desktop-autostart" description="登录系统后启动本机服务并驻留后台。">
          <Switch id="desktop-autostart" checked={state.autostart} disabled={installing || busy('set_autostart')} onCheckedChange={(enabled) => void action('set_autostart', { enabled })} aria-describedby="desktop-autostart-description" />
        </SettingRow>}
      </SettingSection>

      <SettingSection icon={HardDrive} title="数据与运行日志" description={state.firstRun ? '可使用默认目录，或选择原有数据目录继续使用配置、密钥及数据。' : '配置、密钥与数据保存在本机。'}>
        <SettingRow label="数据目录" inline={false} description={<code className="break-all font-mono text-xs">{state.dataDir}</code>}>
          <div className="flex flex-wrap gap-2">
            <Button disabled={locked || busy('choose_data_directory')} onClick={() => void action('choose_data_directory')}><FolderOpen />选择原有数据目录</Button>
            <Button onClick={() => void action('open_data_directory')}><FolderOpen />打开目录</Button>
            <Button onClick={() => void action('open_log')}>打开运行日志</Button>
          </div>
        </SettingRow>
      </SettingSection>

      {(!recovery || download || installing || update.status === 'available') && <SettingSection icon={Download} title="应用更新" description="启动时自动检查，之后每 24 小时检查一次。" action={<Button disabled={download || installing || update.status === 'checking' || busy('check_updates')} onClick={() => void action('check_updates')}><RefreshCw className={update.status === 'checking' ? 'animate-spin' : undefined} />检查更新</Button>}>
        <p role="status" className="break-words text-sm text-muted-foreground">{update.message || (update.status === 'available' ? `发现新版本 ${update.version}` : '当前版本可继续使用。')}</p>
        {update.status === 'available' && <div className="mt-3 space-y-3"><p className="text-xs text-muted-foreground">下载完成后会短暂停止本机 API，安装更新并重启应用。</p><Button variant="primary" disabled={busy('install_update')} onClick={() => void action('install_update')}><Download />下载并安装更新</Button></div>}
        {download && <div className="mt-3 space-y-2"><progress className="h-2 w-full accent-[var(--rose)]" aria-label="更新下载进度" max={update.total || undefined} value={update.total ? update.downloaded : undefined} /><div className="flex items-center justify-between gap-3"><span className="text-xs tabular-nums text-muted-foreground">{formatBytes(update.downloaded)}{update.total ? ` / ${formatBytes(update.total)}` : ''}</span><Button disabled={update.status !== 'downloading' || busy('cancel_update')} onClick={() => void action('cancel_update')}>取消下载</Button></div></div>}
        {installing && <p className="mt-3 flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />安装完成后自动重启，请稍候。</p>}
      </SettingSection>}
      <div className="flex items-center justify-end gap-2 border-t border-border/40 pt-4">{recovery && <DesktopSettingsDialog />}<Button variant="danger" disabled={installing} onClick={() => void action('quit_app')}><Power />退出应用</Button></div>
    </div>
  )
}

export function DesktopSettingsDialog() {
  const desktop = useDesktop()
  const [open, setOpen] = useState(false)
  const handled = useRef(desktop.settingsRequest)
  useEffect(() => {
    if (handled.current === desktop.settingsRequest) return
    handled.current = desktop.settingsRequest
    setOpen(true)
  }, [desktop.settingsRequest])
  if (!desktop.enabled) return null
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="ghost" size="sm"><Monitor />应用设置</Button></DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>应用设置</DialogTitle><DialogDescription>管理本机服务、数据目录与更新。登录仍需手动输入面板令牌。</DialogDescription></DialogHeader>
        <DesktopSettings />
      </DialogContent>
    </Dialog>
  )
}

export function DesktopRecovery({ login = false }: { login?: boolean }) {
  const desktop = useDesktop()
  const content = <div className="space-y-6"><div><h1 className="font-display text-2xl font-semibold">{desktop.state?.firstRun ? '准备开始使用' : '本机服务'}</h1><p className="mt-2 text-sm text-muted-foreground">{desktop.state?.firstRun ? '选择数据目录并启动服务，随后使用面板令牌登录。' : '启动与恢复操作可在这里完成。服务就绪后将返回控制台。'}</p></div><DesktopSettings recovery /></div>
  if (!login) return content
  return <main className="mx-auto min-h-dvh max-w-5xl space-y-10 px-6 py-8"><header className="flex items-center justify-between"><BrandMark /><ThemeToggle /></header>{content}</main>
}
