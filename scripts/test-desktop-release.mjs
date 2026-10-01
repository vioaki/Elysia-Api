import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { desktopTargets, hostTarget, normalizeVersion, updaterAsset, verifyMacApp } from './build-desktop.mjs'
import { createManifest, mergeChecksums, releasePlatforms, validSignature, verifyUpdaterArtifact, writeDesktopRelease } from './release-desktop-manifest.mjs'

const signatureBody = Buffer.concat([Buffer.from('ED'), Buffer.alloc(72)]).toString('base64')
const signatureGlobal = Buffer.alloc(64).toString('base64')
const signature = Buffer.from(`untrusted comment: fixture\n${signatureBody}\ntrusted comment: timestamp:1\tfile:fixture\tversion:1.2.3-desktop.1\n${signatureGlobal}\n`).toString('base64')

test('build targets cover two architectures per OS with a universal macOS package', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const arch of ['x64', 'arm64']) assert.ok(desktopTargets[hostTarget(platform, arch)])
  }
  assert.deepEqual(desktopTargets['universal-apple-darwin'].goarches, ['amd64', 'arm64'])
  assert.equal(updaterAsset('aarch64-pc-windows-msvc'), 'elysia-api-desktop-windows-arm64-setup.exe')
  assert.throws(() => hostTarget('linux', 'ia32'))
  assert.throws(() => updaterAsset('unrecognized'))
})

test('only valid semver reaches Go ldflags and the Tauri overlay', () => {
  for (const value of ['1.2.3', 'v1.2.3', '1.2.3-desktop.1+local']) assert.equal(normalizeVersion(value), value.replace(/^v/, ''))
  for (const value of ['dev', '1.2', '01.2.3', '1.2.3-01', '1.2.3 -X key=bad', '1.2.3/../../bad']) assert.throws(() => normalizeVersion(value))
})

test('release manifest contains six signed targets, shared universal update, and merged server checksums', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elysia-desktop-release-'))
  try {
    for (const asset of new Set(Object.values(releasePlatforms).map(updaterAsset))) {
      writeFileSync(join(dir, asset), `fixture ${asset}`)
      writeFileSync(join(dir, `${asset}.sig`), `${signature}\n`)
    }
    writeFileSync(join(dir, 'elysia-api-macos.dmg'), 'fixture dmg')
    const options = { dir, version: 'v1.2.3-desktop.1', repo: 'PinkElysiaDev/Elysia-Api', tag: 'desktop-v1.2.3-desktop.1', pubDate: '2026-10-01T00:00:00Z' }
    const manifest = writeDesktopRelease({ ...options, previousChecksums: `${'a'.repeat(64)}  elysia-api-linux-amd64\n${'b'.repeat(64)}  elysia-api-macos.dmg\n` })
    assert.equal(Object.keys(manifest.platforms).length, 6)
    for (const [platform, target] of Object.entries(releasePlatforms)) {
      assert.ok(manifest.platforms[platform].url.endsWith(`/${updaterAsset(target)}`))
      assert.equal(manifest.platforms[platform].signature, signature)
    }
    assert.deepEqual(manifest.platforms['darwin-aarch64'], manifest.platforms['darwin-x86_64'])
    assert.ok(manifest.platforms['linux-aarch64'].url.endsWith('/elysia-api-desktop-linux-arm64.AppImage'))
    assert.equal(manifest.platforms['windows-aarch64'].signature, signature)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')), manifest)
    assert.throws(() => createManifest({ ...options, version: '1.2.4-desktop.1' }), /signed version does not match/)
    const checksums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8')
    assert.ok(checksums.includes(`${'a'.repeat(64)}  elysia-api-linux-amd64\n`))
    assert.ok(!checksums.includes(`${'b'.repeat(64)}  elysia-api-macos.dmg`))
    assert.equal(checksums.split('\n').filter(line => line.endsWith('  elysia-api-macos.dmg')).length, 1)
    rmSync(join(dir, 'elysia-api-desktop-linux-arm64.AppImage'))
    assert.throws(() => createManifest(options), /Missing updater artifact/)
    writeFileSync(join(dir, 'elysia-api-desktop-linux-arm64.AppImage'), 'restored fixture')
    writeFileSync(join(dir, 'elysia-api-desktop-linux-arm64.AppImage.sig'), 'invalid signature')
    assert.throws(() => createManifest(options), /Invalid Tauri updater signature/)
    writeFileSync(join(dir, 'elysia-api-desktop-linux-arm64.AppImage.sig'), Buffer.from(`untrusted comment: fixture\n${signatureBody}\ntrusted comment: timestamp:1\tfile:fixture\n${signatureGlobal}\n`).toString('base64'))
    assert.throws(() => createManifest(options), /signed version does not match/)
    assert.throws(() => createManifest({ ...options, repo: 'owner/name/extra' }), /GitHub/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('arbitrary, truncated, malformed and noncanonical signatures are rejected', () => {
  assert.equal(validSignature(signature), true)
  for (const value of ['', 'arbitrary signature', signature.slice(0, -1), 'YWJjZA', Buffer.from('untrusted comment: arbitrary').toString('base64'),
    Buffer.from(`untrusted comment: fixture\nYWJjZA==\ntrusted comment: fixture\n${signatureGlobal}`).toString('base64'),
    Buffer.from(`untrusted comment: fixture\n${signatureBody}\ntrusted comment: fixture\nYWJjZA==`).toString('base64'),
    Buffer.from(`untrusted comment: fixture\n${signatureBody}\ntrusted comment: fixture\n${signatureGlobal}\nextra`).toString('base64'),
  ]) assert.equal(validSignature(value), false, value)
})

test('cryptographic verification rejects tampered packages, comments, versions and signing keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elysia-minisign-check-'))
  try {
    const artifact = join(dir, 'artifact')
    const data = Buffer.from('signed updater fixture')
    writeFileSync(artifact, data)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keyID = Buffer.alloc(8, 1)
    const publicPacket = Buffer.concat([Buffer.from('Ed'), keyID, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)])
    const pubkey = Buffer.from(`untrusted comment: fixture\n${publicPacket.toString('base64')}\n`).toString('base64')
    const contentSignature = sign(null, createHash('blake2b512').update(data).digest(), privateKey)
    const packet = Buffer.concat([Buffer.from('ED'), keyID, contentSignature]).toString('base64')
    const comment = 'timestamp:1\tfile:artifact\tversion:1.2.3'
    const global = sign(null, Buffer.concat([contentSignature, Buffer.from(comment)]), privateKey).toString('base64')
    const signature = Buffer.from(`untrusted comment: fixture\n${packet}\ntrusted comment: ${comment}\n${global}\n`).toString('base64')
    const options = { artifact, signature, pubkey, version: '1.2.3' }
    await verifyUpdaterArtifact(options)
    await assert.rejects(verifyUpdaterArtifact({ ...options, version: '1.2.4' }), /signed version/)
    const changedComment = Buffer.from(Buffer.from(signature, 'base64').toString().replace('version:1.2.3', 'version:1.2.4')).toString('base64')
    await assert.rejects(verifyUpdaterArtifact({ ...options, signature: changedComment }), /trusted-comment signature/)
    publicPacket[2] ^= 1
    await assert.rejects(verifyUpdaterArtifact({ ...options, pubkey: Buffer.from(`untrusted comment: fixture\n${publicPacket.toString('base64')}\n`).toString('base64') }), /key ID/)
    writeFileSync(artifact, 'tampered updater fixture')
    await assert.rejects(verifyUpdaterArtifact(options), /artifact signature/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('actual updater artifact matches bundled public key and expected version', { skip: !process.env.DESKTOP_UPDATER_ARTIFACT }, async () => {
  assert.ok(process.env.DESKTOP_UPDATER_VERSION, 'Set DESKTOP_UPDATER_VERSION with DESKTOP_UPDATER_ARTIFACT')
  const artifact = process.env.DESKTOP_UPDATER_ARTIFACT
  const config = JSON.parse(readFileSync(fileURLToPath(new URL('../packages/desktop/src-tauri/tauri.conf.json', import.meta.url)), 'utf8'))
  await verifyUpdaterArtifact({ artifact, signature: readFileSync(`${artifact}.sig`, 'utf8').trim(),
    pubkey: config.plugins.updater.pubkey, version: process.env.DESKTOP_UPDATER_VERSION })
})

test('checksum merge rejects unsafe filenames and preserves one entry per asset', () => {
  assert.throws(() => mergeChecksums(`${'a'.repeat(64)}  ../asset\n`, ''))
  assert.throws(() => mergeChecksums('bad checksum\n', ''))
  assert.equal(mergeChecksums(`${'a'.repeat(64)}  asset\n`, `${'b'.repeat(64)}  asset\n`), `${'b'.repeat(64)}  asset\n`)
})

test('macOS packaging rejects an incompatible bundle identity or executable', { skip: process.platform !== 'darwin' }, () => {
  const app = mkdtempSync(join(tmpdir(), 'elysia-desktop-bundle-'))
  try {
    mkdirSync(join(app, 'Contents'))
    const plist = (id, executable) => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>${executable}</string></dict></plist>`
    writeFileSync(join(app, 'Contents', 'Info.plist'), plist('wrong.identifier', 'ElysiaApi'))
    assert.throws(() => verifyMacApp(app, 'universal-apple-darwin'), /CFBundleIdentifier=dev.pinkelysiadev.ElysiaApi/)
    writeFileSync(join(app, 'Contents', 'Info.plist'), plist('dev.pinkelysiadev.ElysiaApi', 'wrong-executable'))
    assert.throws(() => verifyMacApp(app, 'universal-apple-darwin'), /CFBundleExecutable=ElysiaApi/)
  } finally { rmSync(app, { recursive: true, force: true }) }
})

test('macOS packaging verifies both actual universal binaries and rejects a thin sidecar', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'elysia-universal-bundle-'))
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  try {
    const app = join(dir, 'ElysiaApi.app')
    const macos = join(app, 'Contents', 'MacOS')
    mkdirSync(macos, { recursive: true })
    const source = join(dir, 'main.c')
    writeFileSync(source, 'int main(void) { return 0; }\n')
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.pinkelysiadev.ElysiaApi</string><key>CFBundleExecutable</key><string>ElysiaApi</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    for (const arch of ['arm64', 'x86_64']) run('xcrun', ['--sdk', 'macosx', 'clang', '-target', `${arch}-apple-macos12.0`, source, '-o', join(dir, arch)])
    run('lipo', ['-create', join(dir, 'arm64'), join(dir, 'x86_64'), '-output', join(macos, 'ElysiaApi')])
    cpSync(join(macos, 'ElysiaApi'), join(macos, 'elysia-api'))
    run('codesign', ['--force', '--sign', '-', '--deep', app])
    verifyMacApp(app, 'universal-apple-darwin')
    cpSync(join(dir, 'arm64'), join(macos, 'elysia-api'))
    assert.throws(() => verifyMacApp(app, 'universal-apple-darwin'), /Missing x86_64 architecture: elysia-api/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
