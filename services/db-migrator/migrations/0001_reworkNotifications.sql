ALTER TABLE notification_dnc
    ADD COLUMN IF NOT EXISTS "parentObjectId" text,
    ADD COLUMN IF NOT EXISTS "parentObjectClass" text,
    ADD COLUMN IF NOT EXISTS "objectSpace" text,
    ADD COLUMN IF NOT EXISTS "lastNotify" bigint,
    ADD COLUMN IF NOT EXISTS "unreadCount" integer;

UPDATE notification_dnc
SET "objectSpace" = COALESCE(data->>'objectSpace', '');

UPDATE notification_dnc
SET "lastNotify" = COALESCE((data->>'lastNotify')::bigint, 0);

UPDATE notification_dnc
SET "unreadCount" = 0;

ALTER TABLE notification_dnc
    ALTER COLUMN "objectSpace" SET NOT NULL;

ALTER TABLE notification_dnc
    ALTER COLUMN "lastNotify" SET NOT NULL;

ALTER TABLE notification_dnc
    ALTER COLUMN "unreadCount" SET NOT NULL;

ALTER TABLE notification_dnc
    ADD CHECK ("unreadCount" >= 0);

-- Unique index for consistency
CREATE UNIQUE INDEX IF NOT EXISTS notification_dnc_unique_workspaceId_user_objectId_objectClass__index
    ON notification_dnc ("workspaceId", "user", "objectId", "objectClass");

-- Index to search notification contexts by object ID
CREATE INDEX IF NOT EXISTS notification_dnc_workspaceId_objectId__index
    ON notification_dnc ("workspaceId", "objectId");

-- Index to search notification contexts by parent ID
CREATE INDEX IF NOT EXISTS notification_dnc_workspaceId_parentObjectId__index
    ON notification_dnc ("workspaceId", "parentObjectId");

-- Index to sort user's inbox by last notification time
CREATE INDEX IF NOT EXISTS notification_dnc_workspaceId_user_lastNotify_desc__index
    ON notification_dnc ("workspaceId", "user", "lastNotify" DESC);

-- Partial index to optimize user's total unread count calculation
CREATE INDEX IF NOT EXISTS notification_dnc_workspaceId_user_unread__index
    ON notification_dnc ("workspaceId", "user", "unreadCount")
    WHERE "unreadCount" > 0;

-- Index to filter it by class in inbox
CREATE INDEX IF NOT EXISTS notification_dnc_workspaceId_user_objectClass__index
    ON notification_dnc ("workspaceId", "user", "objectClass");

-- Add activity index
CREATE INDEX IF NOT EXISTS activity_attachedTo_createdOn__index ON activity ("workspaceId", "attachedTo", "createdOn" DESC);


-- Migration to add latestMessageId and latestMessageTimestamp to notification_read_state
ALTER TABLE notification_read_state
    ADD COLUMN IF NOT EXISTS "latestMessageId" text,
    ADD COLUMN IF NOT EXISTS "latestMessageTimestamp" bigint;

-- Indexes for the new columns including workspaceId
CREATE INDEX IF NOT EXISTS notification_read_state_workspaceId_latestMessageId__index
    ON notification_read_state ("workspaceId", "latestMessageId");

CREATE INDEX IF NOT EXISTS notification_read_state_workspaceId_latestMessageTimestamp__index
    ON notification_read_state ("workspaceId", "latestMessageTimestamp");