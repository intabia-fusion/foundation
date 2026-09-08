#!/usr/bin/env node

const { join, dirname, basename, relative } = require('path')
const {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  writeFileSync,
  copyFileSync
} = require('fs')

const { spawnSync } = require('child_process')

const esbuild = require('esbuild')
const { copy } = require('esbuild-plugin-copy')
const sveltePlugin = require('esbuild-svelte')
const { svelte2tsx } = require('svelte2tsx')
const sveltePreprocess = require('svelte-preprocess')

const args = process.argv.slice(2)

/**
 * Collect source files recursively from a directory
 */
function collectFiles(source) {
  const result = []
  if (!existsSync(source)) {
    return result
  }
  const files = readdirSync(source)
  for (const f of files) {
    const sourceFile = join(source, f)

    if (lstatSync(sourceFile).isDirectory()) {
      result.push(...collectFiles(sourceFile))
    } else {
      const fileName = basename(sourceFile)
      // Skip non-source files
      if (!fileName.endsWith('.ts') && !fileName.endsWith('.js') && !fileName.endsWith('.svelte')) {
        continue
      }
      result.push(sourceFile)
    }
  }
  return result
}

/**
 * Collect JSON files recursively from a directory
 */
function collectJsonFiles(source) {
  const result = []
  if (!existsSync(source)) {
    return result
  }
  const files = readdirSync(source)
  for (const f of files) {
    const sourceFile = join(source, f)
    if (lstatSync(sourceFile).isDirectory()) {
      result.push(...collectJsonFiles(sourceFile))
    } else if (f.endsWith('.json')) {
      result.push(sourceFile)
    }
  }
  return result
}

/**
 * Copy JSON files from source to destination preserving directory structure
 */
function copyJsonFiles(srcDir, outDir, cwd) {
  const absoluteSrcDir = join(cwd, srcDir)
  const absoluteOutDir = join(cwd, outDir)
  const jsonFiles = collectJsonFiles(absoluteSrcDir)

  for (const jsonFile of jsonFiles) {
    const relativePath = relative(absoluteSrcDir, jsonFile)
    const destFile = join(absoluteOutDir, relativePath)
    const destDir = dirname(destFile)

    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true })
    }
    copyFileSync(jsonFile, destFile)
  }
}

async function performESBuildWithSvelte(filesToTranspile, options = {}) {
  const { cwd = process.cwd() } = options

  // Separate Svelte and non-Svelte files
  const svelteFiles = filesToTranspile.filter((f) => f.endsWith('.svelte'))
  const nonSvelteFiles = filesToTranspile.filter((f) => !f.endsWith('.svelte'))

  const outdir = join(cwd, 'lib')
  const outbase = join(cwd, 'src')

  // Build non-Svelte files
  if (nonSvelteFiles.length > 0) {
    await esbuild.build({
      entryPoints: nonSvelteFiles,
      bundle: false,
      minify: false,
      outdir,
      outbase,
      keepNames: true,
      logLevel: 'error',
      sourcemap: 'linked',
      allowOverwrite: true,
      format: 'cjs',
      color: true,
      absWorkingDir: cwd,
      plugins: [
        copy({
          resolveFrom: 'cwd',
          assets: {
            from: [join(cwd, 'src/**/*.json')],
            to: [outdir]
          },
          watch: false
        })
      ]
    })
  }

  // Build Svelte files
  if (svelteFiles.length > 0) {
    await esbuild.build({
      entryPoints: svelteFiles,
      bundle: false,
      minify: false,
      outdir,
      outbase,
      outExtension: { '.js': '.svelte.js' },
      keepNames: true,
      sourcemap: 'linked',
      logLevel: 'error',
      allowOverwrite: true,
      format: 'cjs',
      color: true,
      absWorkingDir: cwd,
      plugins: [
        sveltePlugin({
          // svelte-preprocess 6 elides imports that only the markup uses (a store referenced
          // as $store) unless this is set. Deliberately not in tsconfig: esbuild reads it too
          // and would then keep type-only imports, pulling .svelte source into node bundles.
          preprocess: sveltePreprocess({ typescript: { compilerOptions: { verbatimModuleSyntax: true } } }),
          compilerOptions: {
            css: 'injected',
            generate: 'ssr'
          }
        })
      ]
    })
  }
}

async function generateSvelteTypes(options = {}) {
  const { cwd = process.cwd() } = options
  const srcDir = join(cwd, 'src')
  const typesDir = join(cwd, 'types')

  if (!existsSync(srcDir)) {
    return
  }

  if (!existsSync(typesDir)) {
    mkdirSync(typesDir, { recursive: true })
  }

  const svelteFiles = collectFiles(srcDir).filter((f) => f.endsWith('.svelte'))

  for (const svelteFile of svelteFiles) {
    try {
      const content = readFileSync(svelteFile, 'utf-8')
      const result = svelte2tsx(content, {
        filename: svelteFile,
        isTsFile: true,
        mode: 'dts'
      })

      const relativePath = svelteFile.replace(srcDir, '')
      const outputPath = join(typesDir, relativePath.replace('.svelte', '.svelte.d.ts'))
      const outputDir = dirname(outputPath)

      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true })
      }

      writeFileSync(outputPath, result.code)
    } catch (err) {
      console.error(`Error generating types for ${svelteFile}:`, err.message)
    }
  }
}

/**
 * Resolve the native TypeScript 7 `tsc` binary.
 */
function resolveTsc7() {
  if (process.env.TSC7_BIN != null && process.env.TSC7_BIN !== '') {
    return process.env.TSC7_BIN
  }
  // Skip the `bin/tsc` node shim: it costs ~90ms of node startup per package.
  const rig = dirname(require.resolve('typescript7/package.json'))
  const platformPkg = `@typescript/typescript-${process.platform}-${process.arch}`
  const exeDir = join(dirname(require.resolve(`${platformPkg}/package.json`, { paths: [rig] })), 'lib')
  return join(exeDir, process.platform === 'win32' ? 'tsc.exe' : 'tsc')
}

/**
 * Single-pass compile via tsc 7: JS + .d.ts + maps, or declarations only.
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {boolean} [options.emitDeclarationOnly=false]
 * @param {boolean} [options.throwOnError=false]
 */
function tscCompile(options = {}) {
  const { cwd = process.cwd(), emitDeclarationOnly = false, throwOnError = false } = options
  const buildDir = join(cwd, '.build')

  if (!existsSync(buildDir)) {
    mkdirSync(buildDir, { recursive: true })
  }

  // Passed explicitly: a relative path in a rig profile resolves into the shared rig folder.
  const args = ['-p', 'tsconfig.json', '--tsBuildInfoFile', join('.build', 'build.tsbuildinfo')]
  if (emitDeclarationOnly) {
    args.push('--emitDeclarationOnly')
  }

  const res = spawnSync(resolveTsc7(), args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  const output = (res.stdout ?? '') + (res.stderr ?? '')
  writeFileSync(join(buildDir, 'compile.log'), output)

  if (res.error != null) {
    throw res.error
  }
  if (res.status !== 0) {
    if (throwOnError) {
      throw new Error(output)
    }
    console.error(output)
    process.exit(res.status ?? 1)
  }

  if (!emitDeclarationOnly) {
    copyJsonFiles('src', 'lib', cwd)
  }
}

// Main execution - only run when called directly
if (require.main === module) {
  switch (args[0]) {

    case 'ui-esbuild': {
      console.log('Building UI package with Svelte support...')
      const st = performance.now()
      const filesToTranspile = collectFiles(join(process.cwd(), 'src'))

      performESBuildWithSvelte(filesToTranspile, { cwd: process.cwd() })
        .then(() => generateSvelteTypes({ cwd: process.cwd() }))
        .then(() => {
          console.log('UI build time:', Math.round((performance.now() - st) * 100) / 100, 'ms')
        })
        .catch((err) => {
          console.error('UI build failed:', err)
          process.exit(1)
        })
      break
    }

    // `ui` kept as an alias: UI packages ship sources, only declarations are emitted.
    case 'build-ui':
    case 'ui': {
      const st = performance.now()
      tscCompile({ cwd: process.cwd(), emitDeclarationOnly: true })
      console.log('Build time:', Math.round((performance.now() - st) * 100) / 100, 'ms')
      break
    }

    case 'build':
    default: {
      const st = performance.now()
      tscCompile({ cwd: process.cwd() })
      console.log('Build time:', Math.round((performance.now() - st) * 100) / 100, 'ms')
      break
    }
  }
}

// Export functions for use by other modules
module.exports = {
  collectFiles,
  performESBuildWithSvelte,
  generateSvelteTypes,
  tscCompile,
  resolveTsc7
}
