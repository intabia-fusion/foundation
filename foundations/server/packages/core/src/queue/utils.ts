import { type QueueTopic } from './types'

export function getDeadletterTopic (topic: QueueTopic): string {
  return `${topic}-d`
}

/** Region-prefixed topic name; the queue implementation appends the stand postfix itself. */
export function getRegionTopic (topic: QueueTopic | string, region: string | null | undefined): string {
  return region == null || region === '' ? `${topic}` : `${region}.${topic}`
}
