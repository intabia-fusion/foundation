/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

'use strict'

// Gathers vX.Y.Z tags newer than the last version in changelog.md, groups their
// commits by category and appends a formatted section. Default is dry-run; --apply
// writes changelog.md. Options: --origin <remote> (default origin), --from <version>.

const fs = require('fs')
const path = require('path')
const child_process = require('child_process')

const CHANGELOG_PATH = path.join(__dirname, '..', '..', 'changelog.md')
const DEFAULT_REMOTE = 'origin'

function run (cmd, opts = {}) {
  try {
    return child_process.execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim()
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : ''
    const stdout = err.stdout ? err.stdout.toString() : ''
    throw new Error(`Command failed: ${cmd}\nstdout: ${stdout}\nstderr: ${stderr}\n${err.message}`)
  }
}

function parseVersion (v) {
  // v is like "0.7.318" or "v0.7.318"
  const m = v.match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), text: `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` }
}

function cmpVersion (a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

function formatDateISO (iso) {
  // expect iso like 2026-01-11T12:34:56+00:00 -> return YYYY-MM-DD
  if (!iso) return ''
  return iso.slice(0, 10)
}

function stripSignedOff (text) {
  if (!text) return ''
  return text.split('\n').filter(line => !/^\s*Signed-off-by:/i.test(line)).join('\n').trim()
}

function normalizeSubject (s) {
  return s.replace(/\s+/g, ' ').trim()
}

function isMergeSubject (s) {
  return /^\s*Merge\b/i.test(s) || /Merge remote-tracking/i.test(s)
}

function extractConventionalType (subject) {
  // e.g., "feat(scope): description" or "fix: something"
  const m = subject.match(/^([a-zA-Z]+)(\([^)]+\))?:\s*(.*)$/)
  if (!m) return null
  return { type: m[1].toLowerCase(), rest: m[3].trim() }
}

function isSubstantialCommit (subject, body) {
  // Heuristics for 'substantial' (True == include)
  const subjectTrim = subject.trim()
  const cc = extractConventionalType(subjectTrim)
  if (cc) {
    const t = cc.type
    if (['feat', 'fix', 'perf', 'security', 'revert'].includes(t)) return true
    // treat 'refactor' as non-substantial by default unless it references an issue
    if (t === 'refactor' && /#\d+/.test(subjectTrim)) return true
    return false
  }
  // if mentions issue/PR number, include
  if (/#\d+/.test(subjectTrim)) return true
  // keywords that likely indicate substantive change
  if (/\b(add|adds|added|support|implement|implements|introduced|introduce|enable|disable|remove|fix(?:es|ed)?|resolve|upgrade|update|improv|allow|migrate|switch)\b/i.test(subjectTrim)) {
    // but exclude obvious chore/update changelog/README/bump
    if (/^\s*(update|bump)\b/i.test(subjectTrim) && /\b(changelog|readme|readme.md|package.json|version)\b/i.test(subjectTrim)) {
      return false
    }
    // exclude 'format', 'lint', 'ci', 'test', 'docs', 'chore' starting messages
    if (/^\s*(format|lint|ci|test|docs?|chore)\b/i.test(subjectTrim)) return false
    return true
  }
  return false
}

function categorizeCommit (subject) {
  const subjectTrim = subject.trim()
  const cc = extractConventionalType(subjectTrim)
  if (cc) {
    const t = cc.type
    switch (t) {
      case 'feat': return { cat: 'FEATURES', emoji: '🚀' }
      case 'fix': return { cat: 'BUG FIXES', emoji: '🐛' }
      case 'perf': return { cat: 'PERFORMANCE', emoji: '⚡' }
      case 'security': return { cat: 'SECURITY', emoji: '🔒' }
      case 'revert': return { cat: 'REVERTS', emoji: '↩️' }
      default: return { cat: 'MISCELLANEOUS TASKS', emoji: '⚙️' }
    }
  }
  // heuristic keyword categories
  if (/\bfix(?:es|ed)?\b/i.test(subjectTrim)) return { cat: 'BUG FIXES', emoji: '🐛' }
  if (/\b(perf|performance)\b/i.test(subjectTrim)) return { cat: 'PERFORMANCE', emoji: '⚡' }
  if (/\b(security|vuln|vulnerability)\b/i.test(subjectTrim)) return { cat: 'SECURITY', emoji: '🔒' }
  if (/\b(add|support|implement|introduce|enable)\b/i.test(subjectTrim)) return { cat: 'FEATURES', emoji: '🚀' }
  return { cat: 'MISCELLANEOUS TASKS', emoji: '⚙️' }
}

function readChangelog (filePath) {
  const raw = fs.readFileSync(filePath, { encoding: 'utf-8' })
  return raw
}

function findLastVersionInChangelog (changelogText) {
  // Find first header that is a version (skipping [unreleased])
  // Look for the first occurrence of "## [<semver>] - yyyy-mm-dd"
  // We search top to bottom and return the first semver header found that is not '[unreleased]'.
  const lines = changelogText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^## \[(?!unreleased\b)(\d+\.\d+\.\d+)\]/i)
    if (m) {
      return { version: m[1], headerLineIndex: i }
    }
  }
  // not found - fallback to 0.0.0
  return { version: '0.0.0', headerLineIndex: lines.length }
}

function tagsFromLsRemoteOutput (lsOutput) {
  // Parse output lines like:
  // 9fceb02...    refs/tags/v0.7.319
  // <hash>    refs/tags/v0.7.319^{}
  const lines = lsOutput.split(/\r?\n/).filter(Boolean)
  const tags = new Set()
  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    const ref = parts[1]
    const m = ref.match(/^refs\/tags\/(.+)$/)
    if (!m) continue
    let tag = m[1]
    // If annotated tag deref appears as v0.7.319^{} we strip ^{}
    tag = tag.replace(/\^\{\}$/, '')
    // Only consider tags that look like vX.Y.Z
    if (/^v?\d+\.\d+\.\d+$/.test(tag)) {
      tags.add(tag)
    }
  }
  return Array.from(tags)
}

function semverKey (tag) {
  const v = parseVersion(tag)
  if (!v) return '0.0.0'
  return `${String(v.major).padStart(6, '0')}.${String(v.minor).padStart(6, '0')}.${String(v.patch).padStart(6, '0')}`
}

function sortSemverTags (tags) {
  return tags.slice().sort((a, b) => {
    const pa = parseVersion(a)
    const pb = parseVersion(b)
    if (!pa || !pb) return a.localeCompare(b)
    return cmpVersion(pa, pb)
  })
}

function tagExistsInChangelog (changelogText, versionText) {
  const regex = new RegExp(`^## \\[${versionText.replace(/\./g, '\\.')}\\]`, 'm')
  return regex.test(changelogText)
}

function getTagDate (tag) {
  // Get an ISO-like date for the tag. Annotated tags produce a multi-line
  // `git show` output; take the last non-empty line that looks like an ISO timestamp.
  try {
    const raw = run(`git show -s --format=%cI ${tag}`)
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    // Prefer the last line that looks like an ISO datetime
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i]
      if (/^\d{4}-\d{2}-\d{2}T/.test(ln)) return formatDateISO(ln)
    }
    // Fallback: first line that looks like a date
    for (const ln of lines) {
      if (/^\d{4}-\d{2}-\d{2}/.test(ln)) return formatDateISO(ln)
    }
    return ''
  } catch (err) {
    // fall back to today's date
    return (new Date()).toISOString().slice(0, 10)
  }
}

function getCommitsBetween (fromTag, toTag) {
  // returns array of {hash, subject, body}
  // Use --no-merges to filter merge commits
  // Use ASCII separators to parse safely
  const format = '%h%x1f%s%x1f%b%x1e'
  let cmd = `git log --no-merges --pretty=format:"${format}" ${fromTag}..${toTag}`
  let out = ''
  try {
    out = run(cmd)
  } catch (err) {
    // If command fails (e.g., range doesn't exist), return empty
    return []
  }
  if (!out) return []
  const rawCommits = out.split('\x1e').map(s => s.trim()).filter(Boolean)
  const commits = rawCommits.map(raw => {
    const [hash, subject, body] = raw.split('\x1f')
    return { hash: (hash || '').trim(), subject: (subject || '').trim(), body: stripSignedOff(body || '') }
  })
  return commits
}

function buildVersionBlock (version, date, prevTag, tag, commits) {
  // commits is array of {hash, subject, body} and already filtered (no merges) and considered 'substantial'
  // Group by categories
  const groups = new Map() // cat -> {emoji, items: [subjects]}
  const order = []
  for (const c of commits) {
    const catInfo = categorizeCommit(c.subject)
    const key = catInfo.cat
    if (!groups.has(key)) {
      groups.set(key, { emoji: catInfo.emoji, items: [] })
      order.push(key)
    }
    const item = normalizeSubject(c.subject)
    groups.get(key).items.push(item)
  }

  const lines = []
  lines.push(`## [${version}] - ${date}`)
  lines.push('')
  // Add category summaries: for each category, join up to N titles with ' · ' separator
  for (const cat of order) {
    const info = groups.get(cat)
    // dedupe short subjects while preserving order
    const uniq = Array.from(new Set(info.items))
    // Summary line item limit (remains in full list).
    const summaryItems = uniq.slice(0, 6)
    const summary = summaryItems.join(' · ')
    lines.push(`* ${info.emoji} ${cat}: · ${summary}`)
  }

  // Full commit list intentionally omitted to keep changelog concise.
  if (commits.length === 0) {
    lines.push('')
    lines.push('* ⚙️ MISCELLANEOUS TASKS: No substantive changes (all commits were merges or non-substantial)')
  } else {
    lines.push('')
  }
  lines.push('')
  return lines.join('\n')
}

function usageAndExit () {
  console.log('Usage:')
  console.log('  node update-changelog.js [--apply] [--origin <remote>] [--from <version>]')
  console.log('')
  console.log('Options:')
  console.log('  --apply          Apply changes to changelog.md (otherwise dry-run)')
  console.log('  --origin <name>  Git remote name to inspect tags on (default: origin)')
  console.log('  --from <version> Override last known version in changelog (format: X.Y.Z)')
  process.exit(0)
}

function main () {
  const argv = process.argv.slice(2)
  const doApply = argv.includes('--apply')
  if (argv.includes('--help') || argv.includes('-h')) usageAndExit()

  const originIndex = argv.indexOf('--origin')
  const remote = originIndex >= 0 && argv.length > originIndex + 1 ? argv[originIndex + 1] : DEFAULT_REMOTE

  // Safety: ensure we inspect tags on the intabia-fusion/foundation remote by default.
  // If you really want to use another remote, pass --allow-other-remote (or --force).
  let remoteUrl = ''
  try {
    remoteUrl = run(`git remote get-url ${remote}`)
  } catch (err) {
    console.warn('[update-changelog] Could not read remote URL for', remote)
  }
  const allowOtherRemote = argv.includes('--allow-other-remote') || argv.includes('--force')
  if (!allowOtherRemote && remoteUrl && !/intabia-fusion\/foundation/i.test(remoteUrl)) {
    console.error(`[update-changelog] Remote '${remote}' URL does not look like intabia-fusion/foundation: ${remoteUrl}`)
    console.error("If you really want to use this remote, re-run with --allow-other-remote or --force")
    process.exit(1)
  }

  let overrideFrom = null
  const fromIndex = argv.indexOf('--from')
  if (fromIndex >= 0 && argv.length > fromIndex + 1) {
    overrideFrom = argv[fromIndex + 1]
    if (!/^\d+\.\d+\.\d+$/.test(overrideFrom)) {
      console.error('--from should be semver like X.Y.Z')
      process.exit(1)
    }
  }

  if (!fs.existsSync(CHANGELOG_PATH)) {
    console.error('changelog.md not found at expected path:', CHANGELOG_PATH)
    process.exit(1)
  }

  console.log('[update-changelog] Reading changelog ...')
  const changelogText = readChangelog(CHANGELOG_PATH)
  const lastVersionInfo = findLastVersionInChangelog(changelogText)
  const lastVersion = overrideFrom || lastVersionInfo.version
  console.log(`[update-changelog] Last version in changelog: ${lastVersion}`)

  console.log(`[update-changelog] Inspecting remote tags on '${remote}' ...`)
  let lsRemote = ''
  try {
    lsRemote = run(`git ls-remote --tags ${remote}`)
  } catch (err) {
    console.error(`Failed to list remote tags from ${remote}:`, err.message)
    process.exit(1)
  }

  let remoteTags = tagsFromLsRemoteOutput(lsRemote)
  if (remoteTags.length === 0) {
    console.log('[update-changelog] No semver tags (vX.Y.Z) found on remote. Nothing to do.')
    process.exit(0)
  }

  // Use only tags that look like vX.Y.Z
  remoteTags = remoteTags.filter(t => /^v?\d+\.\d+\.\d+$/.test(t))
  // Normalize to v-prefixed tags for processing (we use exact remote tag names fetched)
  remoteTags = remoteTags.map(t => t.startsWith('v') ? t : `v${t}`)

  // Sort semver ascending
  remoteTags = sortSemverTags(remoteTags)

  // Determine which tags are strictly greater than lastVersion
  const lastParsed = parseVersion(lastVersion)
  if (!lastParsed) {
    console.error('Last version in changelog is not a valid semver:', lastVersion)
    process.exit(1)
  }

  const tagsToProcess = remoteTags.filter(t => {
    const p = parseVersion(t)
    if (!p) return false
    return cmpVersion(p, lastParsed) > 0
  })

  if (tagsToProcess.length === 0) {
    console.log('[update-changelog] No remote tags newer than', lastVersion, 'Nothing to add.')
    process.exit(0)
  }

  // Skip tags already present in changelog (safety)
  const filteredTags = tagsToProcess.filter(t => {
    const v = parseVersion(t)
    if (!v) return false
    return !tagExistsInChangelog(changelogText, v.text)
  })

  if (filteredTags.length === 0) {
    console.log('[update-changelog] All tags newer than', lastVersion, 'already present in changelog. Nothing to do.')
    process.exit(0)
  }

  console.log('[update-changelog] Will process tags (ascending):', filteredTags.join(', '))

  // Fetch tags from remote so we can run git log on them
  console.log(`[update-changelog] Fetching tags from ${remote} ...`)
  try {
    run(`git fetch --tags ${remote}`)
  } catch (err) {
    console.error('[update-changelog] Failed to fetch tags:', err.message)
    process.exit(1)
  }

  // Build a list including the starting anchor (lastVersion) so ranges are well-defined
  // If v<lastVersion> exists in remoteTags (or in local tags after fetch) use that as anchor.
  const anchorTag = `v${lastVersion}`
  let anchorExists = remoteTags.includes(anchorTag)
  // if not present, try to use the latest tag less than or equal to lastVersion from remoteTags
  if (!anchorExists) {
    console.warn(`[update-changelog] Anchor tag ${anchorTag} not found on remote. Trying to find nearest tag <= ${lastVersion} ...`)
    const lesser = remoteTags.filter(t => {
      const p = parseVersion(t)
      return cmpVersion(p, lastParsed) <= 0
    })
    if (lesser.length > 0) {
      const lastLower = lesser[lesser.length - 1]
      console.warn(`[update-changelog] Using ${lastLower} as anchor instead of ${anchorTag}`)
      anchorExists = true
    } else {
      console.warn('[update-changelog] No suitable anchor tag found on remote; commits will be calculated from repository root (might be noisy)')
    }
  }

  // We'll iterate over filteredTags ascending and compute prevTag..tag ranges,
  // where prevTag is either previous tag in sequence or anchor for the first one.
  const processedBlocks = []
  let prevTag = anchorExists && remoteTags.includes(anchorTag) ? anchorTag : null
  // If prevTag is null and there is a tag smaller than the first tagToProcess, try to find it
  if (!prevTag) {
    // find the immediate tag less than first filteredTag
    const firstTag = filteredTags[0]
    const firstParsed = parseVersion(firstTag)
    const less = remoteTags.filter(t => cmpVersion(parseVersion(t), firstParsed) < 0)
    if (less.length > 0) prevTag = less[less.length - 1]
  }
  // If still null, fallback to the empty tree (will give full log)
  if (!prevTag) prevTag = ''

  for (const tag of filteredTags) {
    const versionParsed = parseVersion(tag)
    if (!versionParsed) continue
    const versionText = versionParsed.text
    // get commits between prevTag..tag
    const rangeDescr = prevTag ? `${prevTag}..${tag}` : `${tag}`
    console.log(`[update-changelog] Gathering commits for ${tag} (${rangeDescr}) ...`)
    const rawCommits = prevTag ? getCommitsBetween(prevTag, tag) : getCommitsBetween('', tag)

    // Filter out merges as defensive measure (git log used --no-merges already), and remove signed-off footers
    let commitsFiltered = rawCommits
      .filter(c => !isMergeSubject(c.subject))
      .map(c => ({ hash: c.hash, subject: normalizeSubject(c.subject), body: stripSignedOff(c.body) }))

    // Keep only 'substantial' commits
    commitsFiltered = commitsFiltered.filter(c => isSubstantialCommit(c.subject, c.body))

    if (commitsFiltered.length === 0) {
      console.log(`[update-changelog] No substantial commits found for ${tag}; skipping (will not create changelog entry).`)
      // advance prevTag
      prevTag = tag
      continue
    }

    // Get tag date
    const date = getTagDate(tag) || ''

    // Build block
    const blockText = buildVersionBlock(versionText, date, prevTag || '(initial)', tag, commitsFiltered)
    processedBlocks.push({ tag, version: versionText, text: blockText })

    // advance prevTag
    prevTag = tag
  }

  if (processedBlocks.length === 0) {
    console.log('[update-changelog] No new substantive changelog entries to add (all newer tags had no substantial commits).')
    process.exit(0)
  }

  // Insert new blocks into changelog text after the 'unreleased' section (before first version header)
  // Find insertion point: the first '## [' header that is not 'unreleased' (we have headerLineIndex)
  const lines = changelogText.split(/\r?\n/)
  const insertLine = lastVersionInfo.headerLineIndex
  // We will build new text: head (0..insertLine-1) + NEW_BLOCKS (in descending order newest first) + rest (insertLine..end)
  const head = lines.slice(0, insertLine).join('\n')
  const tail = lines.slice(insertLine).join('\n')

  // Processed blocks are in ascending order (older -> newer). The changelog expects newest first, so reverse order.
  const blocksInDesiredOrder = processedBlocks.slice().reverse().map(b => b.text).join('\n').trim()

  const newChangelogText = `${head}\n\n${blocksInDesiredOrder}\n\n${tail}`.replace(/\n{3,}/g, '\n\n') // compress excessive blank lines

  console.log(`\n[update-changelog] Proposed changelog additions (${processedBlocks.length} version(s)):\n`)
  for (const b of processedBlocks) {
    console.log(`--- ${b.version} (${b.tag}) ---`)
    console.log(b.text)
    console.log('')
  }

  if (doApply) {
    // Write file
    try {
      fs.writeFileSync(CHANGELOG_PATH, newChangelogText + '\n', { encoding: 'utf-8' })
      console.log(`[update-changelog] changelog.md updated with ${processedBlocks.length} new version(s).`)
    } catch (err) {
      console.error('[update-changelog] Failed to write changelog.md:', err.message)
      process.exit(1)
    }
  } else {
    console.log('[update-changelog] Dry run (no file written). To apply changes run with --apply')
  }
  process.exit(0)
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    console.error('[update-changelog] Error:', err.message)
    console.error(err.stack)
    process.exit(1)
  }
}
