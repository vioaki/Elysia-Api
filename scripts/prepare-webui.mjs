import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function stripTrailingWhitespace(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      stripTrailingWhitespace(path)
    } else if (/\.(css|html|js)$/.test(entry)) {
      const content = readFileSync(path, 'utf8')
      const normalized = content.replace(/[ \t]+$/gm, '')
      if (normalized !== content) writeFileSync(path, normalized)
    }
  }
}

export function prepareWebui({ desktop = false } = {}) {
  console.log('==> Building and embedding WebUI')
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm'
  const args = ['run', 'build', '--workspace', '@root/webui']
  const result = spawnSync(command, process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...args] : args, {
    cwd: repoRoot, stdio: 'inherit',
  })
  if (result.status !== 0) throw result.error ?? new Error(`WebUI build failed (${result.status ?? result.signal})`)
  const destination = join(repoRoot, 'backend', 'webui', 'dist')
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(join(repoRoot, 'packages', 'webui', 'dist'), destination, { recursive: true })
  stripTrailingWhitespace(destination)
  // Keep the tracked placeholder required by go:embed after a clean clone.
  writeFileSync(join(destination, '.gitkeep'), '')
  if (desktop) {
    const frontend = join(repoRoot, 'packages', 'desktop', 'frontend')
    rmSync(frontend, { recursive: true, force: true })
    mkdirSync(frontend, { recursive: true })
    cpSync(join(repoRoot, 'packages', 'webui', 'dist'), join(frontend, 'ui'), { recursive: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareWebui({ desktop: process.argv.includes('--desktop') })
