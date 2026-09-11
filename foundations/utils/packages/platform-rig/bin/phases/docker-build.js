/**
 * Docker build phase with unified caching
 */
const { spawn } = require('child_process')
const { performance } = require('perf_hooks')
const { join } = require('path')
const fs = require('fs')
const PNPM_CMD = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const {
  isPhaseCached,
  markPhaseCompleted
} = require('../libs/cache')

// Check if Docker is available
function isDockerAvailable() {
  try {
    const { execSync } = require('child_process')
    execSync('docker --version', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Extract docker image name from package's docker:build script
 */
function getDockerImageName(cwd) {
  try {
    const packageJsonPath = join(cwd, 'package.json')
    if (!fs.existsSync(packageJsonPath)) return null
    
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    const dockerBuildScript = pkg.scripts?.['docker:build']
    if (!dockerBuildScript) return null
    
    // Extract image name from script like:
    // "../../common/scripts/docker_build.sh intabiafusion/rating"
    const match = dockerBuildScript.match(/docker_build\.sh\s+([^\s]+)/)
    if (match) {
      return match[1]
    }
    
    return null
  } catch {
    return null
  }
}

/**
 * Preload docker image info for a batch of images in a single `docker inspect` call.
 * Returns Map<imageName, { exists: boolean, hash: string|null }>.
 * Images not present in docker are returned as { exists: false, hash: null }.
 */
async function preloadDockerImages(imageNames) {
  const cache = new Map()
  const unique = Array.from(new Set(imageNames.filter(Boolean)))
  for (const name of unique) {
    cache.set(name, { exists: false, hash: null })
  }
  if (unique.length === 0) return cache

  return new Promise((resolve) => {
    const refs = unique.map(n => n + ':latest')
    // Image may carry multiple tags; emit all tags joined by space, then hash.
    const fmt = '{{range .RepoTags}}{{.}} {{end}}\t{{index .Config.Labels "PACKAGE_HASH"}}'
    const child = spawn('docker', ['image', 'inspect', '--format', fmt, ...refs], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    child.stdout?.on('data', (data) => { stdout += data.toString() })
    child.stderr?.on('data', () => {}) // swallow "No such image" errors

    child.on('close', () => {
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const [repoTagsStr, hash] = trimmed.split('\t')
        if (!repoTagsStr) continue
        const cleanHash = hash && hash !== '<no value>' ? hash : null
        for (const tag of repoTagsStr.trim().split(/\s+/)) {
          const name = tag.replace(/:[^:]*$/, '')
          if (cache.has(name)) {
            cache.set(name, { exists: true, hash: cleanHash })
          }
        }
      }
      resolve(cache)
    })

    child.on('error', () => resolve(cache))
  })
}

/**
 * Check if docker image exists with matching hash label.
 * Uses preloaded imageCache when available to avoid per-package docker calls.
 */
async function checkDockerImage(imageName, packageHash, imageCache) {
  if (imageCache && imageCache.has(imageName)) {
    const entry = imageCache.get(imageName)
    return { exists: entry.exists, hashMatch: entry.exists && entry.hash === packageHash }
  }
  // Fallback: single inspect call
  return new Promise((resolve) => {
    const fmt = '{{index .Config.Labels "PACKAGE_HASH"}}'
    const child = spawn('docker', ['image', 'inspect', '-f', fmt, imageName + ':latest'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ exists: false, hashMatch: false })
        return
      }
      const imageHash = stdout.trim()
      resolve({ exists: true, hashMatch: imageHash === packageHash && !!imageHash })
    })
    child.on('error', () => resolve({ exists: false, hashMatch: false }))
  })
}

async function runDockerBuildPhase(graph, packageNames, concurrency, options = {}) {
  const { force = false, packageHash, imageCache } = options

  // Check if Docker is available
  if (!isDockerAvailable()) {
    console.error('[docker-build] Error: Docker is not available. Please install Docker or ensure it is running.')
    process.exit(1)
  }

  const results = {
    successCount: 0,
    cacheHits: 0,
    total: packageNames.length,
    errors: [],
    time: 0
  }

  async function dockerBuildPackage(packageName) {
    const node = graph.get(packageName)
    const cwd = node.project.fullPath

    // Get docker image name from package.json
    const imageName = getDockerImageName(cwd)

    // Check cache: image must exist with matching hash and phase must be cached
    if (!force && packageHash && imageName) {
      const imageCheck = await checkDockerImage(imageName, packageHash, imageCache)
      if (imageCheck.exists && imageCheck.hashMatch && isPhaseCached(cwd, packageHash, 'docker-build')) {
        return { success: true, fromCache: true }
      }
      // Log why we're rebuilding
      if (imageCheck.exists && !imageCheck.hashMatch) {
        console.log(`    [docker-build] ${packageName} - image hash mismatch, rebuilding...`)
      } else if (imageCheck.exists && !isPhaseCached(cwd, packageHash, 'docker-build')) {
        console.log(`    [docker-build] ${packageName} - phase cache miss, rebuilding...`)
      } else if (!imageCheck.exists) {
        console.log(`    [docker-build] ${packageName} - image '${imageName}' not found, building...`)
      }
    }

    return new Promise((resolve) => {
      const startTime = performance.now()
      console.log(`    [docker-build] Starting ${packageName}...`)

      // Pass packageHash to docker build for labeling
      const child = spawn(PNPM_CMD, ['run', 'docker:build'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: { ...process.env, PACKAGE_HASH: packageHash || '' }
      })

      let stdout = ''
      let stderr = ''
      let lastLogLine = ''
      let progressInterval = null
      let progressTimeout = null
      let hasOutput = false
      let isCompleted = false

      // Helper to get last non-empty line
      const getLastLogLine = (output) => {
        const lines = output.split('\n').filter(line => line.trim())
        return lines[lines.length - 1] || ''
      }

      // Setup progress logging for long-running docker builds (>15s)
      const setupProgressLogging = () => {
        const checkProgress = () => {
          if (isCompleted) return
          const elapsed = Math.round((performance.now() - startTime) / 1000)
          if (elapsed >= 15) {
            const lastLine = getLastLogLine(stdout + stderr)
            console.log(`    [docker-build] ${packageName} still building... (${elapsed}s elapsed, hasOutput: ${hasOutput})`)
            if (lastLine) {
              console.log(`      Last log: ${lastLine.substring(0, 200)}`)
            } else if (!hasOutput) {
              console.log(`      No output received yet`)
            }
          }
        }
        
        // First check after 15 seconds
        progressTimeout = setTimeout(() => {
          if (isCompleted) return
          checkProgress()
          // Then every 15 seconds
          if (!isCompleted) {
            progressInterval = setInterval(checkProgress, 15000)
          }
        }, 15000)
      }

      setupProgressLogging()

      child.stdout?.on('data', (data) => {
        const str = data.toString()
        stdout += str
        lastLogLine = getLastLogLine(stdout + stderr)
        hasOutput = true
      })
      child.stderr?.on('data', (data) => {
        const str = data.toString()
        stderr += str
        lastLogLine = getLastLogLine(stdout + stderr)
        hasOutput = true
      })

      child.on('close', (code) => {
        isCompleted = true
        const time = performance.now() - startTime
        
        // Clear progress timers
        if (progressTimeout) {
          clearTimeout(progressTimeout)
          progressTimeout = null
        }
        if (progressInterval) {
          clearInterval(progressInterval)
          progressInterval = null
        }

        if (code === 0) {
          if (packageHash) {
            markPhaseCompleted(cwd, packageHash, 'docker-build', null, [])
          }
          resolve({ success: true, time })
        } else {
          const error = new Error(`Docker build failed with exit code ${code}`)
          error.stdout = stdout
          error.stderr = stderr
          // Log error details to console
          console.error(`[docker-build] ${packageName} failed:`)
          console.error(`  Exit code: ${code}`)
          if (stderr) console.error(`  stderr: ${stderr}`)
          if (stdout) console.error(`  stdout: ${stdout}`)
          resolve({ success: false, error, time })
        }
      })

      child.on('error', (err) => {
        isCompleted = true
        // Clear progress timers on error
        if (progressTimeout) {
          clearTimeout(progressTimeout)
          progressTimeout = null
        }
        if (progressInterval) {
          clearInterval(progressInterval)
          progressInterval = null
        }
        resolve({ success: false, error: err })
      })
    })
  }

  // Process packages
  const promises = packageNames.map(async (name) => {
    const result = await dockerBuildPackage(name)
    if (result.success) {
      results.successCount++
      if (result.fromCache) results.cacheHits++
    } else {
      results.errors.push({ package: name, error: result.error })
    }
    return result
  })

  await Promise.all(promises)
  return results
}

module.exports = { runDockerBuildPhase, preloadDockerImages, getDockerImageName }
