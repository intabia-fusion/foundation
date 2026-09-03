//
// Copyright © 2026 Intabia Fusion.
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

// Strip wrappers a small model echoes around a document body: our old <<<DOCUMENT markers and
// GigaChat's ```markdown code fences. Defensive - the prompt already asks for none.
export function sanitizeDocumentMarkdown (raw: string): string {
  let s = raw.trim()
  // GigaChat sometimes emits the body with literal "\n"/"\t" instead of real newlines (whole doc on
  // one line); detect and unescape so it parses into paragraphs/lists.
  if (!s.includes('\n') && s.includes('\\n')) {
    s = s
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
  }
  s = s
    .replace(/^<<<DOCUMENT\s*/i, '')
    .replace(/\s*DOCUMENT>>>$/i, '')
    // HTML comments parse into `comment` nodes, which the document schema rejects on apply
    // ("Invalid content for node doc"). The model uses them as notes to itself; drop them.
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
  // Peel fences that wrap the whole body (first+last line), repeatedly - GigaChat nests/accumulates
  // them. Internal code blocks survive (not both first and last line).
  const isFence = (line: string): boolean => /^\s*```/.test(line)
  for (;;) {
    const lines = s.split('\n')
    let first = 0
    let last = lines.length - 1
    while (first <= last && lines[first].trim() === '') first++
    while (last >= first && lines[last].trim() === '') last--
    if (first < last && isFence(lines[first]) && isFence(lines[last])) {
      s = lines
        .slice(first + 1, last)
        .join('\n')
        .trim()
    } else break
  }
  // Drop leftover stray fence lines at the edges (unbalanced fences the model leaves behind).
  const strayFence = /^\s*```[\sa-zA-Z]*$/
  const out = s.split('\n')
  while (out.length > 0 && strayFence.test(out[0])) out.shift()
  while (out.length > 0 && strayFence.test(out[out.length - 1])) out.pop()
  return out.join('\n').trim()
}
