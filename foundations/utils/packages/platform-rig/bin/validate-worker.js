#!/usr/bin/env node

const { parentPort, threadId } = require('worker_threads')
const { join, basename, dirname, relative, sep } = require('path')
const {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  unlinkSync,
  utimesSync,
  rmSync
} = require('fs')
const ts = require('typescript')

/**
 * Fix source map paths when copying from .validate/emit to types
 * The emit directory is one level deeper, so sources paths need adjustment
 * e.g., "../../src/index.ts" -> "../src/index.ts"
 */
function fixSourceMapPaths(content) {
  try {
    const map = JSON.parse(content)
    if (map.sources && Array.isArray(map.sources)) {
      map.sources = map.sources.map(source => {
        if (source.startsWith('../../')) {
          return '../' + source.slice(6)
        }
        return source
      })
      return JSON.stringify(map)
    }
    return content
  } catch {
    return content
  }
}

let validationCount = 0

const sourceFileContentCache = new Map()
const sourceFileCache = new Map()

const contentCacheAccessOrder = []
const sourceCacheAccessOrder = []
const MAX_CONTENT_CACHE_SIZE = 150
const MAX_SOURCE_CACHE_SIZE = 300

const MEMORY_LIMIT_MB = 800

function tryGC() {
  if (global.gc) {
    global.gc()
    return true
  }
  return false
}

// Triggered by parent via 'gc'/'clear-cache' messages, or after each validation
// when memory is over MEMORY_LIMIT_MB.
function clearCaches() {
  sourceFileContentCache.clear()
  sourceFileCache.clear()
  contentCacheAccessOrder.length = 0
  sourceCacheAccessOrder.length = 0
  validationCount = 0
  tryGC()
}

function getMemoryUsageMB() {
  const usage = process.memoryUsage()
  return {
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
    rss: Math.round(usage.rss / 1024 / 1024)
  }
}

function collectAllFiles(dir, result = []) {
  if (!existsSync(dir)) return result

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectAllFiles(fullPath, result)
    } else {
      result.push(fullPath)
    }
  }
  return result
}

function collectSourceFiles(source) {
  const result = []
  if (!existsSync(source)) {
    return result
  }
  const files = readdirSync(source)
  for (const f of files) {
    const sourceFile = join(source, f)

    if (lstatSync(sourceFile).isDirectory()) {
      result.push(...collectSourceFiles(sourceFile))
    } else {
      const fileName = basename(sourceFile)
      if (!fileName.endsWith('.ts') && !fileName.endsWith('.js') && !fileName.endsWith('.svelte')) {
        continue
      }
      result.push(sourceFile)
    }
  }
  return result
}

/**
 * Sync directory from source to destination, only copying changed files
 * Also removes files from dest that don't exist in source
 */
function syncDirectory(srcDir, destDir) {
  let copied = 0
  let unchanged = 0
  let removed = 0

  if (!existsSync(srcDir)) {
    return { copied, unchanged, removed }
  }

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true })
  }

  const srcFiles = collectAllFiles(srcDir)
  const srcRelPaths = new Set(srcFiles.map(f => relative(srcDir, f)))

  const destFiles = collectAllFiles(destDir)
  const destRelPaths = new Map(destFiles.map(f => [relative(destDir, f), f]))

  for (const srcFile of srcFiles) {
    const relPath = relative(srcDir, srcFile)
    const destFile = join(destDir, relPath)
    const isSourceMap = srcFile.endsWith('.d.ts.map')

    let srcContent = readFileSync(srcFile)
    if (isSourceMap) {
      const fixedContent = fixSourceMapPaths(srcContent.toString('utf-8'))
      srcContent = Buffer.from(fixedContent, 'utf-8')
    }

    const destExists = existsSync(destFile)
    let contentsMatch = false
    if (destExists) {
      const destContent = readFileSync(destFile)
      contentsMatch = srcContent.equals(destContent)
    }

    if (!contentsMatch) {
      const destFileDir = dirname(destFile)
      if (!existsSync(destFileDir)) {
        mkdirSync(destFileDir, { recursive: true })
      }

      writeFileSync(destFile, srcContent)
      copied++
    } else {
      const now = new Date()
      utimesSync(destFile, now, now)
      unchanged++
    }
  }

  for (const [relPath, destFile] of destRelPaths) {
    // generateSvelteTypes writes types/*.svelte.d.ts and tsc emits no declaration for a
    // .d.ts input, so pruning against emit/ would delete them on every validate.
    if (relPath.endsWith('.svelte.d.ts') || relPath.endsWith('.svelte.d.ts.map')) continue
    if (!srcRelPaths.has(relPath)) {
      try {
        unlinkSync(destFile)
        removed++
      } catch {}
    }
  }

  cleanEmptyDirs(destDir)

  return { copied, unchanged, removed }
}

/**
 * Drops declarations in the emit dir whose source is gone. tsc writes there incrementally and never
 * cleans up, so a deleted `x.ts` left `x.d.ts` behind forever - and `syncDirectory` faithfully
 * copied that ghost back into types/ on every run. A ghost `transfer.d.ts` next to a real
 * `transfer/` directory then shadows it for `export * from './transfer'`, and every consumer sees
 * the API as it was before the split.
 */
function pruneEmitDir(emitDir, parsedConfig) {
  if (!existsSync(emitDir)) return 0
  const sources = parsedConfig.fileNames.filter((f) => !f.endsWith('.d.ts'))
  // `ts.getOutputFileNames` throws Debug Failure without an explicit rootDir, so the output paths
  // are derived here instead - an empty set would wipe the whole emit dir.
  const root = parsedConfig.options.rootDir ?? commonDirOf(sources)
  if (root === null) return 0
  const expected = new Set(sources.map((f) => relative(root, f).replace(/\.[cm]?[jt]sx?$/, '')))
  if (expected.size === 0) return 0
  let removed = 0
  for (const file of collectAllFiles(emitDir)) {
    const rel = relative(emitDir, file).replace(/\.d\.[cm]?ts(\.map)?$/, '')
    if (expected.has(rel)) continue
    try {
      unlinkSync(file)
      removed++
    } catch {}
  }
  if (removed > 0) cleanEmptyDirs(emitDir)
  return removed
}

function commonDirOf(files) {
  if (files.length === 0) return null
  let common = dirname(files[0]).split(sep)
  for (const file of files.slice(1)) {
    const parts = dirname(file).split(sep)
    let i = 0
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++
    common = common.slice(0, i)
  }
  return common.length === 0 ? null : common.join(sep)
}

function cleanEmptyDirs(dir) {
  if (!existsSync(dir)) return

  const entries = readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isDirectory()) {
      cleanEmptyDirs(join(dir, entry.name))
    }
  }

  const remaining = readdirSync(dir)
  if (remaining.length === 0) {
    try {
      rmSync(dir, { recursive: true })
    } catch {}
  }
}

/**
 * Create a compiler host with file content and SourceFile caching
 */
function createCachingCompilerHost(options, cwd) {
  const defaultHost = ts.createCompilerHost(options)

  return {
    ...defaultHost,

    readFile(fileName) {
      let normalizedPath = fileName
      try {
        normalizedPath = require('fs').realpathSync(fileName)
      } catch {
        normalizedPath = fileName
      }

      if (normalizedPath.includes('node_modules') && normalizedPath.endsWith('.d.ts')) {
        const cached = sourceFileContentCache.get(normalizedPath)
        if (cached !== undefined) {
          const idx = contentCacheAccessOrder.indexOf(normalizedPath)
          if (idx > -1) contentCacheAccessOrder.splice(idx, 1)
          contentCacheAccessOrder.push(normalizedPath)
          return cached
        }

        const content = ts.sys.readFile(fileName)
        if (content !== undefined) {
          if (sourceFileContentCache.size >= MAX_CONTENT_CACHE_SIZE) {
            const oldest = contentCacheAccessOrder.shift()
            if (oldest) sourceFileContentCache.delete(oldest)
          }
          sourceFileContentCache.set(normalizedPath, content)
          contentCacheAccessOrder.push(normalizedPath)
        }
        return content
      }

      return ts.sys.readFile(fileName)
    },

    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      let normalizedPath = fileName
      try {
        normalizedPath = require('fs').realpathSync(fileName)
      } catch {
        normalizedPath = fileName
      }

      if (normalizedPath.includes('node_modules') && normalizedPath.endsWith('.d.ts') && !shouldCreateNewSourceFile) {
        const cacheKey = `${normalizedPath}:${languageVersion}`
        const cached = sourceFileCache.get(cacheKey)
        if (cached) {
          const idx = sourceCacheAccessOrder.indexOf(cacheKey)
          if (idx > -1) sourceCacheAccessOrder.splice(idx, 1)
          sourceCacheAccessOrder.push(cacheKey)
          return cached
        }

        const sourceFile = defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        if (sourceFile) {
          if (sourceFileCache.size >= MAX_SOURCE_CACHE_SIZE) {
            const oldest = sourceCacheAccessOrder.shift()
            if (oldest) sourceFileCache.delete(oldest)
          }
          sourceFileCache.set(cacheKey, sourceFile)
          sourceCacheAccessOrder.push(cacheKey)
        }
        return sourceFile
      }

      return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
    },

    getCurrentDirectory() {
      return cwd
    },

    fileExists(fileName) {
      return ts.sys.fileExists(fileName)
    },

    getDirectories(path) {
      return ts.sys.getDirectories(path)
    },

    directoryExists(directoryName) {
      return ts.sys.directoryExists(directoryName)
    },

    realpath(path) {
      return ts.sys.realpath ? ts.sys.realpath(path) : path
    }
  }
}

/**
 * Validate TypeScript in a package directory.
 * Caching is the caller's responsibility — this function always compiles & emits.
 */
function validateTSC(cwd, options = {}) {
  const { srcDir = 'src' } = options

  const buildDir = join(cwd, '.validate')
  const emitDir = join(buildDir, 'emit')
  const typesDir = join(cwd, 'types')

  if (!existsSync(buildDir)) {
    mkdirSync(buildDir, { recursive: true })
  }

  if (!existsSync(emitDir)) {
    mkdirSync(emitDir, { recursive: true })
  }

  const stdoutFilePath = join(buildDir, 'validate.log')
  const stderrFilePath = join(buildDir, 'validate-err.log')

  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json')

  if (!configPath) {
    throw new Error('Could not find tsconfig.json')
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)

  const compilerOptionsOverride = {
    emitDeclarationOnly: true,
    declaration: true,
    declarationDir: emitDir,
    incremental: true,
    tsBuildInfoFile: join(buildDir, 'tsBuildInfoFile.info'),
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    noLib: false,
    disableSolutionSearching: true,
    disableReferencedProjectLoad: true
  }

  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, cwd, compilerOptionsOverride)

  if (existsSync(typesDir)) {
    const svelteTypeFiles = collectSourceFiles(typesDir).filter((f) => f.endsWith('.svelte.d.ts'))
    parsedConfig.fileNames.push(...svelteTypeFiles)
  }

  const host = createCachingCompilerHost(parsedConfig.options, cwd)

  let program = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
    host: host
  })

  const emitResult = program.emit()
  const allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics)

  const stdout = []
  const stderr = []

  allDiagnostics.forEach((diagnostic) => {
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line, character } = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start)
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      const output = `${diagnostic.file.fileName}(${line + 1},${character + 1}): error TS${diagnostic.code}: ${message}`
      stderr.push(output)
    } else {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      stderr.push(`error TS${diagnostic.code}: ${message}`)
    }
  })

  writeFileSync(stdoutFilePath, stdout.join('\n'))
  writeFileSync(stderrFilePath, stderr.join('\n'))

  const hasErrors = allDiagnostics.length > 0
  const emitSkipped = emitResult.emitSkipped

  program = null

  validationCount++
  // Periodic GC + memory-pressure cleanup. node_modules .d.ts caches are bounded
  // by LRU caps but TS internals leak; clear when over MEMORY_LIMIT_MB.
  if (validationCount % 5 === 0) {
    tryGC()
  }
  if (getMemoryUsageMB().heapUsed > MEMORY_LIMIT_MB) {
    clearCaches()
  }

  if (hasErrors) {
    throw new Error(stderr.join('\n'))
  }

  if (emitSkipped) {
    throw new Error('TypeScript emit was skipped')
  }

  const prunedFromEmit = pruneEmitDir(emitDir, parsedConfig)
  const syncResult = syncDirectory(emitDir, typesDir)
  syncResult.removed += prunedFromEmit

  return { syncResult }
}

if (parentPort) {
  parentPort.on('message', (task) => {
    const { id, type, cwd, reportMemory, srcDir = 'src' } = task

    if (type === 'validate') {
      try {
        const startMem = reportMemory ? getMemoryUsageMB() : null
        const result = validateTSC(cwd, { srcDir })
        const endMem = reportMemory ? getMemoryUsageMB() : null

        parentPort.postMessage({
          id,
          success: true,
          syncResult: result.syncResult,
          memory: reportMemory ? { before: startMem, after: endMem } : undefined,
          threadId,
          cacheStats: {
            contentCacheSize: sourceFileContentCache.size,
            sourceCacheSize: sourceFileCache.size,
            validationCount
          }
        })
      } catch (err) {
        const fullError = err.stack || err.message || String(err)
        parentPort.postMessage({ id, success: false, error: fullError, threadId })
      }
    } else if (type === 'gc') {
      clearCaches()
      const gcRan = tryGC()
      const mem = getMemoryUsageMB()
      parentPort.postMessage({ id, type: 'gc-result', gcRan, memory: mem, threadId })
    } else if (type === 'clear-cache') {
      sourceFileContentCache.clear()
      tryGC()
      const mem = getMemoryUsageMB()
      parentPort.postMessage({ id, type: 'cache-cleared', memory: mem, threadId })
    } else if (type === 'exit') {
      process.exit(0)
    }
  })

  const initialMem = getMemoryUsageMB()
  parentPort.postMessage({
    type: 'ready',
    threadId,
    memory: initialMem,
    gcAvailable: typeof global.gc === 'function'
  })
}

module.exports = {
  validateTSC,
  syncDirectory
}
