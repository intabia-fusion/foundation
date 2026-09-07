#!/usr/bin/env node
//
// Copyright © 2026 Intabia Fusion
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

// Scans workspace dependencies, pulls upstream release notes and writes
// combined_dependencies/UPGRADE.md grouped by component.
//
// Usage: node common/scripts/outdated.js [--force] [--category ui,server] [--no-notes]
// Env: SKIP_PACKAGES (default "@tiptap/"), CACHE_TTL_DAYS (default 7), MAX_RELEASES (25), MAX_PAGES (5)

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = process.cwd()
const DEPS_DIR = path.join(ROOT, 'combined_dependencies')
const CACHE_DIR = path.join(DEPS_DIR, 'cache')
const NOTES_DIR = path.join(DEPS_DIR, 'changes')
const SKIP = (process.env.SKIP_PACKAGES ?? '@tiptap/').split(',').filter((s) => s.length > 0)
const TTL_MS = Number(process.env.CACHE_TTL_DAYS ?? 7) * 86400_000
const MAX_RELEASES = Number(process.env.MAX_RELEASES ?? 25)
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 5)
const FORCE = process.argv.includes('--force')
const NO_NOTES = process.argv.includes('--no-notes')
const catArg = process.argv[process.argv.indexOf('--category') + 1]
const SCOPE_FILTER = process.argv.includes('--category') ? catArg.split(',') : undefined

const BREAKING =
  /BREAKING[ -]CHANGE|BREAKING:|breaking changes?|drop(ped)? (support|node)|requires Node|minimum Node|ESM[- ]only|migration guide|upgrade guide|removed (the )?(deprecated|support|option|method|api)|is now removed|has been removed|were removed|deprecat/i
const SECURITY =
  /CVE-\d{4}-\d+|GHSA-[a-z0-9-]+|security (fix|advisory|patch)|ReDoS|prototype pollution|(header|log|command|sql) injection|vulnerab/i

// --- component mapping -------------------------------------------------------

// Package-name rules win over consumer paths; first match decides, one category per package.
const NAME_RULES = [
  // node runtime + its typings: bump in lockstep with the Node version the repo targets
  [/^node$|^@tsconfig\/node/i, 'node'],
  [/^@opentelemetry\//i, 'otel'],
  [/^@hocuspocus\/|^yjs$|^y-[a-z]|^lib0$/i, 'collaboration-server'],
  [/^livekit|^@livekit\//i, 'livekit'],
  [/^(openai|gigachat|js-tiktoken)$|^@deepgram\//i, 'ai'],
  [/^(mongodb|bson|postgres|pg|minio|snappy|snappyjs)$|^@elastic\/|^@aws-sdk\/(client-s3|lib-storage|s3-request-presigner)|^@smithy\//i, 'dbs'],
  [/^(uuid|morgan|fast-equals|fast-copy|hash-it|lru-cache|dotenv|commander|zod|big-integer|filesize|lexorank|msgpackr|msgpackr-extract|winston|utf-8-validate|bufferutil)$|^@node-rs\//i, 'core'],
  [/eslint|prettier/i, 'lint'],
  [/^electron|^@electron\//i, 'desktop'],
  [/^@?storybook|^@storybook\/|^(@playwright\/)?playwright|jest|^@testing-library|^allure|^@faker-js\/|^smee-client/i, 'test'],
  [/svelte/i, 'svelte'],
  [
    /webpack|-loader$|^node-loader|postcss|^sass|autoprefixer|browserslist|^esbuild|^typescript$|^assemblyscript|^svgo|tailwindcss|^cross-env|^@tsconfig\/|^update-browserslist|^fork-ts|^copy-|^compression-|^mini-css|^style-|^css-|^html-webpack|^@vercel\/webpack/i,
    'build'
  ],
  [/^(express|koa|cors|ws|body-parser|on-headers|compression|qs|cookies|http-proxy|request|form-data)$|^express-|^koa-|^koa\/|^@koa\//i, 'web'],
  [
    /^(googleapis|google-auth-library|gaxios|octokit|telegram|stripe|nodemailer|openid-client|maxmind|puppeteer|oembed-providers|graphql)$|^@(octokit|telegraf|polar-sh)\/|^@aws-sdk\/client-ses|^passport/i,
    'integrations'
  ],
  [
    /^(pdf-lib|pdfjs-dist|mammoth|docx4js|node-poppler|jimp|sharp|turndown|markdown-it|htmlparser2|domhandler|domutils|cheerio|sanitize-html|dompurify|html-to-text|csv-parse|csv-stringify|csvtojson|archiver|tar|tar-stream|autolinker|highlight\.js|image-size|mime|mime-types|slugify|js-yaml|heic-decode|puppeteer|node-forge)$|^@signpdf\//i,
    'content'
  ]
]

function pathCategory (file, kind) {
  const p = file.replace(/^\.\//, '')
  if (/^desktop/.test(p)) return 'desktop'
  if (/^(tests|ws-tests|qms-tests)\//.test(p) || /^dev\/(storybook|test-base|benchmarks)/.test(p)) return 'test'
  if (/^common\//.test(p)) return 'build'
  if (/^services\//.test(p)) return 'services'
  if (/^(server|server-plugins|pods|dev)\//.test(p) || /^foundations\/server/.test(p)) return 'server'
  if (/^plugins\//.test(p)) return 'ui'
  if (/^packages\/(ui|theme|presentation|panel|kanban|highlight|hls)/.test(p)) return 'ui'
  return 'core'
}

// @types/x follows the category of x
function nameCategory (name) {
  const target = name.startsWith('@types/') ? name.slice(7).replace('__', '/') : name
  return NAME_RULES.find(([re]) => re.test(target))?.[1]
}

const CATEGORIES = ['core', 'ui', 'svelte', 'web', 'dbs', 'ai', 'livekit', 'otel', 'collaboration-server', 'integrations', 'content', 'server', 'services', 'desktop', 'node', 'build', 'lint', 'test']

// --- semver ------------------------------------------------------------------

function listPackageFiles (dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'combined_dependencies') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listPackageFiles(full, acc)
    else if (entry.name === 'package.json') acc.push(full)
  }
  return acc
}

const stripJsonComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function parse (v) {
  const m = /^[^\d]*(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(String(v).trim())
  return m === null ? undefined : { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] }
}

function bumpKind (from, to) {
  const a = parse(from)
  const b = parse(to)
  if (a === undefined || b === undefined) return 'unknown'
  if (a.major !== b.major) return 'major'
  if (a.minor !== b.minor) return a.major === 0 ? 'major' : 'minor' // 0.x: minor is breaking
  if (a.patch !== b.patch) return a.major === 0 ? 'minor' : 'patch'
  return a.pre !== b.pre ? 'patch' : 'same'
}

function cmp (x, y) {
  const a = parse(x)
  const b = parse(y)
  if (a === undefined || b === undefined) return 0
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    (a.pre === b.pre ? 0 : a.pre === undefined ? 1 : b.pre === undefined ? -1 : a.pre < b.pre ? -1 : 1)
  )
}

const isStable = (v) => parse(v)?.pre === undefined

// Node typings must not run ahead of the runtime the repo targets (rush.json nodeSupportedVersionRange).
function nodeTargetMajor () {
  if (process.env.NODE_TARGET_MAJOR !== undefined) return Number(process.env.NODE_TARGET_MAJOR)
  try {
    const range = JSON.parse(stripJsonComments(fs.readFileSync(path.join(ROOT, 'rush.json'), 'utf8'))).nodeSupportedVersionRange
    const max = /<\s*(\d+)\./.exec(range ?? '')
    if (max !== null) return Number(max[1]) - 1
  } catch (err) {
    /* fall through */
  }
  return Number(process.versions.node.split('.')[0])
}
const NODE_MAJOR = nodeTargetMajor()

// Deliberate holds: common/config/dependency-pins.json
const PINS = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'common/config/dependency-pins.json'), 'utf8')).pins ?? {}
  } catch (err) {
    return {}
  }
})()

function capMajor (versions, max, fallback) {
  return versions.filter((v) => isStable(v) && parse(v).major <= max).sort(cmp).pop() ?? fallback
}

// --- cache -------------------------------------------------------------------

fs.mkdirSync(CACHE_DIR, { recursive: true })
fs.mkdirSync(NOTES_DIR, { recursive: true })

async function cached (key, fn) {
  const file = path.join(CACHE_DIR, key.replace(/[/@:]/g, '_') + '.json')
  if (!FORCE && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < TTL_MS) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      /* refetch on corrupt cache */
    }
  }
  const data = await fn()
  fs.writeFileSync(file, JSON.stringify(data))
  return data
}

let ghToken
try {
  ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
} catch (err) {
  console.warn('gh auth token unavailable, GitHub API calls are rate limited to 60/hour')
}

async function gh (endpoint) {
  const res = await fetch(`https://api.github.com/${endpoint}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(ghToken !== undefined ? { authorization: `Bearer ${ghToken}` } : {})
    }
  })
  if (!res.ok) return undefined
  return await res.json()
}

async function npmMeta (pkg) {
  return await cached(`npm_${pkg}`, async () => {
    const [all, latest] = await Promise.all([
      fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' }
      }).then((r) => (r.ok ? r.json() : undefined)),
      fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`).then((r) => (r.ok ? r.json() : undefined))
    ])
    if (all === undefined) return { versions: [], latest: undefined, repo: undefined }
    const repoUrl = latest?.repository?.url ?? latest?.repository ?? ''
    const repo = /github\.com[:/]([^/]+\/[^/#]+?)(\.git|$|\/)/.exec(String(repoUrl))?.[1]
    return { versions: Object.keys(all.versions ?? {}), latest: all['dist-tags']?.latest, repo }
  })
}

// --- workspace scan ----------------------------------------------------------

function collectDeps () {
  const deps = new Map()
  const workspaceNames = new Set()
  // every package.json in the tree: rush.json misses nested workspaces (foundations/net, foundations/core)
  const files = listPackageFiles(ROOT).filter((f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')).name !== undefined
    } catch (err) {
      return false
    }
  })
  for (const file of files) {
    workspaceNames.add(JSON.parse(fs.readFileSync(file, 'utf8')).name)
  }
  for (const file of files) {
    const rel = path.relative(ROOT, file)
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const [kind, field] of [['prod', 'dependencies'], ['prod', 'optionalDependencies'], ['dev', 'devDependencies']]) {
      for (const [name, range] of Object.entries(json[field] ?? {})) {
        if (workspaceNames.has(name) || String(range).startsWith('workspace:')) continue
        if (SKIP.some((s) => name.startsWith(s))) continue
        const d = deps.get(name) ?? { ranges: new Set(), prod: 0, dev: 0, byPath: new Map() }
        d.ranges.add(range)
        d[kind]++
        const c = pathCategory(rel, kind)
        d.byPath.set(c, (d.byPath.get(c) ?? 0) + 1)
        deps.set(name, d)
      }
    }
  }
  fs.writeFileSync(path.join(DEPS_DIR, 'package_list.txt'), files.map((f) => path.relative(ROOT, f)).join('\n') + '\n')
  return { deps, packageCount: files.length }
}

// --- upstream notes ----------------------------------------------------------

async function releaseNotes (pkg, repo, cur, latest) {
  const base = pkg.replace(/.*\//, '')
  const out = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rels = await cached(`gh_${repo}_releases_p${page}`, async () => (await gh(`repos/${repo}/releases?per_page=100&page=${page}`)) ?? [])
    if (!Array.isArray(rels) || rels.length === 0) break
    let belowStreak = 0
    for (const rel of rels) {
      const tag = String(rel.tag_name ?? '')
      const prefix = tag.replace(/[@/]?v?\d.*$/, '')
      if (prefix.length > 0 && prefix !== base && prefix !== pkg) continue // sibling package in a monorepo
      const v = tag.replace(/.*[@/]/, '').replace(/^v/, '')
      if (cmp(v, cur) <= 0) {
        // maintenance branches (ws ships 7.x/6.x backports between 8.x releases) are interleaved,
        // so only a run of older releases means we are past the range
        if (++belowStreak >= 10) break
        continue
      }
      belowStreak = 0
      if (cmp(v, latest) > 0) continue
      if (out.length >= MAX_RELEASES) {
        out.push(`\n... обрезано на ${MAX_RELEASES} релизах`)
        return out
      }
      out.push(`\n### ${tag}\n${String(rel.body ?? '').split('\n').slice(0, 60).join('\n')}`)
    }
    if (belowStreak >= 10) break
  }
  return out
}

async function changelogFallback (repo, cur, latest) {
  const tags = await cached(`gh_${repo}_tags`, async () => (await gh(`repos/${repo}/tags?per_page=100`)) ?? [])
  const names = (Array.isArray(tags) ? tags : []).map((t) => t.name)
  const find = (v) => names.find((n) => new RegExp(`(^|[v@/])${v.replace(/\./g, '\\.')}$`).test(n))
  const from = find(cur)
  let to = find(latest)
  if (to === undefined) {
    const info = await cached(`gh_${repo}_info`, async () => (await gh(`repos/${repo}`)) ?? {})
    to = info.default_branch
  }
  if (from === undefined || to === undefined) return ['\n(релизов и подходящих тегов не найдено)']
  const c = await cached(`gh_${repo}_compare_${from}_${to}`, async () => (await gh(`repos/${repo}/compare/${from}...${to}`)) ?? {})
  const patch = (c.files ?? [])
    .filter((f) => /changelog|history\.md/i.test(f.filename))
    .map((f) => f.patch ?? '')
    .join('\n')
    .split('\n')
    .filter((l) => l.startsWith('+'))
    .slice(0, 400)
  if (patch.length > 0) return [`\n## CHANGELOG ${from}...${to}\n${patch.join('\n')}`]
  const commits = (c.commits ?? []).map((x) => `- ${x.commit.message.split('\n')[0]}`).slice(0, 100)
  return [`\n## коммиты ${from}...${to}\n${commits.join('\n')}`]
}

async function collectNotes (row) {
  const file = path.join(NOTES_DIR, `${row.name.replace(/\//g, '__')}.md`)
  const header = `# ${row.name} ${row.current} -> ${row.latest}`
  if (!FORCE && fs.existsSync(file) && fs.readFileSync(file, 'utf8').startsWith(header)) {
    return fs.readFileSync(file, 'utf8')
  }
  const parts = [header, '', `npm: https://www.npmjs.com/package/${row.name}`]
  if (row.repo !== undefined) parts.push(`repo: https://github.com/${row.repo}`)
  parts.push('', '## версии в диапазоне', ...row.between.slice(-50).map((v) => `- ${v}`), '')
  if (row.repo !== undefined) {
    const notes = await releaseNotes(row.name, row.repo, row.current, row.latest)
    parts.push(...(notes.length > 0 ? ['## release notes', ...notes] : await changelogFallback(row.repo, row.current, row.latest)))
  } else {
    parts.push('(GitHub-репозиторий не указан в npm-метаданных)')
  }
  const text = parts.join('\n') + '\n'
  fs.writeFileSync(file, text)
  return text
}

// --- report ------------------------------------------------------------------

function markers (text, re) {
  return text
    .split('\n')
    .filter((l) => re.test(l) && !/^\s*[-+]?\s*(chore|ci)\b/i.test(l))
    .map((l) => l.replace(/^[+-]\s*/, '').trim().slice(0, 300))
    .slice(0, 10)
}

const anchor = (name) => name.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')

function table (rows) {
  return [
    '| package | версии | bump | breaking | security | prod/dev |',
    '|---|---|---|---|---|---|',
    ...rows.map(
      (r) => `| [${r.name}](#${anchor(r.name)}) | ${r.current} -> ${r.latest} | ${r.bump} | ${r.breaking.length} | ${r.security.length} | ${r.prod}/${r.dev} |`
    )
  ].join('\n')
}

async function main () {
  fs.mkdirSync(DEPS_DIR, { recursive: true })
  const { deps, packageCount } = collectDeps()
  console.log(`workspace packages: ${packageCount}, external deps: ${deps.size}`)

  const names = [...deps.keys()].sort()
  const rows = []
  let done = 0
  const queue = names.slice()
  const worker = async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      const d = deps.get(name)
      const current = [...d.ranges].map((r) => r.replace(/^[\^~]/, '')).sort(cmp)[0]
      const meta = await npmMeta(name)
      done++
      if (done % 25 === 0) console.log(`  meta ${done}/${names.length}`)
      let latest = (meta.versions ?? []).filter(isStable).sort(cmp).pop() ?? meta.latest
      if (nameCategory(name) === 'node') latest = capMajor(meta.versions ?? [], NODE_MAJOR, latest)
      const pin = PINS[name]
      if (pin?.maxMajor !== undefined) latest = capMajor(meta.versions ?? [], pin.maxMajor, latest)
      if (pin?.maxVersion !== undefined) latest = (meta.versions ?? []).filter((v) => isStable(v) && cmp(v, pin.maxVersion) <= 0).sort(cmp).pop() ?? latest
      if (latest === undefined || parse(current) === undefined) continue
      const bump = bumpKind(current, latest)
      if (bump === 'same' || cmp(latest, current) <= 0) continue
      const category =
        nameCategory(name) ?? [...d.byPath.entries()].sort((a, b) => b[1] - a[1] || CATEGORIES.indexOf(a[0]) - CATEGORIES.indexOf(b[0]))[0][0]
      if (SCOPE_FILTER !== undefined && !SCOPE_FILTER.includes(category)) continue
      const row = {
        name,
        current,
        latest,
        bump,
        category,
        prod: d.prod,
        dev: d.dev,
        repo: meta.repo,
        pin,
        between: meta.versions.filter((v) => cmp(v, current) > 0 && cmp(v, latest) <= 0).sort(cmp),
        breaking: [],
        security: [],
        notes: ''
      }
      if (!NO_NOTES) {
        row.notes = await collectNotes(row)
        row.breaking = markers(row.notes, BREAKING)
        row.security = markers(row.notes, SECURITY)
      }
      rows.push(row)
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))

  const byName = new Map(rows.map((r) => [r.name, r]))
  for (const r of rows) {
    if (!r.name.startsWith('@types/')) continue
    const base = byName.get(r.name.slice(7).replace('__', '/'))
    if (base !== undefined) r.category = base.category
  }

  const order = { patch: 0, minor: 1, major: 2, unknown: 3 }
  rows.sort((a, b) => order[a.bump] - order[b.bump] || b.prod - a.prod || a.name.localeCompare(b.name))

  fs.writeFileSync(
    path.join(DEPS_DIR, 'upgrade_plan.tsv'),
    ['package\tcurrent\tlatest\tbump\tcategory\tprod\tdev\tbreaking\tsecurity']
      .concat(rows.map((r) => [r.name, r.current, r.latest, r.bump, r.category, r.prod, r.dev, r.breaking.length, r.security.length].join('\t')))
      .join('\n') + '\n'
  )

  const md = ['# Отчёт по обновлению зависимостей', '']
  md.push(`Сгенерировано: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}. Пакетов в отчёте: ${rows.length}.`)
  md.push(`Целевой Node: ${NODE_MAJOR} (категория node ограничена этим мажором). Заморожено пинами: ${Object.keys(PINS).length} (common/config/dependency-pins.json). Пропущены префиксы: ${SKIP.join(', ')}. Кэш: \`combined_dependencies/cache\` (TTL ${TTL_MS / 86400_000} дн., сброс \`--force\`).`)
  md.push('', 'Колонки breaking/security - число строк-совпадений по маркерам в changelog, не приговор: смотри детали.', '')
  md.push('| категория | всего | patch | minor | major | c security |', '|---|---|---|---|---|---|')
  for (const s of CATEGORIES) {
    const list = rows.filter((r) => r.category === s)
    if (list.length === 0) continue
    md.push(
      `| [${s}](#${s}) | ${list.length} | ${list.filter((r) => r.bump === 'patch').length} | ${list.filter((r) => r.bump === 'minor').length} | ${list.filter((r) => r.bump === 'major').length} | ${list.filter((r) => r.security.length > 0).length} |`
    )
  }
  md.push('')

  for (const s of CATEGORIES) {
    const list = rows.filter((r) => r.category === s)
    if (list.length === 0) continue
    md.push(`## ${s}`, '')
    md.push('```bash', `node common/scripts/outdated-apply.js --category ${s} --bump patch   # + rush update и команда проверки`, '```', '')
    const groups = [
      ['security-сигналы', list.filter((r) => r.security.length > 0)],
      ['patch/minor без маркеров', list.filter((r) => r.security.length === 0 && r.bump !== 'major' && r.breaking.length === 0)],
      ['patch/minor с breaking-маркерами', list.filter((r) => r.security.length === 0 && r.bump !== 'major' && r.breaking.length > 0)],
      ['major', list.filter((r) => r.security.length === 0 && r.bump === 'major')]
    ]
    for (const [title, g] of groups) {
      if (g.length === 0) continue
      md.push(`### ${title} (${g.length})`, '', table(g), '')
    }
  }

  md.push('## Детали по пакетам', '')
  for (const r of rows) {
    md.push(`### ${r.name}`, '')
    md.push(
      `\`${r.current}\` -> \`${r.latest}\` (**${r.bump}**, категория: ${r.category}, prod:${r.prod} dev:${r.dev}) - [полные release notes](changes/${r.name.replace(/\//g, '__')}.md)`,
      ''
    )
    if (r.security.length > 0) md.push('**security:**', '```', ...r.security, '```')
    if (r.breaking.length > 0) md.push('**breaking-маркеры:**', '```', ...r.breaking, '```')
    if (r.pin !== undefined) md.push(`**пин:** не выше ${r.pin.maxVersion ?? `${r.pin.maxMajor}.x`} - ${r.pin.reason}`, '')
    if (r.security.length === 0 && r.breaking.length === 0) md.push('_маркеров breaking/security не найдено_')
    md.push('')
  }

  fs.writeFileSync(path.join(DEPS_DIR, 'UPGRADE.md'), md.join('\n'))
  console.log(`written: combined_dependencies/UPGRADE.md (${rows.length} packages), upgrade_plan.tsv`)
}

void main()
