#!/usr/bin/env node

/**
 * This script validates that all @hcengineering packages use the same versions
 * across all dependencies (including devDependencies).
 * 
 * Also checks transitive dependencies in the lockfile.
 * and only validates @hcengineering packages.
 * 
 * The script will fail with exit code 1 if any version mismatches are found.
 */

const fs = require('fs')
const path = require('path')
const execSync = require('child_process').execSync

const SCOPE = '@hcengineering'

/**
 * Find the repository root by looking for pnpm-workspace.yaml
 * @returns {string} Path to repository root
 */
function findRepoRoot() {
  let currentDir = __dirname
  
  while (currentDir !== '/') {
    if (fs.existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir
    }
    currentDir = path.dirname(currentDir)
  }
  
  throw new Error('Could not find repository root (pnpm-workspace.yaml not found)')
}

/**
 * Parse pnpm-lock.yaml to extract resolved @hcengineering package versions
 * and track which packages depend on which versions
 * @returns {Object} Map of package names to version -> dependents mapping
 */
function parseLockfile() {
  const repoRoot = findRepoRoot()
  const lockfilePath = path.join(repoRoot, 'pnpm-lock.yaml')
  
  if (!fs.existsSync(lockfilePath)) {
    console.warn('⚠️  pnpm-lock.yaml not found, skipping lockfile validation')
    return {}
  }
  
  const lockfileContent = fs.readFileSync(lockfilePath, 'utf-8')
  const lines = lockfileContent.split('\n')
  const lockfileVersions = {}
  
  // Track current package in the packages section
  let currentPackage = null
  let currentPackageName = null
  let currentPackageVersion = null
  let inPackagesSection = false
  let inDependenciesSection = false
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    
    // Check if we're in the packages section
    if (line.match(/^packages:/)) {
      inPackagesSection = true
      continue
    }
    
    // Parse @hcengineering package entries like '  @hcengineering/platform@0.7.3:' or '@hcengineering/analytics@0.7.4:'
    if (inPackagesSection && line.match(new RegExp(`^  '?(${SCOPE}/[^@']+)@([^':()]+)(?:\\([^)]*\\))*'?:`))) {
      const packageMatch = line.match(new RegExp(`^  '?(${SCOPE}/[^@']+)@([^':()]+)(?:\\([^)]*\\))*'?:`))
      if (packageMatch) {
        currentPackageName = packageMatch[1]
        currentPackageVersion = packageMatch[2]
        currentPackage = `${currentPackageName}@${currentPackageVersion}`
        inDependenciesSection = false
        
        // Track this version exists
        if (!lockfileVersions[currentPackageName]) {
          lockfileVersions[currentPackageName] = {}
        }
        if (!lockfileVersions[currentPackageName][currentPackageVersion]) {
          lockfileVersions[currentPackageName][currentPackageVersion] = new Set()
        }
      }
      continue
    }
    
    // Check if we're entering dependencies section
    if (currentPackage && line.trim() === 'dependencies:') {
      inDependenciesSection = true
      continue
    }
    
    // Exit dependencies section
    if (inDependenciesSection && line.match(/^    [a-zA-Z]/)) {
      const nextSectionMatch = line.match(/^    ([a-zA-Z]+):/)
      if (nextSectionMatch && nextSectionMatch[1] !== 'dependencies' && nextSectionMatch[1] !== 'devDependencies') {
        inDependenciesSection = false
      }
    }
    
    // Exit current package when we hit another package definition at the same level
    if (currentPackage && line.match(/^  ['"]?[@a-zA-Z]/)) {
      currentPackage = null
      currentPackageName = null
      currentPackageVersion = null
      inDependenciesSection = false
    }
    
    // Parse dependency lines like "      '@hcengineering/platform': 0.7.3"
    // This tells us that currentPackageName@currentPackageVersion depends on @hcengineering/platform@0.7.3
    if (inDependenciesSection && currentPackageName && currentPackageVersion) {
      const depMatch = line.match(/^\s{6}'?(@hcengineering\/[^']+)'?:\s+([0-9.]+)/)
      if (depMatch) {
        const depPackageName = depMatch[1]
        const depVersion = depMatch[2]
        
        // Record that depPackageName@depVersion is required by currentPackageName@currentPackageVersion
        if (!lockfileVersions[depPackageName]) {
          lockfileVersions[depPackageName] = {}
        }
        if (!lockfileVersions[depPackageName][depVersion]) {
          lockfileVersions[depPackageName][depVersion] = new Set()
        }
        lockfileVersions[depPackageName][depVersion].add(currentPackage)
      }
    }
  }
  
  return lockfileVersions
}

/**
 * Get all workspace projects
 * @returns {Array} List of projects with name, version, and path
 */
function getProjects() {
  console.log('📦 Loading workspace projects...')
  try {
    const repoRoot = findRepoRoot()
    return require(repoRoot + '/foundations/utils/packages/platform-rig/bin/libs/workspace')
      .listWorkspaceProjects(repoRoot)
  } catch (error) {
    console.error('❌ Error loading workspace projects:', error.message)
    process.exit(1)
  }
}

/**
 * Read package.json for a project
 * @param {string} projectPath - Path to the project
 * @returns {Object} Parsed package.json
 */
function readPackageJson(projectPath) {
  const repoRoot = findRepoRoot()
  const fullPath = path.join(repoRoot, projectPath)
  const packageJsonPath = path.join(fullPath, 'package.json')
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf-8')
    return JSON.parse(content)
  } catch (error) {
    console.warn(`⚠️  Could not read ${packageJsonPath}: ${error.message}`)
    return null
  }
}

/**
 * Extract @hcengineering dependencies from package.json
 * @param {Object} packageJson - Parsed package.json
 * @param {string} packageName - Name of the package
 * @returns {Object} Map of dependency name to version
 */
function extractHceDependencies(packageJson, packageName) {
  const dependencies = {}
  
  // Check both dependencies and devDependencies
  const depTypes = ['dependencies', 'devDependencies']
  
  for (const depType of depTypes) {
    const deps = packageJson[depType]
    if (!deps) continue
    
    for (const [depName, version] of Object.entries(deps)) {
      if (depName.startsWith(SCOPE)) {
        dependencies[depName] = {
          version: version,
          type: depType,
          usedBy: packageName
        }
      }
    }
  }
  
  return dependencies
}

/**
 * Build a map of all dependency versions across all packages
 * @param {Array} projects - List of projects
 * @returns {Object} Map of dependency name to list of versions and users
 */
function buildDependencyMap(projects) {
  console.log('🔍 Scanning all packages for @hcengineering dependencies...\n')
  
  const dependencyMap = {}
  let totalPackages = 0
  let totalDependencies = 0
  
  for (const project of projects) {
    const packageJson = readPackageJson(project.path)
    if (!packageJson) continue
    
    totalPackages++
    const dependencies = extractHceDependencies(packageJson, project.name)
    
    for (const [depName, info] of Object.entries(dependencies)) {
      if (!dependencyMap[depName]) {
        dependencyMap[depName] = {}
      }
      
      if (!dependencyMap[depName][info.version]) {
        dependencyMap[depName][info.version] = []
      }
      
      dependencyMap[depName][info.version].push({
        package: project.name,
        type: info.type
      })
      
      totalDependencies++
    }
  }
  
  console.log(`✅ Scanned ${totalPackages} packages`)
  console.log(`✅ Found ${totalDependencies} @hcengineering dependencies\n`)
  
  return dependencyMap
}

/**
 * Find version mismatches in the dependency map
 * @param {Object} dependencyMap - Map of dependencies to versions
 * @returns {Object} Object with mismatches array and error flag
 */
function findMismatches(dependencyMap) {
  const mismatches = []
  
  for (const [depName, versions] of Object.entries(dependencyMap)) {
    const versionList = Object.keys(versions)
    
    if (versionList.length > 1) {
      mismatches.push({
        dependency: depName,
        versions: versions
      })
    }
  }
  
  return mismatches
}

/**
 * Format and display mismatches
 * @param {Array} mismatches - List of mismatched dependencies
 */
function displayMismatches(mismatches) {
  console.log('━'.repeat(80))
  console.log('❌ VERSION MISMATCHES FOUND')
  console.log('━'.repeat(80))
  console.log()
  
  for (const mismatch of mismatches) {
    console.log(`📦 ${mismatch.dependency}`)
    console.log()
    
    const versionList = Object.keys(mismatch.versions).sort()
    
    for (const version of versionList) {
      const users = mismatch.versions[version]
      console.log(`  Version: ${version}`)
      console.log(`  Used by ${users.length} package(s):`)
      
      // Sort users for consistent output
      users.sort((a, b) => a.package.localeCompare(b.package))
      
      // Show first 10 users, then summarize if more
      const displayUsers = users.slice(0, 10)
      for (const user of displayUsers) {
        console.log(`    - ${user.package} (${user.type})`)
      }
      
      if (users.length > 10) {
        console.log(`    ... and ${users.length - 10} more`)
      }
      
      console.log()
    }
    
    console.log('─'.repeat(80))
    console.log()
  }
}

/**
 * Find mismatches in the lockfile
 * @param {Object} lockfileVersions - Map of package names to version -> dependents mapping
 * @returns {Array} Array of packages with multiple versions in lockfile
 */
function findLockfileMismatches(lockfileVersions) {
  const mismatches = []
  
  for (const [packageName, versionMap] of Object.entries(lockfileVersions)) {
    const versions = Object.keys(versionMap)
    if (versions.length > 1) {
      mismatches.push({
        package: packageName,
        versionMap: versionMap
      })
    }
  }
  
  return mismatches
}

/**
 * Display lockfile mismatches
 * @param {Array} mismatches - Array of lockfile mismatches
 */
function displayLockfileMismatches(mismatches) {
  console.log('━'.repeat(80))
  console.log('❌ LOCKFILE VERSION MISMATCHES FOUND')
  console.log('━'.repeat(80))
  console.log()
  console.log('The following @hcengineering packages have multiple resolved versions')
  console.log('in pnpm-lock.yaml (transitive dependencies):')
  console.log()
  
  for (const mismatch of mismatches) {
    console.log(`📦 ${mismatch.package}`)
    console.log()
    
    const versions = Object.keys(mismatch.versionMap).sort()
    
    for (const version of versions) {
      const dependents = Array.from(mismatch.versionMap[version])
      console.log(`  Version ${version}:`)
      console.log(`    Required by ${dependents.length} package(s):`)
      
      // Sort dependents for consistent output
      dependents.sort()
      
      // Show first 10 dependents, then summarize if more
      const displayDependents = dependents.slice(0, 10)
      for (const dependent of displayDependents) {
        // Clean up the path for better readability
        const cleanPath = dependent.replace(/^\.\.\/\.\.\//, '')
        console.log(`      - ${cleanPath}`)
      }
      
      if (dependents.length > 10) {
        console.log(`      ... and ${dependents.length - 10} more`)
      }
      
      console.log()
    }
    
    console.log('─'.repeat(80))
    console.log()
  }
}

function main() {
  console.log('🚀 Checking @hcengineering dependency versions...\n')
  
  // Get all workspace projects
  const projects = getProjects()
  
  // Build dependency map from package.json files
  const dependencyMap = buildDependencyMap(projects)
  
  // Find mismatches in package.json files
  const packageJsonMismatches = findMismatches(dependencyMap)
  
  // Parse lockfile and find mismatches there
  console.log('🔒 Checking pnpm-lock.yaml for resolved version mismatches...\n')
  const lockfileVersions = parseLockfile()
  const lockfileMismatches = findLockfileMismatches(lockfileVersions)
  
  console.log(`✅ Found ${Object.keys(lockfileVersions).length} unique @hcengineering packages in lockfile`)
  console.log(`${lockfileMismatches.length > 0 ? '❌' : '✅'} Found ${lockfileMismatches.length} packages with multiple resolved versions\n`)
  
  const hasErrors = packageJsonMismatches.length > 0 || lockfileMismatches.length > 0
  
  if (!hasErrors) {
    console.log('━'.repeat(80))
    console.log('✅ SUCCESS - All @hcengineering dependencies use consistent versions!')
    console.log('━'.repeat(80))
    console.log()
    console.log('✓ All package.json dependencies are consistent')
    console.log('✓ All resolved versions in pnpm-lock.yaml are consistent')
    console.log()
    process.exit(0)
  } else {
    if (packageJsonMismatches.length > 0) {
      displayMismatches(packageJsonMismatches)
      console.log(`❌ PACKAGE.JSON ISSUES: Found ${packageJsonMismatches.length} dependencies with mismatched versions`)
      console.log()
    }
    
    if (lockfileMismatches.length > 0) {
      displayLockfileMismatches(lockfileMismatches)
      console.log(`❌ LOCKFILE ISSUES: Found ${lockfileMismatches.length} packages with multiple resolved versions`)
      console.log()
    }
    
    console.log('To fix these issues:')
    console.log('  1. Update package.json files to use consistent versions')
    console.log('  2. Run: pnpm install')
    console.log('  3. Run: pnpm build --force')
    console.log('  4. Run this script again to verify')
    console.log()
    process.exit(1)
  }
}

// Run the script
if (require.main === module) {
  main()
}

module.exports = { 
  getProjects, 
  buildDependencyMap, 
  findMismatches, 
  parseLockfile, 
  findLockfileMismatches 
}
