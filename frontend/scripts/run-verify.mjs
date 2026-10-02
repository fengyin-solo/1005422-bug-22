// 验证脚本运行器：用 esbuild 的 JS API 打包后交给 node 执行，
// 不依赖可执行文件的宿主架构（部分环境装的是其它平台的二进制）。
import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('用法：node scripts/run-verify.mjs <脚本1.ts> [脚本2.ts ...]')
  process.exit(2)
}

const outdir = 'node_modules/.verify'
await rm(outdir, { recursive: true, force: true })
await build({
  entryPoints: targets,
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir,
})

for (const target of targets) {
  const name = target.split('/').pop().replace(/\.ts$/, '.js')
  console.log(`\n=== ${target} ===`)
  const child = await import('node:child_process')
  const code = child.spawnSync(process.execPath, [`${outdir}/${name}`], { stdio: 'inherit' }).status
  if (code !== 0) {
    process.exitCode = 1
  }
}
