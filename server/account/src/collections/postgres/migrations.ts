//
// Copyright © 2025 Hardcore Engineering Inc.
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

import { type DBFlavor } from '../../types'

// Type definitions for different database flavors.
// The keys match the DBFlavor type ('postgres' and 'cockroach').
// The SQL syntax used (e.g., BIGSERIAL, JSONB, generated columns) is compatible with
// modern PostgreSQL versions (v13+) and is expected to be forward-compatible with future versions like 18.1.
const dbTypes = {
  ['cockroach' as DBFlavor]: {
    string: 'STRING',
    bytes: 'BYTES',
    int2: 'INT2',
    int4: 'INT4',
    int8: 'INT8',
    bool: 'BOOL',
    // unique_rowid() generates a unique INT8
    autoIncrementInt8: (ns: string) => 'INT8 NOT NULL DEFAULT unique_rowid()'
  },
  ['postgres' as DBFlavor]: {
    string: 'TEXT',
    bytes: 'BYTEA',
    int2: 'SMALLINT',
    int4: 'INTEGER',
    int8: 'BIGINT',
    bool: 'BOOLEAN',
    // Use special function to generate a cryptographic random bigint
    autoIncrementInt8: (ns: string) => `BIGINT NOT NULL DEFAULT ${ns}.gen_random_bigint()`
  }
}

/**
 * Adding a column and reading it must be two separate migrations.
 *
 * CockroachDB parses a multi-statement batch as a whole, so a backfill sitting next to its own
 * ADD COLUMN fails with "column does not exist" and the migration retries forever - the workspace
 * pod then stops processing anything. PostgreSQL runs the same batch fine, so this only shows up on
 * the cockroach regions. See v35/v36 and v32/v33.
 */
export function getMigrations (ns: string, flavor: DBFlavor): [string, string][] {
  if (flavor === 'unknown') {
    throw new Error('Cannot generate migrations for an unknown database flavor.')
  }

  const types = dbTypes[flavor]
  if (types === undefined) {
    // This should not happen if DBFlavor is typed correctly, but it's a good safeguard.
    throw new Error(`Unsupported database flavor: ${flavor}`)
  }

  return [
    getV1Migration(ns, flavor),
    getV2Migration1(ns, flavor),
    getV2Migration2(ns, flavor),
    getV2Migration3(ns, flavor),
    getV3Migration(ns, flavor),
    getV4Migration(ns, flavor),
    getV4Migration1(ns, flavor),
    getV5Migration(ns, flavor),
    getV6Migration(ns, flavor),
    getV7Migration(ns, flavor),
    getV8Migration(ns, flavor),
    getV9Migration(ns, flavor),
    getV10Migration1(ns, flavor),
    getV10Migration2(ns, flavor),
    getV11Migration(ns, flavor),
    getV12Migration(ns, flavor),
    getV13Migration(ns, flavor),
    getV14Migration(ns, flavor),
    getV15Migration(ns, flavor),
    getV16Migration(ns, flavor),
    getV17Migration(ns, flavor),
    getV18Migration(ns, flavor),
    getV19Migration(ns, flavor),
    getV20Migration(ns, flavor),
    getV21Migration(ns, flavor),
    getV22Migration(ns, flavor),
    getV23Migration(ns, flavor),
    getV24Migration(ns, flavor),
    getV25Migration(ns, flavor),
    getV26Migration(ns, flavor),
    getV27Migration(ns, flavor),
    getV28Migration(ns, flavor),
    getV29Migration(ns, flavor),
    getV30Migration(ns, flavor),
    getV31Migration(ns, flavor),
    getV32Migration(ns, flavor),
    getV33Migration(ns),
    getV34Migration(ns),
    getV35Migration(ns, flavor),
    getV36Migration(ns),
    getV37Migration(ns),
    getV38Migration(ns),
    getV39Migration(ns, flavor),
    getV40Migration(ns),
    getV41Migration(ns)
  ]
}

// NOTE: NEVER MODIFY EXISTING MIGRATIONS. IF YOU NEED TO ADJUST THE SCHEMA, ADD A NEW MIGRATION.
function getV1Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  // Define the generated 'key' column with flavor-specific syntax.
  // For PostgreSQL, we use a custom immutable function to ensure the expression is valid.
  const keyColumnDefinition =
    flavor === 'postgres'
      ? `key ${types.string} GENERATED ALWAYS AS (${ns}.social_id_type_to_text(type) || ':' || value) STORED`
      : `key ${types.string} AS (CONCAT(type::TEXT, ':', value)) STORED`

  return [
    'account_db_v1_global_init',
    `
    /* ======= FUNCTIONS ======= */

    CREATE OR REPLACE FUNCTION current_epoch_ms()
    RETURNS BIGINT AS $$         SELECT (extract(epoch from current_timestamp) * 1000)::bigint;
    $$ LANGUAGE SQL;

    /* ======= E X T E N S I O N S ======= */
    -- Enable the pgcrypto extension for cryptographic functions, e.g., gen_random_bytes().
    -- This is required for secure, non-sequential ID generation in PostgreSQL.
    -- This is a no-op for CockroachDB as it doesn't support extensions this way.
    ${flavor === 'postgres' ? 'CREATE EXTENSION IF NOT EXISTS pgcrypto;' : '-- pgcrypto not needed for CockroachDB'}

    /* ======= T Y P E S ======= */
    CREATE TYPE ${ns}.social_id_type AS ENUM ('email', 'github', 'google', 'phone', 'oidc', 'huly', 'telegram');
    CREATE TYPE ${ns}.location AS ENUM ('kv', 'weur', 'eeur', 'wnam', 'enam', 'apac');
    CREATE TYPE ${ns}.workspace_role AS ENUM ('OWNER', 'MAINTAINER', 'USER', 'GUEST', 'DOCGUEST');

    /* ======= HELPER FUNCTIONS FOR GENERATED COLUMNS ======= */
    -- Create an immutable function to cast the social_id_type enum to text.
    -- This is required for PostgreSQL to consider the generated expression immutable.
    CREATE OR REPLACE FUNCTION ${ns}.social_id_type_to_text(val ${ns}.social_id_type)
    RETURNS TEXT AS $$         SELECT val::TEXT;
    $$ LANGUAGE SQL IMMUTABLE;

    ${
      flavor === 'postgres'
        ? `
    -- Create a function to generate a random, non-sequential, non-negative BIGINT for secure IDs.
    -- This prevents enumeration attacks. We use a standard method of encoding to hex and casting.
    CREATE OR REPLACE FUNCTION ${ns}.gen_random_bigint()
    RETURNS BIGINT AS $$             SELECT ('x' || encode(gen_random_bytes(8), 'hex'))::bit(64)::bigint & 9223372036854775807::bigint;
    $$ LANGUAGE SQL VOLATILE;
    `
        : ''
    }

    /* ======= P E R S O N ======= */
    CREATE TABLE IF NOT EXISTS ${ns}.person (
        uuid UUID NOT NULL DEFAULT gen_random_uuid(),
        first_name ${types.string} NOT NULL,
        last_name ${types.string} NOT NULL,
        country ${types.string},
        city ${types.string},
        CONSTRAINT person_pk PRIMARY KEY (uuid)
    );

    /* ======= A C C O U N T ======= */
    CREATE TABLE IF NOT EXISTS ${ns}.account (
        uuid UUID NOT NULL,
        timezone ${types.string},
        locale ${types.string},
        CONSTRAINT account_pk PRIMARY KEY (uuid),
        CONSTRAINT account_person_fk FOREIGN KEY (uuid) REFERENCES ${ns}.person(uuid)
    );

    CREATE TABLE IF NOT EXISTS ${ns}.account_passwords (
        account_uuid UUID NOT NULL,
        hash ${types.bytes} NOT NULL,
        salt ${types.bytes} NOT NULL,
        CONSTRAINT account_auth_pk PRIMARY KEY (account_uuid),
        CONSTRAINT account_passwords_account_fk FOREIGN KEY (account_uuid) REFERENCES ${ns}.account(uuid)
    );

    CREATE TABLE IF NOT EXISTS ${ns}.account_events (
        account_uuid UUID NOT NULL,
        event_type ${types.string} NOT NULL,
        time BIGINT NOT NULL DEFAULT current_epoch_ms(),
        data JSONB,
        CONSTRAINT account_events_pk PRIMARY KEY (account_uuid, event_type, time),
        CONSTRAINT account_events_account_fk FOREIGN KEY (account_uuid) REFERENCES ${ns}.account(uuid)
    );

    /* ======= S O C I A L   I D S ======= */
    CREATE TABLE IF NOT EXISTS ${ns}.social_id (
        type ${ns}.social_id_type NOT NULL,
        value ${types.string} NOT NULL,
        ${keyColumnDefinition},
        person_uuid UUID NOT NULL,
        created_on BIGINT NOT NULL DEFAULT current_epoch_ms(),
        verified_on BIGINT,
        CONSTRAINT social_id_pk PRIMARY KEY (type, value),
        CONSTRAINT social_id_key_unique UNIQUE (key),
        CONSTRAINT social_id_person_fk FOREIGN KEY (person_uuid) REFERENCES ${ns}.person(uuid)
    );

    /* ======= W O R K S P A C E ======= */
    CREATE TABLE IF NOT EXISTS ${ns}.workspace (
        uuid UUID NOT NULL DEFAULT gen_random_uuid(),
        name ${types.string} NOT NULL,
        url ${types.string} NOT NULL,
        data_id ${types.string},
        branding ${types.string},
        location ${ns}.location,
        region ${types.string},
        created_by UUID, -- account uuid
        created_on BIGINT NOT NULL DEFAULT current_epoch_ms(),
        billing_account UUID,
        CONSTRAINT workspace_pk PRIMARY KEY (uuid),
        CONSTRAINT workspace_url_unique UNIQUE (url),
        CONSTRAINT workspace_created_by_fk FOREIGN KEY (created_by) REFERENCES ${ns}.account(uuid),
        CONSTRAINT workspace_billing_account_fk FOREIGN KEY (billing_account) REFERENCES ${ns}.account(uuid)
    );

    CREATE TABLE IF NOT EXISTS ${ns}.workspace_status (
        workspace_uuid UUID NOT NULL,
        mode ${types.string},
        processing_progress ${types.int2} DEFAULT 0,
        version_major ${types.int2} NOT NULL DEFAULT 0,
        version_minor ${types.int2} NOT NULL DEFAULT 0,
        version_patch ${types.int4} NOT NULL DEFAULT 0,
        last_processing_time BIGINT DEFAULT 0,
        last_visit BIGINT,
        is_disabled ${types.bool} DEFAULT FALSE,
        processing_attempts ${types.int2} DEFAULT 0,
        processing_message ${types.string},
        backup_info JSONB,
        CONSTRAINT workspace_status_pk PRIMARY KEY (workspace_uuid),
        CONSTRAINT workspace_status_workspace_fk FOREIGN KEY (workspace_uuid) REFERENCES ${ns}.workspace(uuid)
    );

    CREATE TABLE IF NOT EXISTS ${ns}.workspace_members (
        workspace_uuid UUID NOT NULL,
        account_uuid UUID NOT NULL,
        role ${ns}.workspace_role NOT NULL DEFAULT 'USER',
        CONSTRAINT workspace_assignment_pk PRIMARY KEY (workspace_uuid, account_uuid),
        CONSTRAINT members_workspace_fk FOREIGN KEY (workspace_uuid) REFERENCES ${ns}.workspace(uuid),
        CONSTRAINT members_account_fk FOREIGN KEY (account_uuid) REFERENCES ${ns}.account(uuid)
    );

    /* ========================================================================================== */
    /* MAIN SCHEMA ENDS HERE */
    /* ===================== */

    /* ======= O T P ======= */
    CREATE TABLE IF NOT EXISTS ${ns}.otp (
        social_id ${types.string} NOT NULL,
        code ${types.string} NOT NULL,
        expires_on BIGINT NOT NULL,
        created_on BIGINT NOT NULL DEFAULT current_epoch_ms(),
        CONSTRAINT otp_pk PRIMARY KEY (social_id, code),
        CONSTRAINT otp_social_id_fk FOREIGN KEY (social_id) REFERENCES ${ns}.social_id(key)
    );

    /* ======= I N V I T E ======= */
    CREATE TABLE IF NOT EXISTS ${ns}.invite (
        id ${types.autoIncrementInt8(ns)} PRIMARY KEY,
        workspace_uuid UUID NOT NULL,
        expires_on BIGINT NOT NULL,
        email_pattern ${types.string},
        remaining_uses ${types.int2},
        role ${ns}.workspace_role NOT NULL DEFAULT 'USER',
        migrated_from ${types.string},
        CONSTRAINT invite_workspace_fk FOREIGN KEY (workspace_uuid) REFERENCES ${ns}.workspace(uuid)
    );

    /* ======= I N D E X E S ======= */
    CREATE INDEX IF NOT EXISTS social_id_account_idx ON ${ns}.social_id (person_uuid);
    CREATE INDEX IF NOT EXISTS workspace_invite_idx ON ${ns}.invite (workspace_uuid);
    CREATE INDEX IF NOT EXISTS migrated_from_idx ON ${ns}.invite (migrated_from);
`
  ]
}

function getV2Migration1 (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]
  return [
    'account_db_v2_social_id_id_add',
    `
    -- Add the _id column to the social_id table with a random default value.
    ALTER TABLE ${ns}.social_id
    ADD COLUMN IF NOT EXISTS _id ${types.autoIncrementInt8(ns)};
    `
  ]
}

function getV2Migration2 (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v2_social_id_pk_change',
    `
    -- Drop the existing otp foreign key constraint
    ALTER TABLE ${ns}.otp
    DROP CONSTRAINT IF EXISTS otp_social_id_fk;

    -- Drop the existing primary key on social_id
    ALTER TABLE ${ns}.social_id
    DROP CONSTRAINT IF EXISTS social_id_pk;

    -- Add the new primary key on _id
    ALTER TABLE ${ns}.social_id
    ADD CONSTRAINT social_id_pk PRIMARY KEY (_id);
    `
  ]
}

function getV2Migration3 (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  // Generate flavor-specific SQL for adding the constraint.
  const addConstraintSql =
    flavor === 'postgres'
      ? `
    -- Add unique constraint on type, value (PostgreSQL compatible with DO block)
    DO $$     BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint
            WHERE conname = 'social_id_tv_key_unique'
            AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${ns}')
            AND conrelid = (SELECT oid FROM pg_class WHERE relname = 'social_id' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${ns}'))
        ) THEN
            ALTER TABLE ${ns}.social_id
            ADD CONSTRAINT social_id_tv_key_unique UNIQUE (type, value);
        END IF;
    END $$;
    `
      : `
    -- Add unique constraint on type, value (CockroachDB compatible)
    ALTER TABLE ${ns}.social_id
    ADD CONSTRAINT IF NOT EXISTS social_id_tv_key_unique UNIQUE (type, value);
    `

  return [
    'account_db_v2_social_id_constraints',
    `
    ${addConstraintSql}

    -- Drop the old table
    DROP TABLE IF EXISTS ${ns}.otp;

    -- Create the new OTP table with the correct column type
    CREATE TABLE ${ns}.otp (
        social_id ${types.int8} NOT NULL,
        code ${types.string} NOT NULL,
        expires_on BIGINT NOT NULL,
        created_on BIGINT NOT NULL DEFAULT current_epoch_ms(),
        CONSTRAINT otp_new_pk PRIMARY KEY (social_id, code),
        CONSTRAINT otp_new_social_id_fk FOREIGN KEY (social_id) REFERENCES ${ns}.social_id(_id)
    );
    `
  ]
}

function getV3Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  return [
    'account_db_v3_add_invite_auto_join_final',
    `
    ALTER TABLE ${ns}.invite
    ADD COLUMN IF NOT EXISTS email ${types.string},
    ADD COLUMN IF NOT EXISTS auto_join ${types.bool} DEFAULT FALSE;

    ALTER TABLE ${ns}.account
    ADD COLUMN IF NOT EXISTS automatic ${types.bool};
    `
  ]
}

function getV4Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  return [
    'account_db_v4_mailbox',
    `
    CREATE TABLE IF NOT EXISTS ${ns}.mailbox (
        account_uuid UUID NOT NULL,
        mailbox ${types.string} NOT NULL,
        CONSTRAINT mailbox_pk PRIMARY KEY (mailbox),
        CONSTRAINT mailbox_account_fk FOREIGN KEY (account_uuid) REFERENCES ${ns}.account(uuid)
    );

    CREATE TABLE IF NOT EXISTS ${ns}.mailbox_secrets (
        mailbox ${types.string} NOT NULL,
        app ${types.string},
        secret ${types.string} NOT NULL,
        CONSTRAINT mailbox_secret_mailbox_fk FOREIGN KEY (mailbox) REFERENCES ${ns}.mailbox(mailbox)
    );
      `
  ]
}

function getV4Migration1 (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v4_remove_mailbox_account_fk',
    `
    ALTER TABLE ${ns}.mailbox
    DROP CONSTRAINT IF EXISTS mailbox_account_fk;
    `
  ]
}

function getV5Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  return [
    'account_db_v5_social_id_is_deleted',
    `
    ALTER TABLE ${ns}.social_id
    ADD COLUMN IF NOT EXISTS is_deleted ${types.bool} NOT NULL DEFAULT FALSE;
    `
  ]
}

function getV6Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  // Generated column syntax: PostgreSQL uses GENERATED ALWAYS AS (...) STORED
  // CockroachDB supports both syntaxes, so we use PostgreSQL-compatible one
  return [
    'account_db_v6_add_social_id_integrations',
    `
    CREATE TABLE IF NOT EXISTS ${ns}.integrations (
        social_id ${types.int8} NOT NULL,
        kind ${types.string} NOT NULL,
        workspace_uuid UUID,
        _def_ws_uuid UUID NOT NULL GENERATED ALWAYS AS (COALESCE(workspace_uuid, '00000000-0000-0000-0000-000000000000'::UUID)) STORED,
        data JSONB,
        CONSTRAINT integrations_pk PRIMARY KEY (social_id, kind, _def_ws_uuid),
        CONSTRAINT integrations_social_id_fk FOREIGN KEY (social_id) REFERENCES ${ns}.social_id(_id),
        CONSTRAINT integrations_workspace_fk FOREIGN KEY (workspace_uuid) REFERENCES ${ns}.workspace(uuid)
    );

    CREATE TABLE IF NOT EXISTS ${ns}.integration_secrets (
        social_id ${types.int8} NOT NULL,
        kind ${types.string} NOT NULL,
        workspace_uuid UUID,
        _def_ws_uuid UUID NOT NULL GENERATED ALWAYS AS (COALESCE(workspace_uuid, '00000000-0000-0000-0000-000000000000'::UUID)) STORED,
        key ${types.string},
        secret ${types.string} NOT NULL,
        CONSTRAINT integration_secrets_pk PRIMARY KEY (social_id, kind, _def_ws_uuid, key)
    );

    /* ======= I N D E X E S ======= */
    CREATE INDEX IF NOT EXISTS integrations_kind_idx ON ${ns}.integrations (kind);
    `
  ]
}

function getV7Migration (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v7_add_display_value',
    `
    ALTER TABLE ${ns}.social_id
    ADD COLUMN IF NOT EXISTS display_value TEXT;
    `
  ]
}

function getV8Migration (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v8_add_account_max_workspaces',
    `
    ALTER TABLE ${ns}.account
    ADD COLUMN IF NOT EXISTS max_workspaces SMALLINT;
    `
  ]
}

function getV9Migration (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v9_add_migrated_to_person',
    `
    ALTER TABLE ${ns}.person
    ADD COLUMN IF NOT EXISTS migrated_to UUID,
    ADD CONSTRAINT person_migrated_to_fk FOREIGN KEY (migrated_to) REFERENCES ${ns}.person(uuid);
    `
  ]
}

function getV10Migration1 (ns: string, flavor: DBFlavor): [string, string] {
  // For PostgreSQL, we need to check if the value exists before adding it
  const addValueSql =
    flavor === 'postgres'
      ? `
    -- Add READONLYGUEST value to workspace_role enum (PostgreSQL)
    DO $$     BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum
            WHERE enumlabel = 'READONLYGUEST'
            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'workspace_role' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${ns}'))
        ) THEN
            ALTER TYPE ${ns}.workspace_role ADD VALUE 'READONLYGUEST';
        END IF;
    END $$;
    `
      : `
    -- Add READONLYGUEST value to workspace_role enum (CockroachDB)
    ALTER TYPE ${ns}.workspace_role ADD VALUE IF NOT EXISTS 'READONLYGUEST';
    `

  return ['account_db_v10_add_readonly_role', addValueSql]
}

function getV10Migration2 (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  return [
    'account_db_v10_add_allow_guests_flag_to_workspace',
    `
    ALTER TABLE ${ns}.workspace
    ADD COLUMN IF NOT EXISTS allow_read_only_guest ${types.bool} NOT NULL DEFAULT FALSE;
    `
  ]
}

function getV11Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  return [
    'account_db_v11_add_pending_workspace_lock',
    `
    CREATE TABLE IF NOT EXISTS ${ns}._pending_workspace_lock (
      id ${types.int8} DEFAULT 1 PRIMARY KEY,
      CONSTRAINT single_row CHECK (id = 1)
    );

    INSERT INTO ${ns}._pending_workspace_lock (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `
  ]
}

function getV12Migration (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v12_update_account_events_fk',
    `
    -- Drop the existing foreign key constraint
    ALTER TABLE ${ns}.account_events
    DROP CONSTRAINT IF EXISTS account_events_account_fk;

    -- Add the new foreign key constraint referencing the person table
    ALTER TABLE ${ns}.account_events
    ADD CONSTRAINT account_events_person_fk FOREIGN KEY (account_uuid) REFERENCES ${ns}.person(uuid);
    `
  ]
}

function getV13Migration (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v13_update_workspace_fk_to_person',
    `
    -- Drop the existing foreign key constraints
    ALTER TABLE ${ns}.workspace
    DROP CONSTRAINT IF EXISTS workspace_created_by_fk,
    DROP CONSTRAINT IF EXISTS workspace_billing_account_fk;

    -- Add the new foreign key constraints referencing the person table
    ALTER TABLE ${ns}.workspace
    ADD CONSTRAINT workspace_created_by_person_fk
      FOREIGN KEY (created_by) REFERENCES ${ns}.person(uuid),
    ADD CONSTRAINT workspace_billing_account_person_fk
      FOREIGN KEY (billing_account) REFERENCES ${ns}.person(uuid);
    `
  ]
}

function getV14Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  return [
    'account_db_v14_add_allow_guest_signup_flag_to_workspace',
    `
    ALTER TABLE ${ns}.workspace
    ADD COLUMN IF NOT EXISTS allow_guest_sign_up ${types.bool} NOT NULL DEFAULT FALSE;
    `
  ]
}

function getV15Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  return [
    'account_db_v15_add_target_region_to_workspace_status',
    `
    ALTER TABLE ${ns}.workspace_status
    ADD COLUMN IF NOT EXISTS target_region ${types.string};
    `
  ]
}

function getV16Migration (ns: string, flavor: DBFlavor): [string, string] {
  // For PostgreSQL, we need to check if the value exists before adding it
  const addValueSql =
    flavor === 'postgres'
      ? `
    -- Add huly-assistant value to social_id_type enum (PostgreSQL)
    DO $$     BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum
            WHERE enumlabel = 'huly-assistant'
            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'social_id_type' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${ns}'))
        ) THEN
            ALTER TYPE ${ns}.social_id_type ADD VALUE 'huly-assistant';
        END IF;
    END $$;
    `
      : `
    -- Add huly-assistant value to social_id_type enum (CockroachDB)
    ALTER TYPE ${ns}.social_id_type ADD VALUE IF NOT EXISTS 'huly-assistant';
    `

  return ['account_db_v16_add_huly_assistant_social_id_type', addValueSql]
}

function getV17Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  return [
    'account_db_v17_create_user_profile_table',
    `
    /* ======= U S E R   P R O F I L E ======= */
    CREATE TABLE IF NOT EXISTS ${ns}.user_profile (
        person_uuid UUID NOT NULL,
        bio ${types.string},
        city ${types.string},
        country ${types.string},
        website ${types.string},
        social_links JSONB,
        is_public ${types.bool} NOT NULL DEFAULT FALSE,
        CONSTRAINT user_profile_pk PRIMARY KEY (person_uuid),
        CONSTRAINT user_profile_person_fk FOREIGN KEY (person_uuid) REFERENCES ${ns}.person(uuid) ON DELETE CASCADE
    );

    /* Remove city and country from the person table */
    ALTER TABLE ${ns}.person
      DROP COLUMN IF EXISTS city,
      DROP COLUMN IF EXISTS country;

    /* ======= I N D E X E S ======= */
    CREATE INDEX IF NOT EXISTS user_profile_is_public_idx ON ${ns}.user_profile (is_public) WHERE is_public = TRUE;
    `
  ]
}

function getV18Migration (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v18_populate_user_profiles',
    `
    /* ======= P O P U L A T E   U S E R   P R O F I L E S ======= */
    /* Create user_profile entries for all existing persons that don't have one */
    INSERT INTO ${ns}.user_profile (person_uuid, is_public)
    SELECT p.uuid, FALSE
    FROM ${ns}.account p
    WHERE NOT EXISTS (
      SELECT 1 FROM ${ns}.user_profile up WHERE up.person_uuid = p.uuid
    );
    `
  ]
}

function getV19Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]

  return [
    'account_db_v19_subscription_table',
    `
    /* ======= S U B S C R I P T I O N ======= */
    /* Provider-agnostic subscription information for workspaces */
    /* Managed by a billing service via payment provider webhooks (e.g. Polar.sh, Stripe) */
    /* Multiple active subscriptions allowed per workspace (tier + addons + support) */
    /* Historical subscriptions preserved with status: canceled/expired */

    CREATE TYPE ${ns}.subscription_status AS ENUM (
      'active',
      'trialing',
      'past_due',
      'canceled',
      'paused',
      'expired'
    );

    CREATE TABLE IF NOT EXISTS ${ns}.subscription (
        id ${types.string} NOT NULL DEFAULT gen_random_uuid()::TEXT,
        workspace_uuid UUID NOT NULL,
        account_uuid UUID NOT NULL, -- Account that paid for the subscription

        -- Provider details
        provider ${types.string} NOT NULL, -- Payment provider identifier (e.g. 'polar', 'stripe', 'manual')
        provider_subscription_id ${types.string} NOT NULL, -- External subscription ID from the provider
        provider_checkout_id ${types.string}, -- External checkout/session ID that created this subscription

        -- Subscription classification
        type ${types.string} NOT NULL DEFAULT 'tier', -- tier, support, etc.
        status ${ns}.subscription_status NOT NULL DEFAULT 'active',
        plan ${types.string} NOT NULL, -- Plan identifier (e.g. 'rare', 'epic', 'legendary', 'custom')

        -- Amount paid (in cents, e.g. 9999 = $99.99)
        -- Used primarily for pay-what-you-want/donation subscriptions to track actual payment
        amount ${types.int8},

        -- Billing period (optional)
        period_start BIGINT,
        period_end BIGINT,

        -- Trial information (optional)
        trial_end BIGINT,

        -- Cancellation info (optional)
        canceled_at BIGINT,
        will_cancel_at BIGINT, -- Scheduled cancellation date (cancel at period end)

        -- Provider-specific data (stored as JSONB for flexibility)
        -- e.g. customerExternalId, metadata, etc.
        provider_data JSONB,

        created_on BIGINT NOT NULL DEFAULT current_epoch_ms(),
        updated_on BIGINT NOT NULL DEFAULT current_epoch_ms(),

        CONSTRAINT subscription_pk PRIMARY KEY (id),
        CONSTRAINT subscription_provider_subscription_id_unique UNIQUE (provider, provider_subscription_id),
        CONSTRAINT subscription_workspace_fk FOREIGN KEY (workspace_uuid) REFERENCES ${ns}.workspace(uuid),
        CONSTRAINT subscription_account_fk FOREIGN KEY (account_uuid) REFERENCES ${ns}.account(uuid)
    );

    /* ======= I N D E X E S ======= */
    CREATE INDEX IF NOT EXISTS subscription_workspace_status_idx ON ${ns}.subscription (workspace_uuid, status);
    `
  ]
}

function getV20Migration (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v20_usage_info',
    `
    ALTER TABLE ${ns}.workspace_status
    ADD COLUMN IF NOT EXISTS usage_info JSONB;
    `
  ]
}

function getV21Migration (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v21_add_failed_login_attempts',
    `
    ALTER TABLE ${ns}.account
    ADD COLUMN IF NOT EXISTS failed_login_attempts SMALLINT DEFAULT 0;
    `
  ]
}

function getV22Migration (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v22_add_password_change_event_index',
    `
    CREATE INDEX IF NOT EXISTS account_events_account_uuid_event_type_time_idx
    ON ${ns}.account_events (account_uuid, event_type, time DESC);
    `
  ]
}

function getV23Migration (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v23_add_password_aging_rule_to_workspace',
    `
    ALTER TABLE ${ns}.workspace
    ADD COLUMN IF NOT EXISTS password_aging_rule INT8;
    `
  ]
}

function getV24Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]
  return [
    'account_db_v24_add_workspace_permissions_table',
    `
    /* ======= W O R K S P A C E   P E R M I S S I O N S ======= */
    CREATE TABLE IF NOT EXISTS ${ns}.workspace_permissions (
        workspace_uuid UUID NOT NULL,
        account_uuid UUID NOT NULL,
        permission ${types.string}  NOT NULL,
        created_on ${types.int8} NOT NULL DEFAULT current_epoch_ms(),
        CONSTRAINT workspace_permissions_pk PRIMARY KEY (workspace_uuid, account_uuid, permission),
        CONSTRAINT workspace_permissions_workspace_fk FOREIGN KEY (workspace_uuid) REFERENCES ${ns}.workspace(uuid),
        CONSTRAINT workspace_permissions_account_fk FOREIGN KEY (account_uuid) REFERENCES ${ns}.account(uuid)
    );

    CREATE INDEX IF NOT EXISTS workspace_permissions_account_idx
    ON ${ns}.workspace_permissions (account_uuid);

    CREATE INDEX IF NOT EXISTS workspace_permissions_permission_idx
    ON ${ns}.workspace_permissions (permission);
    `
  ]
}

function getV25Migration (ns: string, flavor: DBFlavor): [string, string] {
  // For PostgreSQL, we need to check if the value exists before adding it
  const addValueSql =
    flavor === 'postgres'
      ? `
    -- Add office value to social_id_type enum (PostgreSQL)
    DO $$     BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum
            WHERE enumlabel = 'office'
            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'social_id_type' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${ns}'))
        ) THEN
            ALTER TYPE ${ns}.social_id_type ADD VALUE 'office';
        END IF;
    END $$;
    `
      : `
    -- Add office value to social_id_type enum (CockroachDB)
    ALTER TYPE ${ns}.social_id_type ADD VALUE IF NOT EXISTS 'office';
    `

  return ['account_db_v25_add_office_social_id_type', addValueSql]
}

function getV26Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]
  return [
    'account_db_v26_create_short_links_table',
    `
    /* ======= S H O R T   L I N K S ======= */
    /* Short-link registry: maps a random short id to an arbitrary payload string */
    /* Currently used for guest meeting links, but applicable to any shareable URL */
    CREATE TABLE IF NOT EXISTS ${ns}.short_links (
        id           ${types.string}  NOT NULL,
        payload  ${types.string}  NOT NULL,
        workspace_id ${types.string}  NOT NULL,
        created_at   BIGINT          NOT NULL DEFAULT current_epoch_ms(),
        CONSTRAINT short_links_pk PRIMARY KEY (id)
    );

    /* ======= I N D E X E S ======= */
    CREATE INDEX IF NOT EXISTS short_links_workspace_idx ON ${ns}.short_links (workspace_id);
    CREATE INDEX IF NOT EXISTS short_links_created_at_idx ON ${ns}.short_links (created_at);
    `
  ]
}

function getV27Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]
  return [
    'account_db_v28_account_workspace_badge_status',
    `
    /* ======= A C C O U N T   W O R K S P A C E   B A D G E   S T A T U S ======= */
    CREATE TABLE IF NOT EXISTS ${ns}.account_workspace_badge_status (
        account_uuid UUID NOT NULL,
        workspace_uuid UUID NOT NULL,
        has_unread ${types.bool} NOT NULL DEFAULT FALSE,
        updated_on BIGINT NOT NULL DEFAULT current_epoch_ms(),
        CONSTRAINT account_workspace_badge_status_pk PRIMARY KEY (account_uuid, workspace_uuid),
        CONSTRAINT account_workspace_badge_status_membership_fk FOREIGN KEY (workspace_uuid, account_uuid) 
            REFERENCES ${ns}.workspace_members(workspace_uuid, account_uuid) ON DELETE CASCADE
    );
    `
  ]
}

function getV28Migration (ns: string, flavor: DBFlavor): [string, string] {
  return [
    'account_db_v28_subscription_limits',
    `
    /* Add limits column to subscription table for plan-limit snapshots */
    ALTER TABLE ${ns}.subscription
    ADD COLUMN IF NOT EXISTS limits JSONB;
    `
  ]
}

function getV29Migration (ns: string, flavor: DBFlavor): [string, string] {
  // Add 'readonly' value to subscription_status enum (grace period expired -> read-only access).
  const addValueSql =
    flavor === 'postgres'
      ? `
    DO $$     BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum
            WHERE enumlabel = 'readonly'
            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'subscription_status' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${ns}'))
        ) THEN
            ALTER TYPE ${ns}.subscription_status ADD VALUE 'readonly';
        END IF;
    END $$;
    `
      : `
    ALTER TYPE ${ns}.subscription_status ADD VALUE IF NOT EXISTS 'readonly';
    `

  return ['account_db_v29_subscription_status_readonly', addValueSql]
}

function getV30Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]
  return [
    'account_db_v30_payment_intent_table',
    `
    /* ======= P A Y M E N T   I N T E N T ======= */
    /* Atomic claim keyed by claim_key (INSERT ... ON CONFLICT DO NOTHING) across pods/replicas:
         renew:<sub>:<periodEnd>  — one charge per subscription period
         checkout:<ws>:<type>     — one pending checkout per (workspace, plan type)
       order_fingerprint ('plan:seats:period') is the exact order behind a checkout claim; a loser
       reuses the URL only on a match, else 409. No FK — a checkout claim has no subscription yet. */

    CREATE TABLE IF NOT EXISTS ${ns}.payment_intent (
        id ${types.string} NOT NULL DEFAULT gen_random_uuid()::TEXT,
        claim_key ${types.string} NOT NULL,
        provider ${types.string} NOT NULL,
        status ${types.string} NOT NULL DEFAULT 'pending', -- pending | charged | failed
        payment_id ${types.string}, -- provider charge id, set once the charge is issued
        payment_url ${types.string}, -- checkout URL, reused by repeat callers of the same order
        amount ${types.int8},
        heartbeat_at BIGINT, -- lease: refreshed ~1s while a live pod awaits the charge response
        subscription_id ${types.string}, -- set for renew claims; null for checkout claims
        workspace_uuid ${types.string}, -- set for checkout claims
        order_fingerprint ${types.string},

        created_on BIGINT NOT NULL DEFAULT current_epoch_ms(),
        updated_on BIGINT NOT NULL DEFAULT current_epoch_ms(),

        CONSTRAINT payment_intent_pk PRIMARY KEY (id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS payment_intent_claim_key_unique ON ${ns}.payment_intent (claim_key);
    CREATE INDEX IF NOT EXISTS payment_intent_payment_id_idx ON ${ns}.payment_intent (payment_id);
    `
  ]
}

function getV31Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]
  return [
    'account_db_v31_payment_operation_ledger',
    `
    /* ======= P A Y M E N T   O P E R A T I O N   L E D G E R ======= */
    /* Append-only audit trail of every payment operation (init charge, webhook result, recurrent
       charge, cancel, refund). Immutable — rows are inserted, never updated/deleted. raw holds the
       full provider payload for forensics/reconciliation. No FK: an init may precede the subscription.
       action_id groups every row a single user/system intent produced (e.g. a plan change =
       new charge + old subscription cancel + free activation), actor says who drove that row. */

    CREATE TABLE IF NOT EXISTS ${ns}.payment_operation (
        id ${types.string} NOT NULL DEFAULT gen_random_uuid()::TEXT,
        provider ${types.string} NOT NULL,
        operation ${types.string} NOT NULL, -- init_charge | webhook | charge_recurrent | cancel | refund | update
        status ${types.string}, -- provider/webhook status (CONFIRMED|REJECTED|...) or success/failed
        payment_id ${types.string}, -- provider charge id
        order_id ${types.string},
        subscription_id ${types.string},
        workspace_uuid ${types.string},
        account_uuid ${types.string}, -- who/what initiated (system for scheduler)
        action_id ${types.string}, -- correlates every row of one intent (purchase, plan change, renewal)
        actor ${types.string}, -- user | system | provider | admin
        amount ${types.int8}, -- minor units (kopecks)
        raw JSONB, -- full provider request/response/notification payload
        created_on BIGINT NOT NULL DEFAULT current_epoch_ms(),

        CONSTRAINT payment_operation_pk PRIMARY KEY (id)
    );

    CREATE INDEX IF NOT EXISTS payment_operation_workspace_idx ON ${ns}.payment_operation (workspace_uuid);
    CREATE INDEX IF NOT EXISTS payment_operation_payment_id_idx ON ${ns}.payment_operation (payment_id);
    CREATE INDEX IF NOT EXISTS payment_operation_created_idx ON ${ns}.payment_operation (created_on);
    CREATE INDEX IF NOT EXISTS payment_operation_action_idx ON ${ns}.payment_operation (action_id);
    `
  ]
}

function getV32Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]
  return [
    'account_db_v32_payment_intent_claim_key',
    `
    /* ======= P A Y M E N T   I N T E N T   R E A L I G N ======= */
    /* v30 shipped twice with different DDL: an early renew-only shape (subscription_id NOT NULL,
       UNIQUE (subscription_id, period_end), FK to subscription) and the current claim_key shape.
       Databases that applied the early one keep the identifier marked applied, so the newer DDL
       never runs and claimIntent fails with "column claim_key does not exist". Realign in place. */

    ALTER TABLE ${ns}.payment_intent DROP CONSTRAINT IF EXISTS payment_intent_subscription_fk;
    ${
      // cockroach refuses DROP CONSTRAINT for a UNIQUE; it wants the backing index dropped instead.
      flavor === 'cockroach'
        ? `DROP INDEX IF EXISTS ${ns}.payment_intent@payment_intent_sub_period_unique CASCADE;`
        : `ALTER TABLE ${ns}.payment_intent DROP CONSTRAINT IF EXISTS payment_intent_sub_period_unique;`
    }
    ALTER TABLE ${ns}.payment_intent ALTER COLUMN subscription_id DROP NOT NULL;

    ALTER TABLE ${ns}.payment_intent ADD COLUMN IF NOT EXISTS claim_key ${types.string};
    ALTER TABLE ${ns}.payment_intent ADD COLUMN IF NOT EXISTS payment_url ${types.string};
    ALTER TABLE ${ns}.payment_intent ADD COLUMN IF NOT EXISTS workspace_uuid ${types.string};
    ALTER TABLE ${ns}.payment_intent ADD COLUMN IF NOT EXISTS order_fingerprint ${types.string};

    /* period_end is old-schema only; add it (nullable) on the current shape so the backfill in v33
       is plain SQL — no DO block, which CockroachDB does not support. */
    ALTER TABLE ${ns}.payment_intent ADD COLUMN IF NOT EXISTS period_end BIGINT;
    ALTER TABLE ${ns}.payment_intent ALTER COLUMN period_end DROP NOT NULL;
    `
  ]
}

function getV33Migration (ns: string): [string, string] {
  return [
    'account_db_v33_payment_intent_claim_key_index',
    `
    /* Separate migration on purpose: cockroach backfills a freshly added column asynchronously and
       rejects an index build while that is in flight ("column is being backfilled"). Splitting lets
       v32's ADD COLUMN settle before the unique index below is created. */

    /* Rebuild the renew claim key from the old shape; a table already on the current shape has no
       such rows, so this is a no-op there. */
    UPDATE ${ns}.payment_intent
       SET claim_key = 'renew:' || subscription_id || ':' || period_end
     WHERE claim_key IS NULL AND subscription_id IS NOT NULL AND period_end IS NOT NULL;

    DELETE FROM ${ns}.payment_intent WHERE claim_key IS NULL;

    /* claim_key stays nullable: the unique index is what enforces the claim, and every insert sets
       it. SET NOT NULL on an existing column behaves differently across flavors. */
    CREATE UNIQUE INDEX IF NOT EXISTS payment_intent_claim_key_unique ON ${ns}.payment_intent (claim_key);
    CREATE INDEX IF NOT EXISTS payment_intent_payment_id_idx ON ${ns}.payment_intent (payment_id);
    `
  ]
}

function getV34Migration (ns: string): [string, string] {
  return [
    'account_db_v34_add_disabled_features_override',
    `
    ALTER TABLE ${ns}.workspace
    ADD COLUMN IF NOT EXISTS disabled_features_override TEXT[];
    `
  ]
}

function getV35Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]
  return [
    'account_db_v35_admin_action_log',
    `
    /* ======= A D M I N   A C T I O N   L O G ======= */
    /* No FK on actor/target on purpose: the log must outlive the rows it describes
       (account deletion, person purge), and targets may be workspaces or social ids. */
    CREATE TABLE IF NOT EXISTS ${ns}.admin_action (
        id ${types.string} NOT NULL DEFAULT gen_random_uuid()::TEXT,
        actor ${types.string} NOT NULL, -- admin account uuid from the token
        actor_email ${types.string},
        action ${types.string} NOT NULL,
        target ${types.string}, -- person/workspace uuid the action was applied to
        target_label ${types.string}, -- readable name/email/url, kept for deleted targets
        data JSONB,
        created_on BIGINT NOT NULL DEFAULT current_epoch_ms(),

        CONSTRAINT admin_action_pk PRIMARY KEY (id)
    );

    CREATE INDEX IF NOT EXISTS admin_action_created_idx ON ${ns}.admin_action (created_on);
    CREATE INDEX IF NOT EXISTS admin_action_target_idx ON ${ns}.admin_action (target);
    `
  ]
}

function getV36Migration (ns: string): [string, string] {
  return [
    'account_db_v36_person_phone_hint',
    `
    /* Existing phone social ids stay in place and are reused once SMS verification lands. */
    ALTER TABLE ${ns}.person ADD COLUMN IF NOT EXISTS phone_hint TEXT;
    `
  ]
}

function getV37Migration (ns: string): [string, string] {
  return [
    'account_db_v37_person_phone_hint_backfill',
    /* Separate migration on purpose: a multi-statement batch is parsed as a whole, so an UPDATE
       reading phone_hint next to the ADD COLUMN fails with "column does not exist". Same reason
       v33 was split off from v32. */
    `
    UPDATE ${ns}.person p
       SET phone_hint = s.value
      FROM (
        SELECT DISTINCT ON (person_uuid) person_uuid, value
          FROM ${ns}.social_id
         WHERE type = 'phone'
         ORDER BY person_uuid, created_on DESC
      ) s
     WHERE s.person_uuid = p.uuid AND p.phone_hint IS NULL;
    `
  ]
}

function getV38Migration (ns: string): [string, string] {
  return [
    'account_db_v38_subscription_provider_status_trial_end_idx',
    /* Trial expiry sweeps ask for (provider, status, trial_end <= now); without this the query
       scans every trialing row of the provider and filters by date in memory. */
    `
    CREATE INDEX IF NOT EXISTS subscription_provider_status_trial_end_idx
        ON ${ns}.subscription (provider, status, trial_end);
    `
  ]
}

function getV39Migration (ns: string, flavor: DBFlavor): [string, string] {
  const types = dbTypes[flavor]
  return [
    'account_db_v39_workspace_purchase',
    `
    /* ======= W O R K S P A C E   P U R C H A S E ======= */
    /* Generic one-time purchases of catalog SKUs (AI usage reset now; skins/themes later). History of
       what a workspace bought; account stays domain-agnostic — the SKU effect (e.g. resetting the AI
       usage window) is interpreted and applied by the owning pod (aibot), not here. Consumable purchases
       flip to 'consumed' once that pod applied the effect; entitlements (future) stay 'active'. */

    CREATE TABLE IF NOT EXISTS ${ns}.workspace_purchase (
        id ${types.string} NOT NULL DEFAULT gen_random_uuid()::TEXT,
        workspace_uuid ${types.string} NOT NULL,
        account_uuid ${types.string} NOT NULL, -- who bought
        sku ${types.string} NOT NULL,
        category ${types.string},
        status ${types.string} NOT NULL, -- pending | active | consumed | failed
        amount ${types.int8}, -- minor units (kopecks)
        payment_id ${types.string},
        provider ${types.string},
        raw JSONB,
        created_on BIGINT NOT NULL DEFAULT current_epoch_ms(),
        activated_on BIGINT,

        CONSTRAINT workspace_purchase_pk PRIMARY KEY (id)
    );

    CREATE INDEX IF NOT EXISTS workspace_purchase_workspace_idx ON ${ns}.workspace_purchase (workspace_uuid);
    CREATE INDEX IF NOT EXISTS workspace_purchase_payment_id_idx ON ${ns}.workspace_purchase (payment_id);
    `
  ]
}

function getV40Migration (ns: string): [string, string] {
  return [
    'account_db_v40_workspace_purchase_dedup',
    /* Separate migration on purpose: pre-dedup (DML) has to settle before the unique index (DDL) in
       v41 — see v32/v33 for why a schema change is kept out of the same migration as data changes. The
       payment pod dedups purchases by (payment_id, provider) with a racy SELECT-then-INSERT (no DB
       constraint backed it), so a real duplicate pair may already exist. Keep the oldest row per group. */
    `
    DELETE FROM ${ns}.workspace_purchase wp
     WHERE wp.payment_id IS NOT NULL
       AND wp.id NOT IN (
         SELECT DISTINCT ON (payment_id, provider) id
           FROM ${ns}.workspace_purchase
          WHERE payment_id IS NOT NULL
          ORDER BY payment_id, provider, created_on ASC, id ASC
       );
    `
  ]
}

function getV41Migration (ns: string): [string, string] {
  return [
    'account_db_v41_workspace_purchase_unique',
    /* Partial: payment_id is null for non-payment purchases, which must stay unconstrained. */
    `
    CREATE UNIQUE INDEX IF NOT EXISTS workspace_purchase_payment_provider_unique
      ON ${ns}.workspace_purchase (payment_id, provider) WHERE payment_id IS NOT NULL;
    `
  ]
}
