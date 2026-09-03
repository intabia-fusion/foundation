//
// Copyright © 2025 Hardcore Engineering Inc.
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

export type DBFlavor = 'postgres' | 'cockroach' | 'unknown'

type SupportedFlavor = Exclude<DBFlavor, 'unknown'>

// Type definitions for different database flavors.
// The keys match the DBFlavor type ('postgres' and 'cockroach').
const dbTypes: Record<
SupportedFlavor,
{
  string: string
  string255: string
  int4: string
  int8: string
  float: string
  decimal: string
}
> = {
  cockroach: {
    string: 'STRING',
    string255: 'STRING(255)',
    int4: 'INT4',
    int8: 'INT8',
    float: 'FLOAT',
    decimal: 'DECIMAL'
  },
  postgres: {
    string: 'TEXT',
    string255: 'VARCHAR(255)',
    int4: 'INTEGER',
    int8: 'BIGINT',
    float: 'DOUBLE PRECISION',
    decimal: 'DECIMAL'
  }
} as const

export function getMigrations (flavor: DBFlavor): [string, string][] {
  if (flavor === 'unknown') {
    throw new Error('Cannot generate migrations for an unknown database flavor.')
  }

  const types = dbTypes[flavor]
  if (types === undefined) {
    throw new Error(`Unsupported database flavor: ${flavor}`)
  }

  // V7 is branch-only, squashed from the V7-V9 iteration so stale stands rerun it.
  return [
    migrationV1(flavor),
    migrationV2(flavor),
    migrationV3(flavor),
    migrationV4(flavor),
    migrationV5(flavor),
    migrationV6(flavor),
    migrationV7(flavor)
  ]
}

function migrationV1 (flavor: SupportedFlavor): [string, string] {
  const types = dbTypes[flavor]

  const sql = `
    CREATE TABLE IF NOT EXISTS billing.livekit_session (
      workspace ${types.string255} NOT NULL,
      session_id ${types.string255} NOT NULL,
      session_start TIMESTAMP NOT NULL,
      session_end TIMESTAMP NOT NULL,
      room ${types.string255} NOT NULL,
      bandwidth ${types.int8} NOT NULL,
      minutes ${types.int8} NOT NULL,
      CONSTRAINT pk_livekit_session PRIMARY KEY (workspace, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_livekit_session_start ON billing.livekit_session (session_start);
    CREATE INDEX IF NOT EXISTS idx_livekit_session_end ON billing.livekit_session (session_end);
    CREATE INDEX IF NOT EXISTS idx_livekit_session_room ON billing.livekit_session (room);

    CREATE TABLE IF NOT EXISTS billing.livekit_egress (
      workspace ${types.string255} NOT NULL,
      egress_id ${types.string255} NOT NULL,
      egress_start TIMESTAMP NOT NULL,
      egress_end TIMESTAMP NOT NULL,
      room ${types.string255} NOT NULL,
      duration ${types.int4} NOT NULL,
      CONSTRAINT pk_livekit_egress PRIMARY KEY (workspace, egress_id)
    );

    CREATE INDEX IF NOT EXISTS idx_livekit_egress_start ON billing.livekit_egress (egress_start);
    CREATE INDEX IF NOT EXISTS idx_livekit_egress_end ON billing.livekit_egress (egress_end);
    CREATE INDEX IF NOT EXISTS idx_livekit_egress_room ON billing.livekit_egress (room);
  `
  return ['init_tables_01', sql]
}

function migrationV2 (flavor: SupportedFlavor): [string, string] {
  const types = dbTypes[flavor]

  const sql = `
    CREATE TABLE IF NOT EXISTS billing.ai_transcript_usage (
      workspace UUID NOT NULL,
      day DATE NOT NULL,
      last_request_id ${types.string255} NOT NULL,
      last_start_time TIMESTAMP NOT NULL,
      total_duration_seconds ${types.float} NOT NULL,
      total_usd ${types.decimal}(12,6) NOT NULL,
      PRIMARY KEY (workspace, day)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_transcript_usage_day ON billing.ai_transcript_usage (day);

    CREATE TABLE IF NOT EXISTS billing.ai_tokens_usage (
      workspace UUID NOT NULL,
      day DATE NOT NULL,
      reason ${types.string255} NOT NULL,
      total_tokens ${types.int8} NOT NULL,
      PRIMARY KEY (workspace, day, reason)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_tokens_usage_day ON billing.ai_tokens_usage (day);
  `
  return ['init_ai_usage_tables_02', sql]
}

function migrationV3 (flavor: SupportedFlavor): [string, string] {
  const sql = `
    UPDATE billing.livekit_session SET bandwidth = 0 WHERE bandwidth IS NULL;
    ALTER TABLE billing.livekit_session ALTER COLUMN bandwidth SET DEFAULT 0;
  `
  return ['fix_bandwidth_nulls_03', sql]
}

function migrationV4 (flavor: SupportedFlavor): [string, string] {
  const types = dbTypes[flavor]

  const sql = `
    CREATE TABLE IF NOT EXISTS billing.livekit_participant_session (
      workspace ${types.string255} NOT NULL,
      participant_id ${types.string255} NOT NULL,
      session_id ${types.string255} NOT NULL,
      room ${types.string255} NOT NULL,
      joined_at TIMESTAMP NOT NULL,
      left_at TIMESTAMP,
      duration_seconds ${types.float} NOT NULL DEFAULT 0,
      CONSTRAINT pk_livekit_participant_session PRIMARY KEY (workspace, participant_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_livekit_participant_session_joined
      ON billing.livekit_participant_session (joined_at);
  `
  return ['add_participant_sessions_04', sql]
}

function migrationV5 (flavor: SupportedFlavor): [string, string] {
  const types = dbTypes[flavor]

  const sql = `
    CREATE TABLE IF NOT EXISTS billing.usage_delta_dedup (
      workspace UUID NOT NULL,
      metric ${types.string255} NOT NULL,
      ref ${types.string255} NOT NULL,
      amount ${types.int8} NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT pk_usage_delta_dedup PRIMARY KEY (workspace, metric, ref)
    );

    CREATE TABLE IF NOT EXISTS billing.workspace_limit_state (
      workspace UUID NOT NULL,
      category ${types.string255} NOT NULL,
      used ${types.int8} NOT NULL DEFAULT 0,
      limit_value ${types.int8} NOT NULL DEFAULT 0,
      exhausted BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT pk_workspace_limit_state PRIMARY KEY (workspace, category)
    );
  `
  return ['add_usage_dedup_and_limit_state_05', sql]
}

function migrationV6 (flavor: SupportedFlavor): [string, string] {
  // Supports the periodic retention cleanup of usage_delta_dedup (see UsageWorker).
  const sql = `
    CREATE INDEX IF NOT EXISTS idx_usage_delta_dedup_created_at ON billing.usage_delta_dedup (created_at);
  `
  return ['add_usage_dedup_created_at_index_06', sql]
}

// Branch-only: AI-token dimensions, provider pools, model registry, two-pool token balance,
// top-up ledger, per-model ASR breakdown. Squashed under a fresh name so stale stands rerun it.
function migrationV7 (flavor: SupportedFlavor): [string, string] {
  const types = dbTypes[flavor]

  const sql = `
    DROP TABLE IF EXISTS billing.ai_tokens_usage;

    CREATE TABLE billing.ai_tokens_usage (
      workspace UUID NOT NULL,
      hour TIMESTAMP NOT NULL,
      reason ${types.string255} NOT NULL,
      provider_id ${types.string255} NOT NULL DEFAULT '',
      model ${types.string255} NOT NULL DEFAULT '',
      level ${types.string255} NOT NULL DEFAULT '',
      client_id ${types.string255} NOT NULL DEFAULT '',
      total_tokens ${types.int8} NOT NULL,
      raw_tokens ${types.int8} NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace, hour, reason, provider_id, model, level, client_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_tokens_usage_hour ON billing.ai_tokens_usage (hour);
    CREATE INDEX IF NOT EXISTS idx_ai_tokens_usage_provider ON billing.ai_tokens_usage (provider_id);
    CREATE INDEX IF NOT EXISTS idx_ai_tokens_usage_model ON billing.ai_tokens_usage (model);
    CREATE INDEX IF NOT EXISTS idx_ai_tokens_usage_level ON billing.ai_tokens_usage (level);
    CREATE INDEX IF NOT EXISTS idx_ai_tokens_usage_client ON billing.ai_tokens_usage (client_id);

    CREATE TABLE IF NOT EXISTS billing.provider_pool (
      provider_id ${types.string255} NOT NULL,
      model ${types.string255} NOT NULL DEFAULT '',
      kind ${types.string255} NOT NULL DEFAULT 'purchased',
      purchased_tokens ${types.int8} NOT NULL DEFAULT 0,
      period ${types.string255} NOT NULL DEFAULT 'monthly',
      period_start TIMESTAMP NOT NULL DEFAULT now(),
      used_tokens ${types.int8} NOT NULL DEFAULT 0,
      exhausted BOOLEAN NOT NULL DEFAULT false,
      notified80 BOOLEAN NOT NULL DEFAULT false,
      notified100 BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (provider_id, model)
    );

    -- (provider, model, level) catalog aibot pushes on startup for the admin UI.
    CREATE TABLE IF NOT EXISTS billing.ai_model_registry (
      provider_id ${types.string255} NOT NULL,
      model ${types.string255} NOT NULL,
      level ${types.string255} NOT NULL DEFAULT '',
      label ${types.string255} NOT NULL DEFAULT '',
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (provider_id, model)
    );

    -- Purchased-token pool (never expires), spent before the tier window each hour.
    DROP TABLE IF EXISTS billing.token_balance;
    CREATE TABLE billing.token_balance (
      workspace UUID NOT NULL,
      remaining_tokens ${types.int8} NOT NULL DEFAULT 0,
      absorbed_until TIMESTAMP,
      absorbed_period ${types.int8} NOT NULL DEFAULT 0,
      period_start TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace)
    );

    -- Ledger of one-time token purchases: PK purchase_id makes the aibot-driven grant
    -- idempotent across event redeliveries; the granted amount lives in token_balance.
    CREATE TABLE IF NOT EXISTS billing.ai_token_topup (
      purchase_id ${types.string255} NOT NULL,
      workspace UUID NOT NULL,
      amount ${types.int8} NOT NULL,
      granted_at TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (purchase_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_token_topup_workspace ON billing.ai_token_topup (workspace, granted_at);

    -- Per-model ASR transcription breakdown (mirrors ai_tokens_usage).
    CREATE TABLE IF NOT EXISTS billing.ai_transcript_usage_detail (
      workspace UUID NOT NULL,
      day DATE NOT NULL,
      provider_id ${types.string255} NOT NULL DEFAULT '',
      model ${types.string255} NOT NULL DEFAULT '',
      level ${types.string255} NOT NULL DEFAULT '',
      client_id ${types.string255} NOT NULL DEFAULT '',
      total_duration_seconds ${types.float} NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace, day, provider_id, model, level, client_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_transcript_usage_detail_day ON billing.ai_transcript_usage_detail (day);
    CREATE INDEX IF NOT EXISTS idx_ai_transcript_usage_detail_provider
      ON billing.ai_transcript_usage_detail (provider_id);
    CREATE INDEX IF NOT EXISTS idx_ai_transcript_usage_detail_model ON billing.ai_transcript_usage_detail (model);
    CREATE INDEX IF NOT EXISTS idx_ai_transcript_usage_detail_level ON billing.ai_transcript_usage_detail (level);
    CREATE INDEX IF NOT EXISTS idx_ai_transcript_usage_detail_client
      ON billing.ai_transcript_usage_detail (client_id);

    -- Leftover from the pre-squash V7/V8 chain on stale stands.
    DROP TABLE IF EXISTS billing.ai_window_reset;
  `
  return ['ai_token_infra_v2_07', sql]
}
