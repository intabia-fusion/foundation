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

import { type WorkspaceUuid, hashWorkspace } from '@hcengineering/core'
import { readFileSync } from 'fs'
import * as yaml from 'js-yaml'

import { type EndpointInfo, EndpointKind } from './utils'
import { type RegionInfo } from './types'

/** Single endpoint with external and internal URLs */
export interface EndpointEntry {
  external: string
  internal: string
}

/** Endpoints for a region */
export interface RegionEndpoints {
  name?: string
  transactors: EndpointEntry[]
  collaborators: EndpointEntry[]
}

/** Full region configuration */
export interface RegionConfig {
  regions: Record<string, RegionEndpoints>
  workspaces?: Record<string, RegionEndpoints>
}

/** Resolved endpoints for a specific workspace */
export interface ResolvedEndpoints {
  transactor: EndpointEntry
  collaborator: EndpointEntry
  effectiveRegion: string
}

/**
 * Load region config from environment.
 * Priority: REGION_CONFIG (YAML file path) → REGION_CONFIG_JSON (inline JSON)
 */
export function loadRegionConfig (): RegionConfig {
  const configPath = process.env.REGION_CONFIG
  if (configPath !== undefined && configPath.length > 0) {
    const content = readFileSync(configPath, 'utf-8')
    let config: unknown
    try {
      config = yaml.load(content)
    } catch (err) {
      throw new Error(`REGION_CONFIG file '${configPath}' is empty or invalid YAML`)
    }
    return validateRegionConfig(config, `REGION_CONFIG file '${configPath}'`)
  }

  const configJson = process.env.REGION_CONFIG_JSON
  if (configJson !== undefined && configJson.length > 0) {
    const config = JSON.parse(configJson)
    return validateRegionConfig(config, 'REGION_CONFIG_JSON env variable')
  }

  throw new Error('REGION_CONFIG or REGION_CONFIG_JSON must be set')
}

function validateRegionConfig (config: unknown, source: string): RegionConfig {
  if (config === null || typeof config !== 'object') {
    throw new Error(`Invalid region config from ${source}: expected an object`)
  }
  const obj = config as Record<string, unknown>
  if (obj.regions === undefined || typeof obj.regions !== 'object' || obj.regions === null) {
    throw new Error(`Invalid region config from ${source}: missing or invalid 'regions' field`)
  }
  return config as RegionConfig
}

/**
 * Select an endpoint from an array using workspace hash
 */
function selectFromArray (entries: EndpointEntry[], workspaceUuid: string): EndpointEntry {
  if (entries.length === 0) {
    throw new Error('No endpoints available')
  }
  if (entries.length === 1) {
    return entries[0]
  }
  const hash = hashWorkspace(workspaceUuid)
  return entries[Math.abs(hash % entries.length)]
}

/**
 * Resolve endpoints for a workspace: workspace override → region → default region
 */
export function resolveEndpoints (
  config: RegionConfig,
  workspaceUuid: WorkspaceUuid,
  region: string | undefined
): ResolvedEndpoints {
  // 1. Check workspace overrides
  if (config.workspaces?.[workspaceUuid] !== undefined) {
    const ws = config.workspaces[workspaceUuid]
    return {
      transactor: selectFromArray(ws.transactors, workspaceUuid),
      collaborator: selectFromArray(ws.collaborators, workspaceUuid),
      effectiveRegion: region ?? ''
    }
  }

  // 2. Look up by region, fall back to default
  let effectiveRegion = region ?? ''
  let endpoints = config.regions[effectiveRegion]
  if (endpoints === undefined || endpoints.transactors.length === 0) {
    effectiveRegion = ''
    endpoints = config.regions['']
  }
  if (endpoints === undefined) {
    throw new Error(`No endpoints configured for region '${region ?? ''}' or default region`)
  }

  const transactor = selectFromArray(endpoints.transactors, workspaceUuid)

  // For collaborators, fall back to default region if current region has none
  let collabEndpoints = endpoints.collaborators
  if (collabEndpoints.length === 0) {
    collabEndpoints = config.regions['']?.collaborators ?? []
  }
  if (collabEndpoints.length === 0) {
    throw new Error(`No collaborator endpoints configured for region '${region ?? ''}' or default region`)
  }
  const collaborator = selectFromArray(collabEndpoints, workspaceUuid)

  return { transactor, collaborator, effectiveRegion }
}

/**
 * Resolve a URL from an EndpointEntry based on EndpointKind
 */
export function resolveUrl (entry: EndpointEntry, kind: EndpointKind): string {
  return kind === EndpointKind.Internal ? entry.internal : entry.external
}

/**
 * Convert EndpointEntry to EndpointInfo format
 */
export function toEndpointInfo (entry: EndpointEntry, region: string): EndpointInfo {
  return {
    internalUrl: entry.internal,
    externalUrl: entry.external,
    region
  }
}

/**
 * Get region info list from config
 */
export function getRegionsFromConfig (config: RegionConfig): RegionInfo[] {
  return Object.entries(config.regions).map(([region, endpoints]) => ({
    region,
    name: endpoints.name ?? ''
  }))
}
