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

/* eslint-disable no-console */
/*
  check-contrast.js
  - Crawl theme SCSS and desktop index to extract CSS custom properties for accents and themes
  - Resolve variable values (simple var(...) fallback resolution)
  - Compute color contrast ratios for combinations relevant to buttons (primary/secondary/tertiary/negative/etc.)
  - Check the last commit diff for relevant changes in accent composite blocks (accent-light-huly / accent-dark-huly)
  - Report failing contrast checks and suggest which variables/blocks need attention.

  Usage:
    node check-contrast.js [--threshold 4.5] [--commit-range HEAD~1..HEAD] [--json] [--check-diff]

  Notes:
    - This is a best-effort SCSS parser: it reads variable assignments of the form
        --name: value;
      and picks up accent blocks `.accent-* { ... }` and composite classes like `.accent-light-huly`.
    - Color parsing supports hex (#rgb, #rrggbb, #rrggbbaa), rgb(), rgba().
    - When encountering rgba/transparent, alpha compositing against candidate background colors is performed.
    - For tertiary (transparent) buttons we check against `--bg-body` and `--bg-secondary` extracted from desktop template.
*/

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..'); // packages/theme
const ACCENT_FILE = path.join(ROOT, 'styles', '_accent-colors.scss');
const BUTTON_FILE = path.join(ROOT, 'styles', 'button.scss');
const DESKTOP_INDEX = path.resolve(__dirname, '..', '..', '..', 'desktop', 'src', 'ui', 'index.ejs');

const DEFAULT_THRESHOLD = 4.5;

   Utilities: file read / simple parsing

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    console.error(`Error reading ${p}: ${err.message}`);
    return null;
  }
}

/* Parse block-level variable assignments in SCSS-like content.
   Returns { blocks: {blockName: {varName: rawValueString}}, rootVars: {} }
*/
function parseScssBlocks(content) {
  const blocks = {};
  // capture class/block header: ".accent-name { ... }"
  // This will also capture theme-related selectors if present.
  const blockRe = /(\.[\w-]+(?:\s*[^{,]*)?)\s*\{([\s\S]*?)\n?\}/g;
  let m;
  while ((m = blockRe.exec(content))) {
    const selector = m[1].trim(); // e.g., ".accent-blue" or ".theme-dark .hulyButton"
    const body = m[2];
    // Only store selectors that include 'accent-' OR selectors that are theme-scoped (theme-dark/theme-light) for later usage.
    if (!selector.includes('accent-') && !selector.includes('theme-') && !selector.includes('[data-theme')) {
      continue;
    }

    // Normalize selector into a simple key (strip leading dot and any extra context).
    // Examples:
    //  ".accent-blue"            -> "accent-blue"
    //  ".theme-dark .hulyButton" -> "theme-dark"
    const normalized = (function(sel) {
      const accMatch = sel.match(/(?:accent|theme)-[a-zA-Z0-9_-]+/);
      if (accMatch) return accMatch[0];
      const dtMatch = sel.match(/\[data-theme=["']?([\w-]+)["']?\]/);
      if (dtMatch) return dtMatch[1];
      return sel.replace(/^\./, '').split(/\s|,/)[0].trim();
    })(selector);

    // parse variables in body
    const varMap = {};
    const varRe = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    let v;
    while ((v = varRe.exec(body))) {
      varMap[`--${v[1].trim()}`] = v[2].trim();
    }

    // Merge with any existing vars for the normalized key
    blocks[normalized] = Object.assign({}, blocks[normalized] || {}, varMap);
  }
  return { blocks };
}

/* Parse a :root { ... } or [data-theme="..."] block from an EJS/HTML-like file */
function parseRootVarsFromIndex(content) {
  const root = {};
  const rootRe = /:root\s*\{([\s\S]*?)\}/g;
  const themeRe = /\[data-theme="([\w-]+)"\]\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = rootRe.exec(content))) {
    const body = m[1];
    const varRe = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    let v;
    while ((v = varRe.exec(body))) {
      root[`--${v[1].trim()}`] = v[2].trim();
    }
  }
  const themeVars = {};
  while ((m = themeRe.exec(content))) {
    const theme = m[1].trim(); // e.g., theme-dark
    const body = m[2];
    const varRe = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    const map = {};
    let v;
    while ((v = varRe.exec(body))) {
      map[`--${v[1].trim()}`] = v[2].trim();
    }
    themeVars[theme] = map;
  }
  return { root, themeVars };
}

/* Extract theme-scoped var maps from button.scss (we used .theme-dark .hulyButton { --var: ... } ) */
function parseThemeOverridesFromButton(content) {
  const themeOverrides = {};
  const themeBlockRe = /(?:\.theme-(light|dark)|\[data-theme="(theme-light|theme-dark)"\])\s*([^{]*)\{([\s\S]*?)\}/g;
  let m;
  while ((m = themeBlockRe.exec(content))) {
    const theme = m[1] || m[2]; // 'light' or 'dark' or 'theme-light'/'theme-dark'
    const normalized = theme.replace(/^theme-/, '');
    const body = m[3];
    const varRe = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    const map = themeOverrides[normalized] || {};
    let v;
    while ((v = varRe.exec(body))) {
      map[`--${v[1].trim()}`] = v[2].trim();
    }
    themeOverrides[normalized] = map;
  }
  return themeOverrides;
}

   CSS var resolution and color parsing

function parseHexColor(h) {
  // h includes leading #
  const s = h.replace('#', '').trim();
  let r = 0, g = 0, b = 0, a = 1;
  if (s.length === 3) {
    r = parseInt(s[0] + s[0], 16);
    g = parseInt(s[1] + s[1], 16);
    b = parseInt(s[2] + s[2], 16);
  } else if (s.length === 4) {
    r = parseInt(s[0] + s[0], 16);
    g = parseInt(s[1] + s[1], 16);
    b = parseInt(s[2] + s[2], 16);
    a = parseInt(s[3] + s[3], 16) / 255;
  } else if (s.length === 6) {
    r = parseInt(s.substring(0, 2), 16);
    g = parseInt(s.substring(2, 4), 16);
    b = parseInt(s.substring(4, 6), 16);
  } else if (s.length === 8) {
    r = parseInt(s.substring(0, 2), 16);
    g = parseInt(s.substring(2, 4), 16);
    b = parseInt(s.substring(4, 6), 16);
    a = parseInt(s.substring(6, 8), 16) / 255;
  } else {
    return null;
  }
  return { r, g, b, a };
}

function parseRgbOrRgba(str) {
  const rgbRe = /rgb\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*\)/i;
  const rgbaRe = /rgba\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9.]+)\s*\)/i;
  let m = rgbaRe.exec(str);
  if (m) {
    return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] };
  }
  m = rgbRe.exec(str);
  if (m) {
    return { r: +m[1], g: +m[2], b: +m[3], a: 1 };
  }
  return null;
}

function parseColorString(s) {
  if (!s) return null;
  s = s.trim();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  // Remove surrounding quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('#')) return parseHexColor(s);
  const rgb = parseRgbOrRgba(s);
  if (rgb) return rgb;
  // try simple keyword 'white' or 'black' (very limited)
  if (s.toLowerCase() === 'white' || s.toLowerCase() === '#fff') return { r: 255, g: 255, b: 255, a: 1 };
  if (s.toLowerCase() === 'black' || s.toLowerCase() === '#000') return { r: 0, g: 0, b: 0, a: 1 };
  // not a color we can parse
  return null;
}

/* Convert sRGB channel [0..255] to linear; standard WCAG formula */
function channelToLinear(c) {
  const s = c / 255;
  if (s <= 0.03928) {
    return s / 12.92;
  }
  return Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }) {
  const R = channelToLinear(r);
  const G = channelToLinear(g);
  const B = channelToLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(c1, c2) {
  const L1 = relativeLuminance(c1);
  const L2 = relativeLuminance(c2);
  const top = Math.max(L1, L2);
  const bottom = Math.min(L1, L2);
  return (top + 0.05) / (bottom + 0.05);
}

/* Alpha compositing: fg over bg, both in rgba objects */
function compositeOver(fg, bg) {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const r = Math.round((fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a);
  const g = Math.round((fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a);
  const b = Math.round((fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a);
  return { r, g, b, a };
}

/* Resolve a CSS value (may contain nested var(...) calls). We use a varResolver to look up variable values.
   varResolver(varName) => rawValueString OR undefined
*/
function resolveCssValue(raw, varResolver, seen = new Set()) {
  if (!raw || typeof raw !== 'string') return null;
  raw = raw.trim();
  // If it's a direct color (hex, rgb), try parse
  const c = parseColorString(raw);
  if (c) return c;

  // If 'var(--name, fallback)' pattern present, handle it (basic support).
  // We will iteratively replace the outermost var(...) occurrences.
  const varCallRe = /var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,\s*([^)]+?)\s*)?\)/;
  let out = raw;
  let match = varCallRe.exec(out);
  while (match) {
    const varName = `--${match[1]}`;
    if (seen.has(varName)) {
      // circular
      break;
    }
    seen.add(varName);
    const fallback = match[2] ? match[2].trim() : null;
    const resolved = varResolver(varName);
    if (resolved) {
      // replace var(...) with resolved (raw) value and try again
      out = out.replace(match[0], resolved);
    } else if (fallback) {
      out = out.replace(match[0], fallback);
    } else {
      // cannot resolve
      return null;
    }
    match = varCallRe.exec(out);
  }
  // After substitution, attempt to parse final color
  const final = parseColorString(out);
  if (final) return final;
  // If it's a gradient or unsupported expression, attempt to extract first color-looking token
  const firstColorMatch = out.match(/(#(?:[0-9a-f]{3,8})|rgba?\([^)]+\))/i);
  if (firstColorMatch) {
    return parseColorString(firstColorMatch[1]);
  }
  return null;
}

   Logic: define checks and run them for each accent/theme

const CHECKS = [
  // primary - default / hover / pressed / disabled
  {
    kind: 'primary',
    states: [
      { name: 'default', bgVars: ['--button-primary-BackgroundColor', '--primary-button-default'], fgVars: ['--button-accent-LabelColor', '--button-primary-LabelColor', '--primary-button-color'] },
      { name: 'hover',   bgVars: ['--button-primary-hover-BackgroundColor', '--primary-button-hovered'], fgVars: ['--button-accent-LabelColor', '--button-primary-LabelColor', '--primary-button-color'] },
      { name: 'pressed', bgVars: ['--button-primary-active-BackgroundColor','--primary-button-pressed'], fgVars: ['--button-accent-LabelColor', '--button-primary-LabelColor', '--primary-button-color'] },
      { name: 'disabled', bgVars: ['--primary-button-disabled'], fgVars: ['--primary-button-disabled-color'] }
    ],
    type: 'filled'
  },
  // secondary
  {
    kind: 'secondary',
    states: [
      { name: 'default', bgVars: ['--button-secondary-BackgroundColor', '--secondary-button-default'], fgVars: ['--button-subtle-LabelColor'] },
      { name: 'hover', bgVars: ['--button-secondary-hover-BackgroundColor', '--secondary-button-hovered'], fgVars: ['--button-subtle-LabelColor'] },
      { name: 'pressed', bgVars: ['--button-secondary-active-BackgroundColor', '--secondary-button-pressed'], fgVars: ['--button-subtle-LabelColor'] }
    ],
    type: 'filled'
  },
  // tertiary: text vs panels; also icon-only
  {
    kind: 'tertiary-text',
    states: [
      { name: 'default', bgVars: ['--bg-body','--bg-secondary'], fgVars: ['--button-tertiary-LabelColor','--button-subtle-LabelColor'] },
      { name: 'hover',   bgVars: ['--theme-button-hovered','--bg-body'], fgVars: ['--button-tertiary-LabelColor','--button-subtle-LabelColor'] }
    ],
    type: 'transparent'
  },
  {
    kind: 'tertiary-icon',
    states: [
      { name: 'default', bgVars: ['--bg-body','--bg-secondary'], fgVars: ['--button-tertiary-icon-IconColor','--button-subtle-IconColor'] }
    ],
    type: 'transparent'
  },
  // negative
  {
    kind: 'negative',
    states: [
      { name: 'default', bgVars: ['--button-negative-BackgroundColor'], fgVars: ['--button-accent-LabelColor','--button-accent-IconColor'] },
      { name: 'hover', bgVars: ['--button-negative-hover-BackgroundColor'], fgVars: ['--button-accent-LabelColor','--button-accent-IconColor'] },
      { name: 'pressed', bgVars: ['--button-negative-active-BackgroundColor'], fgVars: ['--button-accent-LabelColor','--button-accent-IconColor'] }
    ],
    type: 'filled'
  }
];

function buildVarResolver(varMapsChain) {
  // varMapsChain is array of maps searched in order [localAccent, compositeAccents, themeOverrides, globalRoot, desktopTheme]
  return function varResolver(varName) {
    for (const m of varMapsChain) {
      if (!m) continue;
      if (Object.prototype.hasOwnProperty.call(m, varName)) {
        return m[varName];
      }
    }
    return undefined;
  };
}

/* Build final var map for a given accent and theme */
function buildEffectiveVars(accentBlocks, accentName, theme, themeOverrides, rootVars, desktopThemeVars) {
  // Normalize accentName: 'accent-blue' etc
  const baseKey = `accent-${accentName.replace(/^accent-/, '')}`;
  const result = Object.assign({}, accentBlocks[baseKey] || {});
  // composite for 'huly' case: accent-light-huly or accent-dark-huly
  const compositeKey = `accent-${theme.replace(/^theme-/, '')}-${accentName.replace(/^accent-/, '')}`; // e.g., accent-dark-huly
  if (accentBlocks[compositeKey]) {
    Object.assign(result, accentBlocks[compositeKey]);
  }
  // Additionally consider theme-specific override blocks parsed from button.scss
  const themeShort = theme.replace(/^theme-/, '');
  if (themeOverrides[themeShort]) {
    // Only pick theme-level overrides; attach them as final layer
    Object.assign(result, themeOverrides[themeShort]);
  }
  // Guarantee global root/background variables are accessible via chain later, return result only
  return result;
}

/* Helper: attempt to resolve a color from a list of candidate variables/values.
   Returns resolved color (rgba object) or null.
*/
function resolveCandidatesToColor(candidates, varResolver, fallbackBg) {
  for (const cand of candidates) {
    if (!cand) continue;
    // If cand is direct color, try parse
    const direct = parseColorString(cand);
    if (direct) return direct;
    // else if it's a var name like --foo, ask resolver
    if (cand.startsWith('--')) {
      const raw = varResolver(cand);
      if (raw) {
        const resolved = resolveCssValue(raw, varResolver);
        if (resolved) return resolved;
      }
    } else {
      // attempt to resolve as CSS expression via resolveCssValue
      const resolved = resolveCssValue(cand, varResolver);
      if (resolved) return resolved;
    }
  }
  // fallback attempt: if nothing was resolved, try the fallbackBg (if provided)
  if (fallbackBg) return fallbackBg;
  return null;
}

function colorToHex({ r, g, b }) {
  const rr = r.toString(16).padStart(2, '0');
  const gg = g.toString(16).padStart(2, '0');
  const bb = b.toString(16).padStart(2, '0');
  return `#${rr}${gg}${bb}`;
}

/* Evaluate contrast checks for given accentName and theme */
function evaluateAccent(accentName, theme, accentBlocks, themeOverrides, rootVars, desktopThemeVars, threshold = DEFAULT_THRESHOLD) {
  const baseKey = accentName;
  const effectiveVars = buildEffectiveVars(accentBlocks, baseKey, theme, themeOverrides, rootVars, desktopThemeVars);
  // Prefer desktop/theme vars over global root vars so theme-specific overrides win when present
  const varResolver = buildVarResolver([effectiveVars, desktopThemeVars, rootVars]);

  const results = [];

  // Default background candidates for transparent cases
  const defaultBgs = [];
  // prefer desktop theme bg if available
  const bgBody = rootVars['--bg-body'] || desktopThemeVars['--bg-body'];
  const bgSecondary = rootVars['--bg-secondary'] || desktopThemeVars['--bg-secondary'];
  if (bgBody) defaultBgs.push(bgBody);
  if (bgSecondary) defaultBgs.push(bgSecondary);

  for (const check of CHECKS) {
    for (const state of check.states) {
      // resolve foreground
      const fg = resolveCandidatesToColor(state.fgVars, varResolver, null);
      // resolve background candidates
      const bgCandidates = [];
      // For each bgVars in case it is a variable or explicit color:
      for (const bgVar of (state.bgVars || [])) {
        if (!bgVar) continue;
        if (bgVar.startsWith('--')) {
          // get raw
          const raw = varResolver(bgVar);
          if (raw) {
            const resolved = resolveCssValue(raw, varResolver);
            if (resolved) bgCandidates.push(resolved);
            else {
              // fallback: maybe it's transparent or gradient; skip
            }
          } else {
            // not defined: skip
          }
        } else {
          const parsed = parseColorString(bgVar);
          if (parsed) bgCandidates.push(parsed);
        }
      }
      // For transparent/tertiary checks, use default theme backgrounds
      if (bgCandidates.length === 0) {
        bgCandidates.push(...defaultBgs.map(s => parseColorString(s)).filter(Boolean));
      }
      // If fg has alpha <1, composite over each bg candidate
      const worst = { ratio: Infinity, bg: null, fgComposite: null, bgColor: null };
      let anyResolved = false;
      for (const bg of bgCandidates) {
        const fgResolved = fg || null;
        if (!fgResolved) continue;
        anyResolved = true;
        let fgFinal = fgResolved;
        if (fgResolved.a < 1) {
          fgFinal = compositeOver(fgResolved, bg);
        }
        const ratio = contrastRatio(fgFinal, bg);
        if (ratio < worst.ratio) {
          worst.ratio = ratio;
          worst.bg = bg;
          worst.fgComposite = fgFinal;
          worst.bgColor = bg;
        }
      }
      if (!anyResolved) {
        results.push({
          accent: accentName,
          theme,
          kind: check.kind,
          state: state.name,
          ok: false,
          reason: 'could not resolve fg or bg colors',
          fg: state.fgVars,
          bg: state.bgVars
        });
        continue;
      }
      const ok = worst.ratio >= threshold;
      results.push({
        accent: accentName,
        theme,
        kind: check.kind,
        state: state.name,
        ok,
        ratio: worst.ratio,
        fgLabel: state.fgVars.join(', '),
        bgLabel: (state.bgVars || []).join(', '),
        fg: worst.fgComposite ? colorToHex(worst.fgComposite) : null,
        bg: worst.bgColor ? colorToHex(worst.bgColor) : null
      });
    }
  }

  return results;
}

   Git diff checking for last commit

function getLastCommitChangedFiles(range = 'HEAD~1..HEAD') {
  try {
    const out = execSync(`git diff --name-only ${range}`, { encoding: 'utf8' }).trim();
    if (!out) return [];
    return out.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  } catch (err) {
    // Not a git repo or git failed
    return null;
  }
}

function getDiffForFile(filePath, range = 'HEAD~1..HEAD') {
  try {
    const out = execSync(`git diff ${range} -- ${filePath}`, { encoding: 'utf8' });
    return out;
  } catch (err) {
    return null;
  }
}

/* Determine whether the last commit touched accent-light-huly / accent-dark-huly or button.scss and whether changes mention our tokens */
function analyzeDiffs(range = 'HEAD~1..HEAD') {
  const changed = getLastCommitChangedFiles(range);
  if (changed === null) return null;
  const interesting = changed.filter(p => p.includes('packages/theme/styles/_accent-colors.scss') || p.includes('packages/theme/styles/button.scss'));
  const report = {
    changedFiles: interesting,
    details: []
  };
  for (const f of interesting) {
    const diffText = getDiffForFile(f, range);
    if (!diffText) continue;
    // naive check: look for added lines with our interesting variable names
    const addedLines = diffText.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.substring(1).trim());
    const removedLines = diffText.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.substring(1).trim());
    const additions = addedLines.filter(l => /--button-tertiary-icon-IconColor|--button-tertiary-LabelColor|accent-dark-huly|accent-light-huly/i.test(l));
    const removals = removedLines.filter(l => /--button-tertiary-icon-IconColor|--button-tertiary-LabelColor|accent-dark-huly|accent-light-huly/i.test(l));
    report.details.push({ file: f, additions, removals });
  }
  return report;
}

   Main entry

function main() {
  // CLI args
  const args = process.argv.slice(2);
  let threshold = DEFAULT_THRESHOLD;
  let range = 'HEAD~1..HEAD';
  let jsonOutput = false;
  let checkDiff = false;
  let diffBase = null;
  // If provided, run checks only for a single accent (eg. 'intabia' or 'accent-intabia')
  let singleAccent = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--threshold' && args[i + 1]) {
      threshold = parseFloat(args[i + 1]) || DEFAULT_THRESHOLD;
      i++;
    } else if ((a === '--commit-range' || a === '--range') && args[i + 1]) {
      range = args[i + 1];
      i++;
    } else if (a === '--check-diff') {
      checkDiff = true;
    } else if (a === '--diff-base' && args[i + 1]) {
      diffBase = args[i + 1];
      i++;
    } else if (a === '--accent' && args[i + 1]) {
      // allow --accent huly  or --accent accent-huly
      singleAccent = args[i + 1];
      i++;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a === '--check-diff') {
      checkDiff = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  // Read files
  const accentContent = readFileSafe(ACCENT_FILE);
  const buttonContent = readFileSafe(BUTTON_FILE);
  const desktopContent = readFileSafe(DESKTOP_INDEX);

  if (!accentContent || !buttonContent || !desktopContent) {
    console.error('Missing one or more input files. Make sure you run the script from repository with expected layout.');
    process.exit(2);
  }

  const { blocks: accentBlocks } = parseScssBlocks(accentContent);
  const { blocks: themeBlocksFromButton } = parseScssBlocks(buttonContent);
  const themeOverrides = parseThemeOverridesFromButton(buttonContent); // { light: {...}, dark: {...} }
  const { root: rootVars, themeVars: desktopThemeVars } = parseRootVarsFromIndex(desktopContent);

  // Collect list of accents found
  let accents = Object.keys(accentBlocks).filter(k => k.startsWith('accent-')).map(k => k.trim());

  // If a single accent was requested on CLI, normalize and filter to it
  if (singleAccent) {
    let baseKey = singleAccent.trim().replace(/^\./, '');
    if (!baseKey.startsWith('accent-')) baseKey = 'accent-' + baseKey.replace(/^accent-/, '');
    if (!accentBlocks[baseKey]) {
      console.error(`Accent not found: ${baseKey}. Available accents: ${Object.keys(accentBlocks).join(', ')}`);
      process.exit(2);
    }
    accents = [baseKey];
  }

  // If requested, print color diffs from a base accent and exit.
  if (diffBase) {
    // Normalize base key: accept 'huly' or 'accent-huly' or '.accent-huly'
    let baseKey = diffBase.trim().replace(/^\./, '');
    if (!baseKey.startsWith('accent-')) baseKey = 'accent-' + baseKey.replace(/^accent-/, '');
    if (!accentBlocks[baseKey]) {
      console.error(`Base accent "${diffBase}" (normalized: "${baseKey}") not found. Available accents: ${Object.keys(accentBlocks).join(', ')}`);
      process.exit(2);
    }
    const baseVars = accentBlocks[baseKey];

    const colorLike = (v) => {
      if (!v) return false;
      v = String(v).trim();
      if (v.includes('linear-gradient')) return true;
      if (v.includes('#')) return true;
      if (/rgba?\(/i.test(v)) return true;
      if (parseColorString(v)) return true;
      return false;
    };

    const diffs = {};
    for (const a of Object.keys(accentBlocks)) {
      if (a === baseKey) continue;
      const otherVars = accentBlocks[a];
      const keys = new Set([...Object.keys(baseVars), ...Object.keys(otherVars)]);
      const changed = [];
      for (const k of keys) {
        const bv = baseVars[k];
        const ov = otherVars[k];
        if (bv === ov) continue;
        if (!colorLike(bv) && !colorLike(ov)) continue;
        changed.push({ variable: k, base: bv || null, other: ov || null });
      }
      diffs[a] = changed;
    }

    if (jsonOutput) {
      console.log(JSON.stringify({ base: baseKey, diffs }, null, 2));
    } else {
      console.log(`Color differences from ${baseKey}:`);
      for (const [accentName, changes] of Object.entries(diffs)) {
        console.log(`\nAccent: ${accentName}  Differences: ${changes.length}`);
        for (const c of changes) {
          console.log(`  ${c.variable}: base=${c.base}  other=${c.other}`);
        }
      }
      if (Object.keys(diffs).length === 0) {
        console.log('No color differences found.');
      }
      console.log('');
    }
    process.exit(0);
  }

  // We will produce results per accent per theme ('theme-light', 'theme-dark')
  const final = [];

  for (const accentKey of accents) {
    // accentKey is like 'accent-blue' or 'accent-huly'
    // derive short accent name (without 'accent-')
    const accentName = accentKey.replace(/^accent-/, '');
    for (const theme of ['theme-light', 'theme-dark']) {
      const results = evaluateAccent(accentKey, theme, accentBlocks, themeOverrides, rootVars, desktopThemeVars[theme] || desktopThemeVars[`theme-${theme.replace('theme-', '')}`] || desktopThemeVars[theme] || rootVars, threshold);
      final.push({ accent: accentKey, theme, results });
    }
  }

  // Summarize
  const failures = [];
  for (const entry of final) {
    for (const r of entry.results) {
      if (!r.ok) {
        failures.push(Object.assign({}, r, { accent: entry.accent, theme: entry.theme }));
      }
    }
  }

  // If requested, check last commit diff for relevant changes.
  let diffReport = null;
  if (checkDiff) {
    diffReport = analyzeDiffs(range);
  }

  // Output
  if (jsonOutput) {
    const out = { threshold, summary: { accentsCount: accents.length }, results: final, failures, diffReport };
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log('Contrast checks (threshold:', threshold, ')\n');
    for (const entry of final) {
      console.log(`Accent: ${entry.accent}  Theme: ${entry.theme}`);
      for (const r of entry.results) {
        if (r.ok) {
          console.log(`  [PASS] ${r.kind} (${r.state})  fg=${r.fg || 'n/a'} bg=${r.bg || 'n/a'} ratio=${(r.ratio||0).toFixed(2)}`);
        } else {
          console.log(`  [FAIL] ${r.kind} (${r.state})  ${r.reason ? r.reason : `ratio=${(r.ratio||0).toFixed(2)} fg=${r.fg || 'n/a'} bg=${r.bg || 'n/a'}`}`);
        }
      }
      console.log('');
    }
    if (failures.length === 0) {
      console.log('All checks passed ✅\n');
    } else {
      console.log(`Failures: ${failures.length} (see above)\n`);
    }
    if (diffReport) {
      console.log('Git diff (last commit) analysis:');
      if (diffReport === null) {
        console.log('  Could not obtain git information (no repo or git failure).');
      } else {
        if (diffReport.changedFiles.length === 0) {
          console.log('  No theme/style files changed in last commit.');
        } else {
          for (const d of diffReport.details) {
            console.log(`  File: ${d.file}`);
            if (d.additions.length) {
              console.log(`    Additions mentioning interest:`);
              for (const a of d.additions) console.log(`      + ${a}`);
            }
            if (d.removals.length) {
              console.log(`    Removals mentioning interest:`);
              for (const a of d.removals) console.log(`      - ${a}`);
            }
          }
        }
      }
    }
  }

  // exit non-zero if any failure found
  if (failures.length > 0) process.exit(3);
  process.exit(0);
}

function printHelp() {
  console.log('Usage: node check-contrast.js [--threshold 4.5] [--commit-range <range>] [--json] [--check-diff] [--diff-base <accent>] [--accent <accent>]');
  console.log('');
  console.log('Example:');
  console.log('  node check-contrast.js --threshold 4.5 --check-diff --commit-range HEAD~1..HEAD');
  console.log('  node check-contrast.js --diff-base accent-huly --json');
  console.log('  node check-contrast.js --accent accent-blue --json');
}

if (require.main === module) {
  main();
}
