import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { source: { type: 'string' }, runtime: { type: 'string' } } })
if (!values.source || !values.runtime) throw new Error('Usage: node scripts/check-dsh-compatibility.mjs --source <rc.2 source checkout> --runtime <isolated npm prefix>')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstream = resolve(values.source)
const runtime = resolve(values.runtime)
const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).engines.dsh
for (const file of [join(upstream, 'apps/cli/package.json'), join(runtime, 'node_modules/@deepseek-ai/dsh/package.json')]) {
  if (JSON.parse(await readFile(file, 'utf8')).version !== expected) throw new Error(`Expected dsh ${expected}: ${file}`)
}
const directory = await mkdtemp(join(tmpdir(), 'vd-dsh-contracts-'))
try {
  const surfaces = join(directory, 'surfaces.mjs')
  const modules = {
    ClientSessions: 'packages/api/session-controller/src/client/sessions/service.ts',
    Session: 'packages/api/session-controller/src/client/sessions/session.ts',
    ClientAssistantStream: 'packages/api/session-controller/src/client/sessions/assistant-stream.ts',
    bridge: 'packages/client/connection/src/http-bridge.ts',
    HostConnectionService: 'packages/client/connection/src/rpc-host.ts',
    createWebConnectionRpc: 'packages/client/connection/src/client/rpc.ts',
  }
  await build({
    stdin: { contents: [
      ...Object.entries(modules).map(([name, path]) => `export { ${name} } from ${JSON.stringify(join(upstream, path))};`),
      'export { Context } from "@deepseek-ai/cordis";',
      `export { ProjectChatSource } from ${JSON.stringify(join(root, 'src/client/chat-source.ts'))};`,
    ].join('\n'), resolveDir: upstream, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    tsconfig: join(upstream, 'tsconfig.base.json'),
    nodePaths: [join(runtime, 'node_modules'), join(root, 'node_modules')],
    banner: { js: "import { createRequire as __require } from 'node:module'; const require = __require(import.meta.url);" },
    outfile: surfaces,
  })
  const child = spawn(process.execPath, ['--test', join(root, 'scripts/dsh-compatibility.checks.mjs')], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, VD_DSH_SURFACES: surfaces, VD_DSH_RUNTIME: runtime },
  })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  if (code !== 0) process.exitCode = 1
} finally {
  await rm(directory, { recursive: true, force: true })
}
