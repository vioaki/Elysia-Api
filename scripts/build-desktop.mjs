import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { prepareWebui } from './prepare-webui.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(repo, 'packages', 'desktop', 'src-tauri')

export const desktopTargets = {
  'x86_64-apple-darwin': { goos: 'darwin', goarches: ['amd64'], bundles: 'app,dmg' },
  'aarch64-apple-darwin': { goos: 'darwin', goarches: ['arm64'], bundles: 'app,dmg' },
  'universal-apple-darwin': { goos: 'darwin', goarches: ['amd64', 'arm64'], bundles: 'app,dmg' },
  'x86_64-pc-windows-msvc': { goos: 'windows', goarches: ['amd64'], bundles: 'nsis' },
  'aarch64-pc-windows-msvc': { goos: 'windows', goarches: ['arm64'], bundles: 'nsis' },
  'x86_64-unknown-linux-gnu': { goos: 'linux', goarches: ['amd64'], bundles: 'appimage' },
  'aarch64-unknown-linux-gnu': { goos: 'linux', goarches: ['arm64'], bundles: 'appimage' },
}

export function normalizeVersion(input) {
  const version = input.replace(/^v/, '')
  const number = '(0|[1-9]\\d*)'
  const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
  if (!new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`).test(version)) {
    throw new Error(`Expected a semantic version, received ${JSON.stringify(input)}`)
  }
  return version
}

export function hostTarget(platform = process.platform, arch = process.arch) {
  const suffix = { darwin: 'apple-darwin', win32: 'pc-windows-msvc', linux: 'unknown-linux-gnu' }[platform]
  const prefix = { x64: 'x86_64', arm64: 'aarch64' }[arch]
  if (!prefix || !suffix) throw new Error(`Unsupported desktop host: ${platform}/${arch}`)
  return `${prefix}-${suffix}`
}

export function updaterAsset(target) {
  const info = desktopTargets[target]
  if (!info) throw new Error(`Unsupported desktop target: ${target}`)
  if (info.goos === 'darwin') return 'elysia-api-macos.app.tar.gz'
  const arch = info.goarches[0]
  return info.goos === 'windows'
    ? `elysia-api-desktop-windows-${arch}-setup.exe`
    : `elysia-api-desktop-linux-${arch}.AppImage`
}

function run(command, args, options = {}) {
  if (process.platform === 'win32' && command === 'npm') {
    args = ['/d', '/s', '/c', 'npm', ...args]
    command = 'cmd.exe'
  }
  const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit', ...options })
  if (result.status !== 0) throw result.error ?? new Error(`${command} failed (${result.status ?? result.signal})`)
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0) throw result.error ?? new Error(`${command} failed: ${result.stderr?.trim()}`)
  return result.stdout.trim()
}

export function verifyMacApp(app, target) {
  const plist = join(app, 'Contents', 'Info.plist')
  run('plutil', ['-lint', plist])
  for (const [key, expected] of Object.entries({
    CFBundleIdentifier: 'dev.pinkelysiadev.ElysiaApi', CFBundleExecutable: 'ElysiaApi',
  })) {
    const actual = capture('plutil', ['-extract', key, 'raw', '-o', '-', plist])
    if (actual !== expected) throw new Error(`macOS migration requires ${key}=${expected}; received ${actual}`)
  }
  const architectures = target === 'universal-apple-darwin' ? ['arm64', 'x86_64']
    : [desktopTargets[target].goarches[0] === 'arm64' ? 'arm64' : 'x86_64']
  for (const executable of ['ElysiaApi', 'elysia-api']) {
    const actual = capture('lipo', ['-archs', join(app, 'Contents', 'MacOS', executable)]).split(/\s+/)
    for (const arch of architectures) if (!actual.includes(arch)) throw new Error(`Missing ${arch} architecture: ${executable}`)
  }
  run('codesign', ['--verify', '--deep', '--strict', app])
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    // Do not walk .app symlinks or the contents of AppImage runtime directories.
    return entry.isDirectory() && !entry.name.endsWith('.app') ? files(path) : entry.isFile() ? [path] : []
  })
}

function oneArtifact(bundleDir, extension) {
  const matches = files(bundleDir).filter(path => path.endsWith(extension))
  if (matches.length !== 1) throw new Error(`Expected one ${extension} artifact, found ${matches.length} in ${bundleDir}`)
  return matches[0]
}

export function buildDesktop(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    target: { type: 'string' }, version: { type: 'string' }, 'update-url': { type: 'string' },
    updater: { type: 'boolean', default: false }, 'sidecar-only': { type: 'boolean', default: false },
  } })
  const target = values.target ?? hostTarget()
  const info = desktopTargets[target]
  if (!info) throw new Error(`Unsupported desktop target: ${target}`)
  const tag = spawnSync('git', ['describe', '--tags', '--exact-match'], { cwd: repo, encoding: 'utf8' })
  const version = normalizeVersion(values.version ?? process.env.DESKTOP_APP_VERSION ??
    (tag.status === 0 ? tag.stdout.trim() : JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version))
  const hostOS = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform]
  if (!values['sidecar-only'] && hostOS !== info.goos) throw new Error(`Package ${target} on its native operating system`)
  if (target === 'universal-apple-darwin' && process.platform !== 'darwin') throw new Error('Universal macOS builds require lipo on macOS')
  if (values.updater && !process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('Signed updater builds require TAURI_SIGNING_PRIVATE_KEY')
  if (values['update-url'] && new URL(values['update-url']).protocol !== 'https:') throw new Error('The updater endpoint must use HTTPS')
  if (!values['sidecar-only']) {
    for (const tool of ['cargo', 'rustc']) {
      if (spawnSync(tool, ['--version'], { encoding: 'utf8' }).status !== 0) {
        throw new Error('Rust tools are missing from PATH. Open a new terminal after installation; on Unix run: source "$HOME/.cargo/env"')
      }
    }
  }

  prepareWebui({ desktop: true })
  const binaries = join(crate, 'binaries')
  mkdirSync(binaries, { recursive: true })
  const extension = info.goos === 'windows' ? '.exe' : ''
  const inputs = []
  for (const arch of info.goarches) {
    const archTarget = target === 'universal-apple-darwin' ? `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : target
    const output = join(binaries, `elysia-api-${archTarget}${extension}`)
    console.log(`==> Building Go sidecar ${info.goos}/${arch}, version ${version}`)
    run('go', ['build', '-trimpath', '-ldflags', `-s -w -X github.com/elysia-api/backend/server.AppVersion=${version}`, '-o', output, '.'], {
      cwd: join(repo, 'backend'), env: { ...process.env, CGO_ENABLED: '0', GOOS: info.goos, GOARCH: arch },
    })
    if (!extension) chmodSync(output, 0o755)
    inputs.push(output)
  }
  if (target === 'universal-apple-darwin') {
    run('lipo', ['-create', ...inputs, '-output', join(binaries, `elysia-api-${target}`)])
  }
  if (values['sidecar-only']) return

  const overlay = { version, bundle: { createUpdaterArtifacts: values.updater } }
  if (values['update-url']) overlay.plugins = { updater: { endpoints: [values['update-url']] } }
  const output = join(repo, 'dist', 'desktop', target)
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  const configFile = join(output, 'tauri.override.json')
  writeFileSync(configFile, `${JSON.stringify(overlay, null, 2)}\n`)
  const targetDir = process.env.CARGO_TARGET_DIR ? resolve(crate, process.env.CARGO_TARGET_DIR) : join(crate, 'target')
  const bundleDir = join(targetDir, target, 'release', 'bundle')
  // Remove stale packages so a failed signing/build cannot be mistaken for a new release.
  rmSync(bundleDir, { recursive: true, force: true })
  // Native CI mode skips Finder's cosmetic AppleScript when creating the DMG.
  run('npm', ['exec', '--workspace', '@root/desktop', '--', 'tauri', 'build', '--ci', '--target', target,
    '--bundles', info.bundles, '--config', configFile], { env: { ...process.env, CI: 'true' } })
  if (info.goos === 'darwin') {
    cpSync(oneArtifact(bundleDir, '.dmg'), join(output, 'elysia-api-macos.dmg'))
    const app = join(bundleDir, 'macos', 'ElysiaApi.app')
    verifyMacApp(app, target)
    run('hdiutil', ['verify', join(output, 'elysia-api-macos.dmg')])
  }
  const extensionToCopy = info.goos === 'darwin' ? '.app.tar.gz' : info.goos === 'windows' ? '.exe' : '.AppImage'
  if (values.updater || info.goos !== 'darwin') {
    const artifact = oneArtifact(bundleDir, extensionToCopy)
    cpSync(artifact, join(output, updaterAsset(target)))
    if (values.updater) {
      if (!existsSync(`${artifact}.sig`)) throw new Error(`Updater signature missing: ${artifact}.sig`)
      cpSync(`${artifact}.sig`, join(output, `${updaterAsset(target)}.sig`))
    }
  }
  console.log(`==> Desktop ${version} built: ${output}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildDesktop() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
