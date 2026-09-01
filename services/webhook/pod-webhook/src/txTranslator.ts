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

import core, {
  generateId,
  type Class,
  type Doc,
  type MeasureContext,
  type PersonId,
  type Ref,
  type Space,
  type Tx,
  type TxCreateDoc,
  type TxCUD,
  type TxUpdateDoc,
  type WorkspaceUuid
} from '@hcengineering/core'
import {
  QueueTopic,
  type ConsumerHandle,
  type ConsumerMessage,
  type PlatformQueue,
  type PlatformQueueProducer
} from '@hcengineering/server-core'
import setting, { type WebhookEndpoint } from '@hcengineering/setting'

import type { Config } from './config'
import { domainRules, type CreateRule, type DomainRule, type RemoveRule, type UpdateRule } from './eventTable'
import type { WebhookDeliveryMessage, WebhookEvent } from './types'
import { getSystemTransactorTarget } from './workspaceClient'

const CONSUMER_GROUP = 'webhook-tx-translator'
const BATCH_SIZE = 200
const BATCH_TIMEOUT_MS = 200
const REPORT_EVERY = 100_000

// Stands in for "state before the update": TxUpdateDoc carries only new values, so the previous ones
// are rebuilt as this pod observes the stream, like services/activity's WsCache - but with no fallback.
export type ObjectCache = Map<string, Record<string, unknown>>

// Soft cap. Not an LRU: re-setting a key keeps its insertion order, so this drops the oldest-created.
const MAX_CACHE_ENTRIES = 50_000

// ponytail: in-process only. After a restart, a rebalance, or for an object whose create this pod
// never saw, `updatedFrom` comes back empty - unknown, not wrong. Accurate state needs a snapshot store.

function trackedClasses (rules: DomainRule[]): Set<Ref<Class<Doc>>> {
  return new Set(rules.map((r) => r.objectClass))
}

// A create/update/remove of a real object, not a trigger side-effect. Mixins are excluded: a TxMixin
// has no `operations`, so treating one as a TxUpdateDoc would throw.
function trackedCud (tx: Tx): TxCUD<Doc> | undefined {
  if (
    tx._class !== core.class.TxCreateDoc &&
    tx._class !== core.class.TxUpdateDoc &&
    tx._class !== core.class.TxRemoveDoc
  ) {
    return undefined
  }
  const cud = tx as TxCUD<Doc>
  return cud.space === core.space.DerivedTx ? undefined : cud
}

// Rules name base classes, but a custom task type's issues only extend them - exact match first,
// then the memo resolveClassesForBatch fills in.
function resolveEffectiveClass (
  classes: Set<Ref<Class<Doc>>>,
  classCache: ClassResolutionCache,
  workspace: WorkspaceUuid,
  objectClass: Ref<Class<Doc>>
): Ref<Class<Doc>> | undefined {
  if (classes.has(objectClass)) return objectClass
  return classCache.get(`${workspace}:${objectClass}`) ?? undefined
}

// Grouped workspace -> space -> object in first-occurrence order; that Map ordering is what keeps
// order within a space and stops different objects collapsing together.
function groupByObject (
  rules: DomainRule[],
  classCache: ClassResolutionCache,
  msgs: Array<ConsumerMessage<Tx>>
): Map<WorkspaceUuid, Map<Ref<Space>, Map<Ref<Doc>, { effectiveClass: Ref<Class<Doc>>, txs: TxCUD<Doc>[] }>>> {
  const classes = trackedClasses(rules)
  const result = new Map<
  WorkspaceUuid,
  Map<Ref<Space>, Map<Ref<Doc>, { effectiveClass: Ref<Class<Doc>>, txs: TxCUD<Doc>[] }>>
  >()

  for (const msg of msgs) {
    const cud = trackedCud(msg.value)
    if (cud === undefined) continue
    const effectiveClass = resolveEffectiveClass(classes, classCache, msg.workspace, cud.objectClass)
    if (effectiveClass === undefined) continue

    let bySpace = result.get(msg.workspace)
    if (bySpace === undefined) {
      bySpace = new Map()
      result.set(msg.workspace, bySpace)
    }
    let byObject = bySpace.get(cud.objectSpace)
    if (byObject === undefined) {
      byObject = new Map()
      bySpace.set(cud.objectSpace, byObject)
    }
    let entry = byObject.get(cud.objectId)
    if (entry === undefined) {
      entry = { effectiveClass, txs: [] }
      byObject.set(cud.objectId, entry)
    }
    entry.txs.push(cud)
  }

  return result
}

// Every field worth remembering for a class: what a create reports plus what any update rule watches.
function cachedFields (rules: DomainRule[], objectClass: Ref<Class<Doc>>): Set<string> {
  const fields = new Set<string>()
  for (const r of rules) {
    if (r.objectClass !== objectClass) continue
    if (r.kind === 'create') for (const f of r.dataFields) fields.add(f)
    if (r.kind === 'update') fields.add(r.field)
  }
  return fields
}

function findCreateRule (
  rules: DomainRule[],
  objectClass: Ref<Class<Doc>>,
  attachedToClass: Ref<Class<Doc>> | undefined
): CreateRule | undefined {
  return rules.find(
    (r): r is CreateRule =>
      r.kind === 'create' &&
      r.objectClass === objectClass &&
      (r.attachedToClass === undefined || r.attachedToClass === attachedToClass)
  )
}

function findRemoveRule (rules: DomainRule[], objectClass: Ref<Class<Doc>>): RemoveRule | undefined {
  return rules.find((r): r is RemoveRule => r.kind === 'remove' && r.objectClass === objectClass)
}

// create, then zero or more updates within the same batch -> one 'create' with the final state
// (TSK-065's first collapsing rule). `updatedFrom` is never set - the object did not exist before.
function collapseCreate (
  rules: DomainRule[],
  cache: ObjectCache,
  classCache: ClassResolutionCache,
  cacheKey: string,
  workspace: WorkspaceUuid,
  objectId: Ref<Doc>,
  effectiveClass: Ref<Class<Doc>>,
  txs: TxCUD<Doc>[]
): WebhookEvent[] {
  const createTx = txs[0] as TxCreateDoc<Doc>
  const attrs = createTx.attributes as unknown as Record<string, unknown>

  // Seeded even when no create rule matches: update rules of this class still need a `updatedFrom`
  // baseline, and their fields need not appear in any create rule's `dataFields`.
  const seed: Record<string, unknown> = {}
  for (const field of cachedFields(rules, effectiveClass)) {
    if (field in attrs) seed[field] = attrs[field]
  }
  cache.set(cacheKey, seed)

  const attachedTo = createTx.attachedToClass
  const effectiveAttachedTo =
    attachedTo === undefined
      ? undefined
      : (resolveEffectiveClass(trackedClasses(rules), classCache, workspace, attachedTo) ?? attachedTo)
  const rule = findCreateRule(rules, effectiveClass, effectiveAttachedTo)
  if (rule === undefined) return []

  const data: Record<string, unknown> = {}
  for (const field of rule.dataFields) {
    if (field in attrs) data[field] = attrs[field]
  }

  for (let i = 1; i < txs.length; i++) {
    const tx = txs[i]
    if (tx._class !== core.class.TxUpdateDoc) continue // defensive - remove is handled before this is reached
    const ops = (tx as TxUpdateDoc<Doc>).operations as Record<string, unknown>
    for (const field of rule.dataFields) {
      if (field in ops) data[field] = ops[field]
    }
  }

  cache.set(cacheKey, { ...seed, ...data })
  // The creator, not whoever last edited it in the same batch - the event still reports a creation.
  return [
    {
      action: 'create',
      type: rule.type,
      actor: createTx.modifiedBy,
      data: { id: objectId, ...data },
      organizationId: workspace
    }
  ]
}

// A run ending in remove -> one 'remove' event, even if it began with a create. `data` is whatever is
// still cached; the document is gone.
function collapseRemove (
  rules: DomainRule[],
  cache: ObjectCache,
  cacheKey: string,
  workspace: WorkspaceUuid,
  objectId: Ref<Doc>,
  effectiveClass: Ref<Class<Doc>>,
  removeTx: TxCUD<Doc>
): WebhookEvent[] {
  const cached = cache.get(cacheKey)
  cache.delete(cacheKey)

  const rule = findRemoveRule(rules, effectiveClass)
  if (rule === undefined) return []

  return [
    {
      action: 'remove',
      type: rule.type,
      actor: removeTx.modifiedBy,
      data: { id: objectId, ...cached },
      organizationId: workspace
    }
  ]
}

// One 'update' event per tracked field touched - 'status_changed' and 'assigned' are different facts,
// so a batch changing both must not drop one. Repeated writes to one field still collapse into one.
function collapseUpdates (
  rules: DomainRule[],
  cache: ObjectCache,
  cacheKey: string,
  workspace: WorkspaceUuid,
  objectId: Ref<Doc>,
  effectiveClass: Ref<Class<Doc>>,
  txs: TxUpdateDoc<Doc>[]
): WebhookEvent[] {
  const byField = new Map<string, UpdateRule>()
  for (const r of rules) {
    if (r.kind === 'update' && r.objectClass === effectiveClass) byField.set(r.field, r)
  }
  if (byField.size === 0) return []

  const cached = cache.get(cacheKey) ?? {}
  const touched = new Map<string, { before: unknown, after: unknown, actor: PersonId }>()
  for (const tx of txs) {
    const ops = tx.operations as Record<string, unknown>
    for (const field of Object.keys(ops)) {
      if (!byField.has(field)) continue
      const entry = touched.get(field)
      if (entry === undefined) {
        touched.set(field, { before: cached[field], after: ops[field], actor: tx.modifiedBy })
      } else {
        entry.after = ops[field]
        entry.actor = tx.modifiedBy
      }
    }
  }
  if (touched.size === 0) return []

  const nextCached = { ...cached }
  const events: WebhookEvent[] = []
  for (const [field, entry] of touched) {
    nextCached[field] = entry.after
    const rule = byField.get(field) as UpdateRule
    const updatedFrom: Record<string, unknown> = {}
    if (entry.before !== undefined) updatedFrom[field] = entry.before
    // `identifier` rides the same cache as `updatedFrom` - present only if this pod's cache still
    // has it from the object's create (see the `ponytail:` note above), omitted otherwise.
    const data: Record<string, unknown> = { id: objectId, [field]: entry.after }
    if (cached.identifier !== undefined) data.identifier = cached.identifier
    events.push({
      action: 'update',
      type: rule.type,
      actor: entry.actor,
      data,
      updatedFrom,
      organizationId: workspace
    })
  }
  cache.set(cacheKey, nextCached)
  return events
}

function collapseRun (
  rules: DomainRule[],
  cache: ObjectCache,
  classCache: ClassResolutionCache,
  workspace: WorkspaceUuid,
  objectId: Ref<Doc>,
  effectiveClass: Ref<Class<Doc>>,
  txs: TxCUD<Doc>[]
): WebhookEvent[] {
  const cacheKey = `${workspace}:${objectId}`
  const last = txs[txs.length - 1]

  if (last._class === core.class.TxRemoveDoc) {
    return collapseRemove(rules, cache, cacheKey, workspace, objectId, effectiveClass, last)
  }
  if (txs[0]._class === core.class.TxCreateDoc) {
    return collapseCreate(rules, cache, classCache, cacheKey, workspace, objectId, effectiveClass, txs)
  }
  return collapseUpdates(rules, cache, cacheKey, workspace, objectId, effectiveClass, txs as TxUpdateDoc<Doc>[])
}

function capCache<T> (cache: Map<string, T>, max: number): void {
  while (cache.size > max) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

// Endpoints change rarely, batches arrive every BATCH_TIMEOUT_MS - without this the translator would
// hit the transactor several times a second. A minute of staleness after an edit is acceptable.
export type EndpointCache = Map<
WorkspaceUuid,
{ endpoints: WebhookEndpoint[], privateSpaces: Set<Ref<Space>>, at: number }
>
const ENDPOINT_TTL_MS = 60_000

export interface TranslatedEvent {
  workspace: WorkspaceUuid
  /** Routing only - never part of the delivered payload. Decides which endpoints may see the event. */
  space: Ref<Space>
  event: WebhookEvent
}

/** Pure - no I/O, so collapsing rules are testable without a queue or REST client. Mutates `cache`;
 * `classCache` must already be filled by resolveClassesForBatch. */
export function buildEventsForBatch (
  rules: DomainRule[],
  cache: ObjectCache,
  classCache: ClassResolutionCache,
  msgs: Array<ConsumerMessage<Tx>>
): TranslatedEvent[] {
  const grouped = groupByObject(rules, classCache, msgs)
  const result: TranslatedEvent[] = []

  for (const [workspace, bySpace] of grouped) {
    for (const [space, byObject] of bySpace) {
      for (const [objectId, { effectiveClass, txs }] of byObject) {
        for (const event of collapseRun(rules, cache, classCache, workspace, objectId, effectiveClass, txs)) {
          result.push({ workspace, space, event })
        }
      }
    }
  }

  capCache(cache, MAX_CACHE_ENTRIES)
  return result
}

// Which rule-table class this one resolves to. `null` = resolved to nothing, `undefined` = never seen.
// Keyed per workspace: a custom task type's class ref is generated there, not globally unique.
export type ClassResolutionCache = Map<string, Ref<Class<Doc>> | null>
const MAX_CLASS_CACHE_ENTRIES = 20_000

/**
 * Maps each unknown class to its nearest ancestor in the rule table, so a custom task type's issues
 * count as issues. The memo is permanent - class refs are never reused.
 * findAll(core.class.Class) rather than getModel(): the latter replays the whole tx history to rebuild
 * a Hierarchy, which is the per-workspace model load this pod exists to avoid.
 */
export async function resolveClassesForBatch (
  ctx: MeasureContext,
  config: Config,
  classCache: ClassResolutionCache,
  rules: DomainRule[],
  msgs: Array<ConsumerMessage<Tx>>
): Promise<void> {
  const known = trackedClasses(rules)
  const pending = new Map<WorkspaceUuid, Set<Ref<Class<Doc>>>>()
  for (const msg of msgs) {
    const cud = trackedCud(msg.value)
    if (cud === undefined) continue
    let set = pending.get(msg.workspace)
    if (set === undefined) {
      set = new Set()
      pending.set(msg.workspace, set)
    }
    if (!known.has(cud.objectClass) && !classCache.has(`${msg.workspace}:${cud.objectClass}`)) {
      set.add(cud.objectClass)
    }
    // A comment's attachedToClass narrows create rules, and it is a custom task type just as often.
    const attached = cud.attachedToClass
    if (attached !== undefined && !known.has(attached) && !classCache.has(`${msg.workspace}:${attached}`)) {
      set.add(attached)
    }
  }
  if (pending.size === 0) return

  for (const [workspace, objectClasses] of pending) {
    if (objectClasses.size === 0) continue
    const parents = new Map<Ref<Class<Doc>>, Ref<Class<Doc>> | undefined>()
    try {
      const target = await getSystemTransactorTarget(config, workspace)
      const table = await target.rest.findAll(core.class.Class, {}, { projection: { _id: 1, extends: 1 } })
      for (const cls of table) parents.set(cls._id, cls.extends)
    } catch (err) {
      // Throw, don't swallow: the batch must be replayed, otherwise these classes are stuck unresolved
      // and their events are lost for good (same policy as dispatch's endpoint load below).
      ctx.error('webhook tx translator: failed to resolve class hierarchy', { workspace, err })
      throw err
    }

    for (const objectClass of objectClasses) {
      const chain: Ref<Class<Doc>>[] = []
      let current: Ref<Class<Doc>> | undefined = objectClass
      let resolved: Ref<Class<Doc>> | undefined
      while (current !== undefined) {
        if (known.has(current)) {
          resolved = current
          break
        }
        chain.push(current)
        current = parents.get(current)
      }
      for (const cls of chain) classCache.set(`${workspace}:${cls}`, resolved ?? null)
    }
  }

  capCache(classCache, MAX_CLASS_CACHE_ENTRIES)
}

// One delivery message per (enabled endpoint subscribed to the type, event). The cached copy can be up
// to ENDPOINT_TTL_MS stale; processDelivery re-reads the endpoint and is the gate that actually holds.
async function loadEndpoints (
  config: Config,
  workspace: WorkspaceUuid,
  cache: EndpointCache
): Promise<{ endpoints: WebhookEndpoint[], privateSpaces: Set<Ref<Space>> }> {
  const hit = cache.get(workspace)
  if (hit !== undefined && Date.now() - hit.at < ENDPOINT_TTL_MS) return hit

  const target = await getSystemTransactorTarget(config, workspace)
  const endpoints = await target.rest.findAll(setting.class.WebhookEndpoint, { enabled: true })
  const privateSpaces = new Set(
    (await target.rest.findAll(core.class.Space, { private: true }, { projection: { _id: 1 } })).map((s) => s._id)
  )
  const loaded = { endpoints, privateSpaces }
  cache.set(workspace, { ...loaded, at: Date.now() })
  return loaded
}

/**
 * An endpoint is configured by a workspace Owner, who is not a member of every private space - so a
 * private space is exported only when the endpoint names it explicitly. An empty whitelist means
 * "every non-private space", never "everything".
 */
function endpointSeesSpace (endpoint: WebhookEndpoint, space: Ref<Space>, privateSpaces: Set<Ref<Space>>): boolean {
  const allowed = endpoint.spaces ?? []
  if (allowed.length > 0) return allowed.includes(space)
  return !privateSpaces.has(space)
}

export async function dispatch (
  ctx: MeasureContext,
  config: Config,
  deliveryProducer: PlatformQueueProducer<WebhookDeliveryMessage>,
  endpointCache: EndpointCache,
  workspace: WorkspaceUuid,
  events: Array<{ space: Ref<Space>, event: WebhookEvent }>
): Promise<void> {
  let endpoints: WebhookEndpoint[]
  let privateSpaces: Set<Ref<Space>>
  try {
    ;({ endpoints, privateSpaces } = await loadEndpoints(config, workspace, endpointCache))
  } catch (err) {
    // Throw, don't swallow: the batch must be replayed, otherwise these events are lost for good.
    ctx.error('webhook tx translator: failed to load endpoints', { workspace, err })
    throw err
  }
  if (endpoints.length === 0) return

  const messages: WebhookDeliveryMessage[] = []
  for (const { space, event } of events) {
    for (const endpoint of endpoints) {
      if (!endpoint.events.includes(event.type)) continue
      if (!endpointSeesSpace(endpoint, space, privateSpaces)) continue
      messages.push({ deliveryId: generateId(), workspace, endpointId: endpoint._id, event, attempt: 0 })
    }
  }
  if (messages.length === 0) return

  await deliveryProducer.send(ctx, workspace, messages)
}

export function startTxTranslator (ctx: MeasureContext, config: Config, queue: PlatformQueue): ConsumerHandle {
  const cache: ObjectCache = new Map()
  const classCache: ClassResolutionCache = new Map()
  const endpointCache: EndpointCache = new Map()
  let seen = 0
  let discarded = 0
  let lastReportedAt = 0
  const deliveryProducer = queue.getProducer<WebhookDeliveryMessage>(ctx, QueueTopic.WebhookDelivery)

  return queue.createBatchConsumer<Tx>(
    ctx,
    QueueTopic.Tx,
    CONSUMER_GROUP,
    async (ctx, msgs) => {
      await resolveClassesForBatch(ctx, config, classCache, domainRules, msgs)
      const translated = buildEventsForBatch(domainRules, cache, classCache, msgs)

      // This consumer reads the whole platform tx stream to find the few transactions webhooks care
      // about; the ratio is the cost of that choice, so keep it visible.
      seen += msgs.length
      if (translated.length === 0) discarded += msgs.length
      if (seen - lastReportedAt >= REPORT_EVERY) {
        lastReportedAt = seen
        ctx.info('webhook tx translator throughput', { seen, discarded })
      }
      if (translated.length === 0) return

      const byWorkspace = new Map<WorkspaceUuid, Array<{ space: Ref<Space>, event: WebhookEvent }>>()
      for (const { workspace, space, event } of translated) {
        let list = byWorkspace.get(workspace)
        if (list === undefined) {
          list = []
          byWorkspace.set(workspace, list)
        }
        list.push({ space, event })
      }

      for (const [workspace, events] of byWorkspace) {
        await dispatch(ctx, config, deliveryProducer, endpointCache, workspace, events)
      }
    },
    { batchSize: BATCH_SIZE, batchTimeout: BATCH_TIMEOUT_MS }
  )
}
