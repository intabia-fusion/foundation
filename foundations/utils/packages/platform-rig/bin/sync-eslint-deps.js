#!/usr/bin/env node
//
// Copyright © 2025 Hardcore Engineering Inc.
//
// Script to sync ESLint dev dependencies from platform-rig to all workspace packages
//

const fs = require('fs')
const path = require('path')

// ESLint related dependency prefixes to sync
const ESLINT_PATTERNS = ['eslint', '@typescript-eslint/', 'eslint-plugin-', 'eslint-config-']

/**
 * Workspace projects from pnpm-workspace.yaml.
 */
function getRushProjects() {
  return require('./libs/workspace').listWorkspaceProjects()
}

/**
 * Check if a dependency name matches ESLint patterns
 */
function isEslintDependency(depName) {
  return ESLINT_PATTERNS.some((pattern) => depName.startsWith(pattern))
}

/**
 * Find platform-rig in node_modules
 */
function findPlatformRigPath() {
  // Try to find platform-rig in node_modules
  const cwd = process.cwd()
  const possiblePaths = [path.join(cwd, 'common', 'scripts', 'node_modules', '@hcengineering', 'platform-rig')]

  for (const platformRigPath of possiblePaths) {
    const packageJsonPath = path.join(platformRigPath, 'package.json')
    if (fs.existsSync(packageJsonPath)) {
      return platformRigPath
    }
  }

  return null
}

/**
 * Get ESLint dev dependencies from platform-rig package.json
 */
function getEslintDepsFromPlatformRig(platformRigPath) {
  const packageJsonPath = path.join(platformRigPath, 'package.json')

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`platform-rig package.json not found at: ${packageJsonPath}`)
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
  const dependencies = packageJson.dependencies || {}

  const eslintDeps = {}
  for (const [name, version] of Object.entries(dependencies)) {
    if (isEslintDependency(name)) {
      eslintDeps[name] = version
    }
  }

  return eslintDeps
}

/**
 * Update package.json with ESLint dependencies
 */
function updatePackageJson(packagePath, eslintDeps) {
  const packageJsonPath = path.join(packagePath, 'package.json')

  if (!fs.existsSync(packageJsonPath)) {
    console.warn(`⚠️  package.json not found at: ${packageJsonPath}`)
    return { updated: false, changes: [] }
  }

  const content = fs.readFileSync(packageJsonPath, 'utf-8')
  const packageJson = JSON.parse(content)

  // Skip if this is the platform-rig package itself
  if (packageJson.name === '@hcengineering/platform-rig') {
    return { updated: false, changes: [] }
  }

  // Initialize devDependencies if it doesn't exist
  if (!packageJson.devDependencies) {
    packageJson.devDependencies = {}
  }

  const changes = []
  let hasChanges = false

  // Add or update ESLint dependencies
  for (const [name, version] of Object.entries(eslintDeps)) {
    const currentVersion = packageJson.devDependencies[name]

    if (currentVersion !== version) {
      packageJson.devDependencies[name] = version
      hasChanges = true

      if (currentVersion) {
        changes.push(`  ${name}: ${currentVersion} → ${version}`)
      } else {
        changes.push(`  ${name}: (new) → ${version}`)
      }
    }
  }

  if (hasChanges) {
    // Preserve original formatting by maintaining indent detection
    const indent = content.match(/^(\s+)/m)?.[1]?.length || 2
    const newContent = JSON.stringify(packageJson, null, indent) + '\n'
    fs.writeFileSync(packageJsonPath, newContent, 'utf-8')
  }

  return { updated: hasChanges, changes }
}

/**
 * Main execution
 */
function main() {
  console.log('🔍 Syncing ESLint dependencies from platform-rig to all packages...\n')

  try {
    // Find platform-rig in node_modules
    const platformRigPath = findPlatformRigPath()
    if (!platformRigPath) {
      console.log('⚠️  platform-rig package not found in node_modules. Skipping sync.')
      console.log('   Make sure @hcengineering/platform-rig is installed as a dependency.')
      return
    }

    console.log(`📍 Found platform-rig at: ${platformRigPath}\n`)

    // Get ESLint dependencies from platform-rig
    const eslintDeps = getEslintDepsFromPlatformRig(platformRigPath)

    if (Object.keys(eslintDeps).length === 0) {
      console.log('⚠️  No ESLint dependencies found in platform-rig')
      return
    }

    console.log('📦 ESLint dependencies from platform-rig:')
    for (const [name, version] of Object.entries(eslintDeps)) {
      console.log(`  ${name}: ${version}`)
    }
    console.log()

    // Get all workspace projects
    const projects = getRushProjects()
    console.log(`Found ${projects.length} projects in workspace\n`)

    // Update all packages
    let updatedCount = 0
    let skippedCount = 0

    for (const project of projects) {
      const result = updatePackageJson(project.fullPath, eslintDeps)

      if (result.updated) {
        updatedCount++
        console.log(`✅ Updated ${project.name}`)
        result.changes.forEach((change) => console.log(change))
        console.log()
      } else if (result.changes.length === 0 && project.name !== '@hcengineering/platform-rig') {
        skippedCount++
      }
    }

    console.log('━'.repeat(50))
    console.log(`✨ Sync complete!`)
    console.log(`   Updated: ${updatedCount} package(s)`)
    console.log(`   Skipped: ${skippedCount} package(s) (already up-to-date)`)

    if (updatedCount > 0) {
      console.log('\n💡 Don\'t forget to run "rush update" to install the updated dependencies')
    }
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`)
    process.exit(1)
  }
}

// Run the script
main()
