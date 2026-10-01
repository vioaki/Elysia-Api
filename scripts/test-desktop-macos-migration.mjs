// Exercise the actual old Swift installer against the new universal DMG.
// Both app replacement and data sentinels live in one disposable directory.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { verifyMacApp } from './build-desktop.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleID = 'dev.pinkelysiadev.ElysiaApi'
const main = `import Foundation

do {
    guard Bundle.main.bundleIdentifier == "${bundleID}" else {
        throw UpdateError(message: "Fixture must run inside the legacy bundle identity")
    }
    let dmg = URL(fileURLWithPath: CommandLine.arguments[1])
    let current = URL(fileURLWithPath: CommandLine.arguments[3])
    try UpdateInstaller.verify(dmg, digest: CommandLine.arguments[2])
    let staged = try UpdateInstaller.extractApp(fromDMG: dmg, beside: current)
    try UpdateInstaller.replace(staged: staged, current: current)
    print("Old Swift UpdateInstaller verified, extracted and replaced the isolated app.")
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\\n").utf8))
    exit(1)
}
`

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) throw result.error ?? new Error(`${command} failed (${result.status ?? result.signal}):\n${result.stderr || result.stdout || ''}`)
  return result
}

function mountsFor(dmg) {
  const plist = run('/usr/bin/hdiutil', ['info', '-plist']).stdout
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist }).stdout)
  return (info.images ?? []).filter(image => image['image-path'] === dmg)
    .flatMap(image => image['system-entities'] ?? []).map(entity => entity['mount-point']).filter(Boolean)
}

async function checkMigration() {
  if (process.platform !== 'darwin') throw new Error('This installer compatibility check requires macOS.')
  const { values } = parseArgs({ options: { dmg: { type: 'string' } } })
  const dmg = realpathSync(resolve(values.dmg ?? join(repo, 'dist', 'desktop', 'universal-apple-darwin', 'elysia-api-macos.dmg')))
  assert.ok(statSync(dmg).isFile(), 'Expected a local DMG file')
  const hasher = createHash('sha256')
  for await (const chunk of createReadStream(dmg)) hasher.update(chunk)
  const digest = `sha256:${hasher.digest('hex')}`
  const previousMounts = new Set(mountsFor(dmg))
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'elysia-macos-migration-')))
  try {
    const app = join(temp, 'ElysiaApi.app')
    const macos = join(app, 'Contents', 'MacOS')
    const home = join(temp, 'home')
    const scratch = join(temp, 'tmp')
    const data = join(home, 'Library', 'Application Support', 'ElysiaApi')
    for (const path of [macos, scratch, join(data, 'usage-assets')]) mkdirSync(path, { recursive: true })
    const sentinels = new Map([
      ['config.json', Buffer.from('{"port":8765,"databasePath":"elysia-api.sqlite3","secretKeyPath":".master-key","custom":{"preserve":true}}\n')],
      ['elysia-api.sqlite3', Buffer.from('isolated database byte sentinel\x00\xff', 'latin1')],
      ['.master-key', Buffer.from('isolated encryption key byte sentinel\n')],
      ['usage-assets/request.bin', Buffer.from([0, 1, 127, 128, 255])],
    ])
    for (const [path, bytes] of sentinels) writeFileSync(join(data, path), bytes, { mode: 0o600 })
    const marker = join(app, 'Contents', 'old-installer-fixture')
    writeFileSync(marker, 'This is the disposable old app, not a user installation.\n')
    writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleID}</string>
<key>CFBundleExecutable</key><string>ElysiaApi</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`)
    const source = join(temp, 'main.swift')
    writeFileSync(source, main)
    run('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`,
      '-o', join(macos, 'ElysiaApi'), join(repo, 'scripts', 'macos-app', 'MacSupport.swift'), source], { timeout: 120000 })
    const installed = run(join(macos, 'ElysiaApi'), [dmg, digest, app], {
      timeout: 120000, env: { ...process.env, HOME: home, TMPDIR: scratch + sep },
    })
    assert.ok(installed.stdout.includes('Old Swift UpdateInstaller verified, extracted and replaced'), 'Old installer did not complete replacement')
    assert.throws(() => statSync(marker), /ENOENT/, 'Old app marker must be removed by whole-bundle replacement')
    verifyMacApp(app, 'universal-apple-darwin')
    const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', app])
    assert.match(signature.stderr, /Signature=adhoc/, 'Expected a zero-certificate-cost ad-hoc signed bundle')
    for (const [path, bytes] of sentinels) assert.deepEqual(readFileSync(join(data, path)), bytes, `Installer changed data: ${path}`)
    console.log('PASS: actual old Swift installer accepts and installs the new universal Tauri DMG; separate config, database, key and assets remain byte-identical.')
    console.log('Verified installer compatibility only; target UI, network upgrade and login-item migration were not exercised.')
  } finally {
    // Foundation uses the OS temp directory even when TMPDIR is set. Recover
    // only newly attached mounts of this exact local artifact after a timeout.
    for (const mount of mountsFor(dmg).filter(path => !previousMounts.has(path))) {
      run('/usr/bin/hdiutil', ['detach', mount, '-quiet'])
      try { rmdirSync(mount) } catch { /* Old installer may have removed it already. */ }
    }
    assert.deepEqual(mountsFor(dmg).filter(path => !previousMounts.has(path)), [], 'Owned test DMG remains mounted')
    rmSync(temp, { recursive: true, force: true })
  }
}

checkMigration().catch(error => { console.error(error.message); process.exitCode = 1 })
