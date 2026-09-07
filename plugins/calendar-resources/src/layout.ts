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
import { type Timestamp } from '@hcengineering/core'

/**
 * @public
 */
export interface LaidOutSpan {
  date: Timestamp
  dueDate: Timestamp
  cols: number
  index: number
}

/**
 * @public
 *
 * Assigns each span a column so that overlapping spans never share one, in place.
 *
 * Spans must be sorted by `date`. Column counts are agreed per cluster of transitively
 * overlapping spans, not per span: A[0,10) B[5,15) C[12,20) all get `cols: 2`, while deciding
 * per span would give B three columns against A's two and let the two boxes overlap on screen.
 */
export function layoutColumns (spans: LaidOutSpan[]): void {
  let cluster: LaidOutSpan[] = []
  let clusterEnd = 0

  const flush = (): void => {
    // Last end per column - a span takes the first column free by the time it starts.
    const ends: Timestamp[] = []
    for (const span of cluster) {
      let col = ends.findIndex((end) => end <= span.date)
      if (col < 0) col = ends.length
      ends[col] = span.dueDate
      span.index = col
    }
    for (const span of cluster) {
      span.cols = ends.length
    }
    cluster = []
  }

  for (const span of spans) {
    if (cluster.length > 0 && span.date >= clusterEnd) flush()
    cluster.push(span)
    clusterEnd = cluster.length === 1 ? span.dueDate : Math.max(clusterEnd, span.dueDate)
  }
  if (cluster.length > 0) flush()
}
