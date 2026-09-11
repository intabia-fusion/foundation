import { DOMAIN_COLLABORATOR, DOMAIN_MODEL_TX, DOMAIN_RELATION, DOMAIN_SPACE, DOMAIN_TX } from '@hcengineering/core'

export type DataType = 'bigint' | 'bool' | 'text' | 'text[]' | 'integer'

export function getIndex (field: FieldSchema): string {
  if (field.indexType === undefined || field.indexType === 'btree') {
    return ''
  }
  return ` USING ${field.indexType}`
}

export interface FieldSchema {
  type: DataType
  notNull: boolean
  index: boolean
  indexType?: 'btree' | 'gin' | 'gist' | 'brin' | 'hash'
  check?: string
}

export type Schema = Record<string, FieldSchema>

const baseSchema: Schema = {
  _id: {
    type: 'text',
    notNull: true,
    index: false
  },
  _class: {
    type: 'text',
    notNull: true,
    index: true
  },
  space: {
    type: 'text',
    notNull: true,
    index: true
  },
  modifiedBy: {
    type: 'text',
    notNull: true,
    index: false
  },
  createdBy: {
    type: 'text',
    notNull: false,
    index: false
  },
  modifiedOn: {
    type: 'bigint',
    notNull: true,
    index: false
  },
  createdOn: {
    type: 'bigint',
    notNull: false,
    index: false
  },
  '%hash%': {
    type: 'text',
    notNull: false,
    index: false
  }
}

const defaultSchema: Schema = {
  ...baseSchema,
  attachedTo: {
    type: 'text',
    notNull: false,
    index: true
  }
}

const collaboratorSchema: Schema = {
  ...baseSchema,
  attachedTo: {
    type: 'text',
    notNull: true,
    index: true
  },
  attachedToClass: {
    type: 'text',
    notNull: true,
    index: true
  },
  collaborator: {
    type: 'text',
    notNull: true,
    index: true
  }
}

const chatSchema: Schema = {
  ...baseSchema,
  attachedTo: {
    type: 'text',
    notNull: true,
    index: true
  },
  attachedToClass: {
    type: 'text',
    notNull: true,
    index: true
  },
  account: {
    type: 'text',
    notNull: true,
    index: true
  },
  pinned: {
    type: 'bool',
    notNull: true,
    index: true
  },
  hidden: {
    type: 'bool',
    notNull: true,
    index: true
  }
}

const attachmentSchema: Schema = {
  ...baseSchema,
  attachedTo: {
    type: 'text',
    notNull: true,
    index: true
  },
  attachedToClass: {
    type: 'text',
    notNull: true,
    index: true
  },
  size: {
    type: 'bigint',
    notNull: true,
    index: true
  },
  type: {
    type: 'text',
    notNull: true,
    index: true
  },
  file: {
    type: 'text',
    notNull: true,
    index: true
  }
}

const spaceSchema: Schema = {
  ...baseSchema,
  private: {
    type: 'bool',
    notNull: true,
    index: true
  },
  members: {
    type: 'text[]',
    notNull: true,
    index: true,
    indexType: 'gin'
  },
  archived: {
    type: 'bool',
    notNull: true,
    index: true
  },
  referenceId: {
    type: 'text',
    notNull: false,
    index: true
  }
}

const relationSchema: Schema = {
  ...baseSchema,
  docA: {
    type: 'text',
    notNull: true,
    index: true
  },
  docB: {
    type: 'text',
    notNull: true,
    index: true
  },
  association: {
    type: 'text',
    notNull: true,
    index: true
  }
}

const txSchema: Schema = {
  ...defaultSchema,
  objectSpace: {
    type: 'text',
    notNull: true,
    index: true
  },
  objectId: {
    type: 'text',
    notNull: false,
    index: false
  }
}

const notificationSchema: Schema = {
  ...baseSchema,
  lastView: {
    type: 'bigint',
    notNull: false,
    index: false
  },
  lastUpdate: {
    type: 'bigint',
    notNull: false,
    index: true
  },
  lastNotify: {
    type: 'bigint',
    notNull: false,
    index: false
  },
  lastNotifiedMessage: {
    type: 'bigint',
    notNull: false,
    index: false
  },
  isViewed: {
    type: 'bool',
    notNull: true,
    index: true
  },
  archived: {
    type: 'bool',
    notNull: true,
    index: true
  },
  user: {
    type: 'text',
    notNull: true,
    index: true
  }
}

const dncSchema: Schema = {
  ...baseSchema,
  objectId: {
    type: 'text',
    notNull: true,
    index: true
  },
  objectClass: {
    type: 'text',
    notNull: true,
    index: false
  },
  objectSpace: {
    type: 'text',
    notNull: true,
    index: false
  },
  parentObjectId: {
    type: 'text',
    notNull: false,
    index: true
  },
  parentObjectClass: {
    type: 'text',
    notNull: false,
    index: false
  },
  lastNotify: {
    type: 'bigint',
    notNull: true,
    index: true
  },
  unreadCount: {
    type: 'integer',
    notNull: true,
    index: true,
    check: '"unreadCount" >= 0'
  },
  user: {
    type: 'text',
    notNull: true,
    index: true
  }
}

const userNotificationSchema: Schema = {
  ...baseSchema,
  user: {
    type: 'text',
    notNull: true,
    index: true
  }
}

const timeSchema: Schema = {
  ...baseSchema,
  workslots: {
    type: 'bigint',
    notNull: false,
    index: true
  },
  doneOn: {
    type: 'bigint',
    notNull: false,
    index: true
  },
  user: {
    type: 'text',
    notNull: true,
    index: true
  },
  rank: {
    type: 'text',
    notNull: true,
    index: false
  }
}

const calendarSchema: Schema = {
  ...baseSchema,
  hidden: {
    type: 'bool',
    notNull: true,
    index: true
  }
}

const eventSchema: Schema = {
  ...defaultSchema,
  calendar: {
    type: 'text',
    notNull: true,
    index: true
  },
  date: {
    type: 'bigint',
    notNull: true,
    index: true
  },
  dueDate: {
    type: 'bigint',
    notNull: true,
    index: true
  },
  participants: {
    type: 'text[]',
    notNull: true,
    index: true
  }
}

const docSyncInfo: Schema = {
  ...baseSchema,
  needSync: {
    type: 'text',
    notNull: false,
    index: false
  },
  externalVersion: {
    type: 'text',
    notNull: false,
    index: false
  },
  repository: {
    type: 'text',
    notNull: false,
    index: false
  },
  url: {
    type: 'text',
    notNull: false,
    index: false
  },
  parent: {
    type: 'text',
    notNull: false,
    index: false
  },
  objectClass: {
    type: 'text',
    notNull: false,
    index: false
  },
  deleted: {
    type: 'bool',
    notNull: false,
    index: false
  }
}

const githubLogin: Schema = {
  ...baseSchema,
  login: {
    type: 'text',
    notNull: true,
    index: true
  }
}

const docReadStateSchema: Schema = {
  ...defaultSchema,
  attachedToClass: {
    type: 'text',
    notNull: true,
    index: true
  },
  latestMessageId: {
    type: 'text',
    notNull: false,
    index: true
  },
  latestMessageTimestamp: {
    type: 'bigint',
    notNull: false,
    index: true
  }
}

const activitySchema: Schema = {
  ...defaultSchema,
  forwardedMessage: {
    type: 'text',
    notNull: false,
    index: true
  },
  forwardFromId: {
    type: 'text',
    notNull: false,
    index: true
  },
  forwardFromClass: {
    type: 'text',
    notNull: false,
    index: true
  }
}

type CustomIndexType = 'unique' | 'custom'

export const customIndexes: Record<string, Record<CustomIndexType, string[]>[]> = {
  [translateDomain('chunter_doc')]: [
    {
      unique: ['attachedTo', 'attachedToClass', 'account'],
      custom: []
    }
  ],
  [translateDomain('notification_read_state')]: [
    {
      unique: ['attachedTo', 'attachedToClass'],
      custom: []
    }
  ],
  [translateDomain('notification-dnc')]: [
    {
      unique: ['user', 'objectId', 'objectClass'],
      custom: []
    }
  ],
  [DOMAIN_SPACE]: [
    {
      unique: [],
      custom: [
        'CREATE UNIQUE INDEX IF NOT EXISTS space_unique_workspaceId_referenceId__index ON space ("workspaceId", "referenceId") WHERE "referenceId" IS NOT NULL;'
      ]
    }
  ],
  [translateDomain('activity')]: [
    {
      unique: [],
      custom: [
        'CREATE INDEX IF NOT EXISTS activity_attachedTo_createdOn__index ON activity ("workspaceId", "attachedTo", "createdOn" DESC);'
      ]
    }
  ]
}

export function addSchema (domain: string, schema: Schema): void {
  domainSchemas[translateDomain(domain)] = schema
  domainSchemaFields.set(domain, createSchemaFields(schema))
}

export function translateDomain (domain: string): string {
  return domain.replaceAll('-', '_')
}

export const domainSchemas: Record<string, Schema> = {
  [DOMAIN_SPACE]: spaceSchema,
  [DOMAIN_TX]: txSchema,
  [DOMAIN_MODEL_TX]: txSchema,
  [translateDomain('time')]: timeSchema,
  [translateDomain('calendar')]: calendarSchema,
  [translateDomain('event')]: eventSchema,
  notification: notificationSchema,
  [translateDomain('notification-dnc')]: dncSchema,
  [translateDomain('notification-user')]: userNotificationSchema,
  [translateDomain('github_sync')]: docSyncInfo,
  [translateDomain('github_user')]: githubLogin,
  [DOMAIN_RELATION]: relationSchema,
  [DOMAIN_COLLABORATOR]: collaboratorSchema,
  [translateDomain('chunter_doc')]: chatSchema,
  kanban: defaultSchema,
  [translateDomain('attachment')]: attachmentSchema,
  [translateDomain('notification_read_state')]: docReadStateSchema,
  [translateDomain('activity')]: activitySchema
}

export function getSchema (domain: string): Schema {
  return domainSchemas[translateDomain(domain)] ?? defaultSchema
}

export function getDocFieldsByDomains (domain: string): string[] {
  const schema = domainSchemas[translateDomain(domain)] ?? defaultSchema
  return Object.keys(schema)
}

export interface SchemaAndFields {
  schema: Schema

  fields: string[]
  domainFields: Set<string>
}

function createSchemaFields (schema: Schema): SchemaAndFields {
  const fields = Object.keys(schema)
  const domainFields = new Set(Object.keys(schema))
  return { schema, fields, domainFields }
}

const defaultSchemaFields: SchemaAndFields = createSchemaFields(defaultSchema)

const domainSchemaFields = new Map<string, SchemaAndFields>()
for (const [domain, _schema] of Object.entries(domainSchemas)) {
  domainSchemaFields.set(domain, createSchemaFields(_schema))
}

export function getSchemaAndFields (domain: string): SchemaAndFields {
  return domainSchemaFields.get(translateDomain(domain)) ?? defaultSchemaFields
}
