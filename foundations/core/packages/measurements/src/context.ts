// Basic performance metrics suite.

import { platformNow, platformNowDiff } from '.'
import { childMetricsSingle, newMetrics, updateMeasure } from './metrics'
import {
  type FullParamsType,
  type MeasureContext,
  type MeasureLogger,
  type Metrics,
  type ParamsType,
  type OperationLog,
  type OperationLogEntry,
  type WithOptions
} from './types'

const errorPrinter = ({ message, stack, ...rest }: Error): object => ({
  message,
  stack,
  ...rest
})
function replacer (value: any): any {
  return value instanceof Error ? errorPrinter(value) : value
}

export const consoleLogger = (logParams: Record<string, any>): MeasureLogger => ({
  info: (msg, args) => {
    console.info(
      msg,
      ...Object.entries({ ...(args ?? {}), ...(logParams ?? {}) }).map(
        (it) => `${it[0]}=${JSON.stringify(replacer(it[1]))}`
      )
    )
  },
  error: (msg, args) => {
    console.error(
      msg,
      ...Object.entries({ ...(args ?? {}), ...(logParams ?? {}) }).map(
        (it) => `${it[0]}=${JSON.stringify(replacer(it[1]))}`
      )
    )
  },
  warn: (msg, args) => {
    console.warn(msg, ...Object.entries(args ?? {}).map((it) => `${it[0]}=${JSON.stringify(replacer(it[1]))}`))
  },
  close: async () => {},
  logOperation: (operation, time, params) => {}
})

export const noParamsLogger = consoleLogger({})

export const nullPromise = Promise.resolve()

/**
 * @public
 */
export class MeasureMetricsContext implements MeasureContext {
  private readonly name: string
  private readonly params: ParamsType

  private readonly fullParams: FullParamsType | (() => FullParamsType) = {}
  logger: MeasureLogger
  metrics: Metrics
  id?: string

  st = platformNow()
  contextData: object = {}
  private done (value?: number, override?: boolean): void {
    updateMeasure(this.metrics, this.st, this.params, this.fullParams, (spend) => {}, value, override)
  }

  constructor (
    name: string,
    params: ParamsType,
    fullParams: FullParamsType | (() => FullParamsType) = {},
    metrics: Metrics = newMetrics(),
    logger?: MeasureLogger,
    readonly parent?: MeasureContext,
    readonly logParams?: ParamsType
  ) {
    this.name = name
    this.params = params
    this.fullParams = fullParams
    this.metrics = metrics
    // Fast path: skip Object.entries alloc when no params. ctx.with('name', {}, ...)
    // is by far the most common call site. namedParams is always pre-allocated.
    for (const k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue
      const v = (params as any)[k]
      if (this.metrics.namedParams[k] !== v) {
        this.metrics.namedParams[k] = v
      } else {
        this.metrics.namedParams[k] = '*'
      }
    }

    this.logger = logger ?? (this.logParams != null ? consoleLogger(this.logParams ?? {}) : noParamsLogger)
  }

  measure (name: string, value: number, labelsOrOverride?: ParamsType | boolean, override?: boolean): void {
    const isLabels = typeof labelsOrOverride === 'object' && labelsOrOverride !== null
    const labels = isLabels ? labelsOrOverride : undefined
    const ov = isLabels ? override : labelsOrOverride
    const c = new MeasureMetricsContext(
      '#' + name,
      labels ?? {},
      {},
      childMetricsSingle(this.metrics, '#' + name),
      this.logger,
      this
    )
    c.contextData = this.contextData
    c.done(value, ov)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let root: MeasureContext = this
    while (root.parent != null) root = root.parent
    const sink = (root as MeasureMetricsContext).externalMetricSink
    sink?.(name, value, labels)
  }

  recordDuration (name: string, ms: number, labels?: ParamsType): void {
    // In-memory metrics implementation: accumulate via childMetrics
    const c = new MeasureMetricsContext(
      '@' + name,
      labels ?? {},
      {},
      childMetricsSingle(this.metrics, '@' + name),
      this.logger,
      this
    )
    c.contextData = this.contextData
    c.done(ms)
    // Propagate to external sink (root-level registration). Traverse to root.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let root: MeasureContext = this
    while (root.parent != null) root = root.parent
    const sink = (root as MeasureMetricsContext).externalMetricSink
    sink?.(name, ms, labels)
  }

  externalMetricSink?: (name: string, value: number, labels?: ParamsType) => void

  newChild (
    name: string,
    params: ParamsType,
    opt?: {
      fullParams?: FullParamsType
      logger?: MeasureLogger
      span?: WithOptions['span'] // By default true
    }
  ): MeasureContext {
    const result = new MeasureMetricsContext(
      name,
      params,
      opt?.fullParams ?? {},
      childMetricsSingle(this.metrics, name),
      opt?.logger ?? this.logger,
      this,
      this.logParams
    )
    result.id = this.id
    result.contextData = this.contextData
    return result
  }

  with<T>(
    name: string,
    params: ParamsType,
    op: (ctx: MeasureContext) => T | Promise<T>,
    fullParams?: ParamsType | (() => FullParamsType),
    opt?: WithOptions
  ): Promise<T> {
    const c = this.newChild(name, params, { fullParams, logger: this.logger })
    const metric = opt?.metric
    let needFinally = true
    try {
      const value = op(c)
      if (value instanceof Promise) {
        needFinally = false
        return value.finally(() => {
          const elapsed = platformNowDiff((c as MeasureMetricsContext).st)
          c.end()
          if (metric !== undefined) {
            this.recordDuration(metric, elapsed, { op: name, ...params })
          }
          if (opt?.log === true) {
            this.logger.logOperation(name, elapsed, {
              ...params,
              ...fullParams
            })
          }
        })
      } else {
        if (value == null) {
          return nullPromise as Promise<T>
        }
        return Promise.resolve(value)
      }
    } finally {
      if (needFinally) {
        if (metric !== undefined) {
          this.recordDuration(metric, platformNowDiff((c as MeasureMetricsContext).st), { op: name, ...params })
        }
        c.end()
      }
    }
  }

  extractMeta (): Record<string, string | number | boolean> {
    return {}
  }

  withSync<T>(
    name: string,
    params: ParamsType,
    op: (ctx: MeasureContext) => T,
    fullParams?: ParamsType | (() => FullParamsType)
  ): T {
    const c = this.newChild(name, params, { fullParams, logger: this.logger })
    try {
      return op(c)
    } finally {
      c.end()
    }
  }

  error (message: string, args?: Record<string, any>): void {
    this.logger.error(message, { ...this.params, ...args, ...(this.logParams ?? {}) })
  }

  info (message: string, args?: Record<string, any>): void {
    this.logger.info(message, { ...this.params, ...args, ...(this.logParams ?? {}) })
  }

  warn (message: string, args?: Record<string, any>): void {
    this.logger.warn(message, { ...this.params, ...args, ...(this.logParams ?? {}) })
  }

  end (): void {
    this.done()
  }

  getParams (): ParamsType {
    return this.params
  }
}

export class NoMetricsContext implements MeasureContext {
  logger: MeasureLogger
  id?: string

  contextData: object = {}

  constructor (logger?: MeasureLogger) {
    this.logger = logger ?? consoleLogger({})
  }

  measure (name: string, value: number, labelsOrOverride?: ParamsType | boolean, override?: boolean): void {}

  recordDuration (name: string, ms: number, labels?: ParamsType): void {}

  newChild (
    name: string,
    params: ParamsType,
    fullParams?: FullParamsType | (() => FullParamsType),
    logger?: MeasureLogger
  ): MeasureContext {
    const result = new NoMetricsContext(logger ?? this.logger)
    result.id = this.id
    result.contextData = this.contextData
    return result
  }

  with<T>(
    name: string,
    params: ParamsType,
    op: (ctx: MeasureContext) => T | Promise<T>,
    fullParams?: ParamsType | (() => FullParamsType)
  ): Promise<T> {
    const r = op(this.newChild(name, params, fullParams, this.logger))
    return r instanceof Promise ? r : Promise.resolve(r)
  }

  extractMeta (): Record<string, string | number | boolean> {
    return {}
  }

  withSync<T>(
    name: string,
    params: ParamsType,
    op: (ctx: MeasureContext) => T,
    fullParams?: ParamsType | (() => FullParamsType)
  ): T {
    const c = this.newChild(name, params, fullParams, this.logger)
    return op(c)
  }

  withLog<T>(
    name: string,
    params: ParamsType,
    op: (ctx: MeasureContext) => T | Promise<T>,
    fullParams?: ParamsType
  ): Promise<T> {
    const r = op(this.newChild(name, params, fullParams, this.logger))
    return r instanceof Promise ? r : Promise.resolve(r)
  }

  error (message: string, args?: Record<string, any>): void {
    this.logger.error(message, { ...args })
  }

  info (message: string, args?: Record<string, any>): void {
    this.logger.info(message, { ...args })
  }

  warn (message: string, args?: Record<string, any>): void {
    this.logger.warn(message, { ...args })
  }

  end (): void {}

  getParams (): ParamsType {
    return {}
  }
}

/**
 * Allow to use decorator for context enabled functions
 */
export function withContext (name: string, params: ParamsType = {}, options?: WithOptions): any {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor): PropertyDescriptor => {
    const originalMethod = descriptor.value
    descriptor.value = function (...args: any[]): Promise<any> {
      const ctx = args[0] as MeasureContext
      return ctx.with(
        name,
        params,
        (ctx) => originalMethod.apply(this, [ctx, ...args.slice(1)]) as Promise<any>,
        {},
        options
      )
    }
    return descriptor
  }
}

let operationProfiling = false

export function setOperationLogProfiling (value: boolean): void {
  operationProfiling = value
}

let globalId: number = 0

export function registerOperationLog (ctx: MeasureContext): { opLogMetrics?: Metrics, op?: OperationLog } {
  if (!operationProfiling) {
    return {}
  }
  const op: OperationLog = { start: platformNow(), ops: [], end: -1 }
  let opLogMetrics: Metrics | undefined

  ctx.id ??= 'op_' + (++globalId).toString(16)
  if (ctx.metrics !== undefined) {
    ctx.metrics.opLog ??= {}
    ctx.metrics.opLog[ctx.id] = op
    opLogMetrics = ctx.metrics
  }
  return { opLogMetrics, op }
}

export function updateOperationLog (opLogMetrics: Metrics | undefined, op: OperationLog | undefined): void {
  if (!operationProfiling) {
    return
  }
  if (op !== undefined) {
    op.end = platformNow()
  }
  // We should keep only longest one entry
  if (opLogMetrics?.opLog !== undefined) {
    const entries = Object.entries(opLogMetrics.opLog)

    const incomplete = entries.filter((it) => it[1].end === -1)
    const complete = entries.filter((it) => it[1].end !== -1)
    complete.sort((a, b) => a[1].start - b[1].start)
    if (complete.length > 30) {
      complete.splice(0, complete.length - 30)
    }

    opLogMetrics.opLog = Object.fromEntries(incomplete.concat(complete))
  }
}

export function addOperation<T> (
  ctx: MeasureContext,
  name: string,
  params: ParamsType,
  op: (ctx: MeasureContext) => Promise<T>,
  fullParams?: FullParamsType
): Promise<T> {
  if (!operationProfiling) {
    return op(ctx)
  }
  let opEntry: OperationLogEntry | undefined

  let p: MeasureContext | undefined = ctx
  let opLogMetrics: Metrics | undefined
  let id: string | undefined

  while (p !== undefined) {
    if (p.metrics?.opLog !== undefined) {
      opLogMetrics = p.metrics
    }
    if (id === undefined && p.id !== undefined) {
      id = p.id
    }
    p = p.parent
  }
  const opLog = id !== undefined ? opLogMetrics?.opLog?.[id] : undefined

  if (opLog !== undefined) {
    opEntry = {
      op: name,
      start: performance.now(),
      params: {},
      end: -1
    }
  }
  const result = op(ctx)
  if (opEntry !== undefined && opLog !== undefined) {
    void result.finally(() => {
      if (opEntry !== undefined && opLog !== undefined) {
        opEntry.end = performance.now()
        opEntry.params = { ...params, ...(typeof fullParams === 'function' ? fullParams() : fullParams) }
        opLog.ops.push(opEntry)
      }
    })
  }
  return result
}
