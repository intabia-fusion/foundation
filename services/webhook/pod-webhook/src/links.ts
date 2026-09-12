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

import { concatLink, type Class, type Doc, type Ref } from '@hcengineering/core'

// Same paths the server-side UrlPresenter mixins build (server-plugins/tracker-resources,
// document-resources, chunter-resources). Rebuilt here rather than reused: those presenters need a
// loaded model and Hierarchy, which is exactly the per-workspace load this pod exists to avoid.
const WORKBENCH = 'workbench'

export interface LinkContext {
  frontUrl: string
  workspaceUrl: string
}

function appLink (ctx: LinkContext, app: string, tail: string): string | undefined {
  if (ctx.frontUrl === '' || ctx.workspaceUrl === '') return undefined
  return concatLink(ctx.frontUrl, `/${WORKBENCH}/${ctx.workspaceUrl}/${app}/${tail}`)
}

/** Resolved back by tracker's location resolver through `Issue.identifier`, so it must be the real one. */
export function issueUrl (ctx: LinkContext, identifier: string): string | undefined {
  return appLink(ctx, 'tracker', identifier)
}

/** Document's resolver splits on '-' and takes the last segment as the id; the slug is cosmetic. */
export function documentUrl (ctx: LinkContext, id: Ref<Doc>, title: string): string | undefined {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return appLink(ctx, 'document', slug === '' ? `${id}` : `${slug}-${id}`)
}

/** Chunter carries the pair id|class, the same encoding view.encodeObjectURI produces. */
export function channelUrl (ctx: LinkContext, id: Ref<Doc>, _class: Ref<Class<Doc>>): string | undefined {
  return appLink(ctx, 'chunter', `${id}|${_class}`)
}

export function personUrl (ctx: LinkContext, id: Ref<Doc>): string | undefined {
  return appLink(ctx, 'contact', `${id}`)
}
