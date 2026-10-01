import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { normalizeVersion, updaterAsset } from './build-desktop.mjs'

export const releasePlatforms = {
  'darwin-x86_64': 'universal-apple-darwin',
  'darwin-aarch64': 'universal-apple-darwin',
  'windows-x86_64': 'x86_64-pc-windows-msvc',
  'windows-aarch64': 'aarch64-pc-windows-msvc',
  'linux-x86_64': 'x86_64-unknown-linux-gnu',
  'linux-aarch64': 'aarch64-unknown-linux-gnu',
}

export function validSignature(signature) {
  const decode = value => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value ?? '')) return null
    const bytes = Buffer.from(value, 'base64')
    return bytes.toString('base64') === value ? bytes : null
  }
  const decoded = decode(signature)
  if (!decoded) return false
  const lines = decoded.toString('utf8').trimEnd().split(/\r?\n/)
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith('trusted comment:')) return false
  const body = decode(lines[1]), global = decode(lines[3])
  return body?.length === 74 && ['ED', 'Ed'].includes(body.subarray(0, 2).toString()) && global?.length === 64
}

export async function verifyUpdaterArtifact({ artifact, signature, pubkey, version }) {
  if (!validSignature(signature)) throw new Error('Invalid updater signature format')
  const keyLines = Buffer.from(pubkey, 'base64').toString('utf8').trimEnd().split(/\r?\n/)
  const publicPacket = Buffer.from(keyLines[1] ?? '', 'base64')
  const lines = Buffer.from(signature, 'base64').toString('utf8').trimEnd().split(/\r?\n/)
  const packet = Buffer.from(lines[1], 'base64')
  if (publicPacket.length !== 42 || !['ED', 'Ed'].includes(publicPacket.subarray(0, 2).toString()) ||
      packet.subarray(0, 2).toString() !== 'ED' || !packet.subarray(2, 10).equals(publicPacket.subarray(2, 10))) {
    throw new Error('Updater signing key ID or algorithm differs from bundled public key')
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicPacket.subarray(10)]),
    format: 'der', type: 'spki',
  })
  const hasher = createHash('blake2b512')
  for await (const chunk of createReadStream(artifact)) hasher.update(chunk)
  if (!verify(null, hasher.digest(), publicKey, packet.subarray(10))) throw new Error('Updater artifact signature is invalid')
  const comment = lines[2].replace(/^trusted comment: /, '')
  if (!verify(null, Buffer.concat([packet.subarray(10), Buffer.from(comment)]), publicKey, Buffer.from(lines[3], 'base64'))) {
    throw new Error('Updater trusted-comment signature is invalid')
  }
  const signedVersion = comment.split('\t').find(field => field.startsWith('version:'))?.slice('version:'.length)
  if (!signedVersion || normalizeVersion(signedVersion) !== normalizeVersion(version)) throw new Error('Updater signed version does not match expected version')
}

export function createManifest({ dir, version, repo, tag, notes = '', pubDate = new Date().toISOString() }) {
  version = normalizeVersion(version)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Expected a GitHub owner/repository')
  if (!/^[A-Za-z0-9_.+-]+$/.test(tag)) throw new Error('Expected a release tag without path separators')
  if (!Number.isFinite(Date.parse(pubDate))) throw new Error('Invalid publication date')
  const platforms = {}
  for (const [platform, target] of Object.entries(releasePlatforms)) {
    const asset = updaterAsset(target)
    if (!existsSync(join(dir, asset))) throw new Error(`Missing updater artifact: ${asset}`)
    const signature = readFileSync(join(dir, `${asset}.sig`), 'utf8').trim()
    if (!validSignature(signature)) {
      throw new Error(`Invalid Tauri updater signature: ${asset}.sig`)
    }
    const signedVersion = Buffer.from(signature, 'base64').toString('utf8').split(/\r?\n/)[2]
      .split('\t').find(field => field.startsWith('version:'))?.slice('version:'.length)
    if (!signedVersion || normalizeVersion(signedVersion) !== version) throw new Error(`Updater signed version does not match ${version}: ${asset}.sig`)
    platforms[platform] = {
      signature,
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`,
    }
  }
  return { version, notes, pub_date: new Date(pubDate).toISOString(), platforms }
}

export function mergeChecksums(previous, current) {
  const lines = new Map()
  for (const text of [previous, current]) {
    for (const line of text.split('\n').filter(Boolean)) {
      const match = line.match(/^([a-fA-F0-9]{64}) [ *]([^/\\\r\n]+)$/)
      if (!match || match[2] === '.' || match[2] === '..') throw new Error('Invalid SHA256SUMS entry')
      lines.set(match[2], `${match[1].toLowerCase()}  ${match[2]}`)
    }
  }
  return `${[...lines.values()].join('\n')}\n`
}

export function writeDesktopRelease(options) {
  const manifest = createManifest(options)
  const assets = [...new Set(Object.values(releasePlatforms).map(updaterAsset))]
    .flatMap(asset => [asset, `${asset}.sig`])
  assets.push('elysia-api-macos.dmg')
  for (const asset of assets) {
    if (!existsSync(join(options.dir, asset))) throw new Error(`Missing release asset: ${asset}`)
  }
  writeFileSync(join(options.dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  assets.push('latest.json')
  const checksums = assets.map(asset => `${createHash('sha256').update(readFileSync(join(options.dir, asset))).digest('hex')}  ${asset}`).join('\n')
  writeFileSync(join(options.dir, 'SHA256SUMS'), mergeChecksums(options.previousChecksums ?? '', checksums))
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      dir: { type: 'string' }, version: { type: 'string' }, repo: { type: 'string' }, tag: { type: 'string' },
      notes: { type: 'string' }, 'pub-date': { type: 'string' }, 'merge-checksums': { type: 'string' },
    } })
    for (const required of ['dir', 'version', 'repo', 'tag']) if (!values[required]) throw new Error(`Missing --${required}`)
    const options = {
      dir: resolve(values.dir), version: values.version, repo: values.repo, tag: values.tag,
      notes: values.notes ? readFileSync(values.notes, 'utf8') : '', pubDate: values['pub-date'],
      previousChecksums: values['merge-checksums'] ? readFileSync(values['merge-checksums'], 'utf8') : '',
    }
    const config = JSON.parse(readFileSync(fileURLToPath(new URL('../packages/desktop/src-tauri/tauri.conf.json', import.meta.url)), 'utf8'))
    for (const asset of new Set(Object.values(releasePlatforms).map(updaterAsset))) {
      await verifyUpdaterArtifact({ artifact: join(options.dir, asset), signature: readFileSync(join(options.dir, `${asset}.sig`), 'utf8').trim(),
        pubkey: config.plugins.updater.pubkey, version: options.version })
    }
    writeDesktopRelease(options)
    console.log(`Desktop update manifest and SHA256SUMS written to ${resolve(values.dir)}`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
