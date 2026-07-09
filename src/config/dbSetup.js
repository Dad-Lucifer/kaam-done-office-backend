'use strict';

const {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
} = require('@aws-sdk/client-dynamodb');
const config = require('./env');

// We need the raw DynamoDB client (not the Document client) to call CreateTable / DescribeTable
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const rawDynamoClient = new DynamoDBClient({
  region: config.AWS_REGION,
  credentials: {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  },
});

const TABLE_NAME = config.DYNAMODB_TABLE_NAME;

/**
 * Table schema definition.
 *
 * Primary Key (composite):
 *   PK  (String) — Partition Key  e.g. "USER#<uuid>"
 *   SK  (String) — Sort Key       e.g. "PROFILE"
 *
 * Global Secondary Index (GSI):
 *   email-index — allows efficient lookup of users by email
 *   Partition Key: email (String)
 */
const TABLE_DEFINITION = {
  TableName: TABLE_NAME,

  // Key schema
  KeySchema: [
    { AttributeName: 'PK', KeyType: 'HASH' },
    { AttributeName: 'SK', KeyType: 'RANGE' },
  ],

  // Attribute definitions (only indexed attributes need to be declared here)
  AttributeDefinitions: [
    { AttributeName: 'PK', AttributeType: 'S' },
    { AttributeName: 'SK', AttributeType: 'S' },
    { AttributeName: 'email', AttributeType: 'S' },
  ],

  // GSI — look up users by email without scanning
  GlobalSecondaryIndexes: [
    {
      IndexName: 'email-index',
      KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
    },
  ],

  // On-demand billing — no capacity planning required
  BillingMode: 'PAY_PER_REQUEST',
};

/**
 * Checks if the DynamoDB table already exists.
 * Returns true if active, false if not found.
 */
async function tableExists() {
  try {
    const response = await rawDynamoClient.send(
      new DescribeTableCommand({ TableName: TABLE_NAME })
    );
    const status = response.Table?.TableStatus;
    return status === 'ACTIVE' || status === 'UPDATING';
  } catch (error) {
    if (error instanceof ResourceNotFoundException || error.name === 'ResourceNotFoundException') {
      return false;
    }
    throw error;
  }
}

/**
 * Waits for the table to reach ACTIVE status (polls every 2 seconds).
 */
async function waitForTableActive(maxWaitMs = 60000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await rawDynamoClient.send(
        new DescribeTableCommand({ TableName: TABLE_NAME })
      );
      if (response.Table?.TableStatus === 'ACTIVE') {
        return true;
      }
    } catch {
      // Table not yet visible — continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Table "${TABLE_NAME}" did not become ACTIVE within ${maxWaitMs}ms`);
}

/**
 * Main function — called at server startup.
 * Creates the DynamoDB table if it does not yet exist.
 */
async function ensureDynamoDBTable() {
  console.log(`[DynamoDB] Checking table "${TABLE_NAME}" in region "${config.AWS_REGION}"…`);

  const exists = await tableExists();

  if (exists) {
    console.log(`[DynamoDB] ✅ Table "${TABLE_NAME}" already exists and is active.`);
    return;
  }

  console.log(`[DynamoDB] Table "${TABLE_NAME}" not found — creating…`);

  await rawDynamoClient.send(new CreateTableCommand(TABLE_DEFINITION));

  console.log(`[DynamoDB] ⏳ Waiting for table "${TABLE_NAME}" to become active…`);
  await waitForTableActive();

  console.log(`[DynamoDB] ✅ Table "${TABLE_NAME}" created successfully with:`);
  console.log(`            • Primary Key : PK (HASH) + SK (RANGE)`);
  console.log(`            • GSI         : email-index (email HASH)`);
  console.log(`            • Billing     : PAY_PER_REQUEST (On-Demand)`);
}

// ============================================================
//  ROLES TABLE
// ============================================================

const ROLES_TABLE_NAME = 'roles';

const ROLES_TABLE_DEFINITION = {
  TableName: ROLES_TABLE_NAME,

  KeySchema: [
    { AttributeName: 'PK', KeyType: 'HASH' },   // ADMIN#<adminUserId>
    { AttributeName: 'SK', KeyType: 'RANGE' },   // ROLE#<roleId>
  ],

  AttributeDefinitions: [
    { AttributeName: 'PK', AttributeType: 'S' },
    { AttributeName: 'SK', AttributeType: 'S' },
    { AttributeName: 'adminUserId', AttributeType: 'S' },
  ],

  // GSI — list all roles for a given admin
  GlobalSecondaryIndexes: [
    {
      IndexName: 'adminUserId-index',
      KeySchema: [{ AttributeName: 'adminUserId', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
    },
  ],

  BillingMode: 'PAY_PER_REQUEST',
};

async function rolesTableExists() {
  try {
    const response = await rawDynamoClient.send(
      new DescribeTableCommand({ TableName: ROLES_TABLE_NAME })
    );
    const status = response.Table?.TableStatus;
    return status === 'ACTIVE' || status === 'UPDATING';
  } catch (error) {
    if (error instanceof ResourceNotFoundException || error.name === 'ResourceNotFoundException') {
      return false;
    }
    throw error;
  }
}

async function waitForRolesTableActive(maxWaitMs = 60000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await rawDynamoClient.send(
        new DescribeTableCommand({ TableName: ROLES_TABLE_NAME })
      );
      if (response.Table?.TableStatus === 'ACTIVE') return true;
    } catch {
      // Not yet visible — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Table "${ROLES_TABLE_NAME}" did not become ACTIVE within ${maxWaitMs}ms`);
}

/**
 * Ensures the `roles` table exists. Called at server startup.
 */
async function ensureRolesTable() {
  console.log(`[DynamoDB] Checking table "${ROLES_TABLE_NAME}" in region "${config.AWS_REGION}"…`);

  const exists = await rolesTableExists();

  if (exists) {
    console.log(`[DynamoDB] ✅ Table "${ROLES_TABLE_NAME}" already exists and is active.`);
    return;
  }

  console.log(`[DynamoDB] Table "${ROLES_TABLE_NAME}" not found — creating…`);
  await rawDynamoClient.send(new CreateTableCommand(ROLES_TABLE_DEFINITION));

  console.log(`[DynamoDB] ⏳ Waiting for table "${ROLES_TABLE_NAME}" to become active…`);
  await waitForRolesTableActive();

  console.log(`[DynamoDB] ✅ Table "${ROLES_TABLE_NAME}" created successfully with:`);
  console.log(`            • Primary Key : PK (HASH) + SK (RANGE)`);
  console.log(`            • GSI         : adminUserId-index (adminUserId HASH)`);
  console.log(`            • Billing     : PAY_PER_REQUEST (On-Demand)`);
}

// ============================================================
//  TEAM-MEMBERS TABLE
// ============================================================

const TEAM_MEMBERS_TABLE_NAME = 'team-members';

const TEAM_MEMBERS_TABLE_DEFINITION = {
  TableName: TEAM_MEMBERS_TABLE_NAME,

  KeySchema: [
    { AttributeName: 'PK', KeyType: 'HASH' },   // ADMIN#<adminUserId>
    { AttributeName: 'SK', KeyType: 'RANGE' },   // MEMBER#<memberId>
  ],

  AttributeDefinitions: [
    { AttributeName: 'PK', AttributeType: 'S' },
    { AttributeName: 'SK', AttributeType: 'S' },
    { AttributeName: 'adminUserId', AttributeType: 'S' },
    { AttributeName: 'username', AttributeType: 'S' },
  ],

  // GSIs
  GlobalSecondaryIndexes: [
    {
      IndexName: 'adminUserId-members-index',
      KeySchema: [{ AttributeName: 'adminUserId', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
    },
    {
      IndexName: 'username-index',
      KeySchema: [{ AttributeName: 'username', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
    },
  ],

  BillingMode: 'PAY_PER_REQUEST',
};

async function teamMembersTableExists() {
  try {
    const response = await rawDynamoClient.send(
      new DescribeTableCommand({ TableName: TEAM_MEMBERS_TABLE_NAME })
    );
    const status = response.Table?.TableStatus;
    return status === 'ACTIVE' || status === 'UPDATING';
  } catch (error) {
    if (error instanceof ResourceNotFoundException || error.name === 'ResourceNotFoundException') {
      return false;
    }
    throw error;
  }
}

async function waitForTeamMembersTableActive(maxWaitMs = 60000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await rawDynamoClient.send(
        new DescribeTableCommand({ TableName: TEAM_MEMBERS_TABLE_NAME })
      );
      if (response.Table?.TableStatus === 'ACTIVE') return true;
    } catch {
      // Not yet visible — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Table "${TEAM_MEMBERS_TABLE_NAME}" did not become ACTIVE within ${maxWaitMs}ms`);
}

/**
 * Ensures the `team-members` table exists. Called at server startup.
 */
async function ensureTeamMembersTable() {
  console.log(`[DynamoDB] Checking table "${TEAM_MEMBERS_TABLE_NAME}" in region "${config.AWS_REGION}"…`);

  const exists = await teamMembersTableExists();

  if (exists) {
    console.log(`[DynamoDB] ✅ Table "${TEAM_MEMBERS_TABLE_NAME}" already exists and is active.`);
    return;
  }

  console.log(`[DynamoDB] Table "${TEAM_MEMBERS_TABLE_NAME}" not found — creating…`);
  await rawDynamoClient.send(new CreateTableCommand(TEAM_MEMBERS_TABLE_DEFINITION));

  console.log(`[DynamoDB] ⏳ Waiting for table "${TEAM_MEMBERS_TABLE_NAME}" to become active…`);
  await waitForTeamMembersTableActive();

  console.log(`[DynamoDB] ✅ Table "${TEAM_MEMBERS_TABLE_NAME}" created successfully with:`);
  console.log(`            • Primary Key : PK (HASH) + SK (RANGE)`);
  console.log(`            • GSI         : adminUserId-members-index (adminUserId HASH)`);
  console.log(`            • Billing     : PAY_PER_REQUEST (On-Demand)`);
}

// ============================================================
//  CHAT TABLES (DynamoDB)
// ============================================================

const TEXT_CHANNELS_TABLE = 'text-channels';
const CHAT_MESSAGES_TABLE = 'chat-messages';
const CHAT_CONNECTIONS_TABLE = 'chat-connections';
const CHAT_REACTIONS_TABLE = 'chat-reactions';

async function genericTableExists(tableName) {
  try {
    const response = await rawDynamoClient.send(new DescribeTableCommand({ TableName: tableName }));
    const status = response.Table?.TableStatus;
    return status === 'ACTIVE' || status === 'UPDATING';
  } catch (error) {
    if (error instanceof ResourceNotFoundException || error.name === 'ResourceNotFoundException') return false;
    throw error;
  }
}

async function createGenericTable(definition) {
  const exists = await genericTableExists(definition.TableName);
  if (exists) {
    console.log(`[DynamoDB] ✅ Table "${definition.TableName}" already exists.`);
    return;
  }
  console.log(`[DynamoDB] Creating table "${definition.TableName}"…`);
  await rawDynamoClient.send(new CreateTableCommand(definition));
}

async function ensureChatTables() {
  await createGenericTable({
    TableName: TEXT_CHANNELS_TABLE,
    KeySchema: [{ AttributeName: 'roomId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'roomId', AttributeType: 'S' },
      { AttributeName: 'adminUserId', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'adminUserId-index',
        KeySchema: [{ AttributeName: 'adminUserId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });

  await createGenericTable({
    TableName: CHAT_MESSAGES_TABLE,
    KeySchema: [
      { AttributeName: 'roomId', KeyType: 'HASH' },
      { AttributeName: 'timestamp', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'roomId', AttributeType: 'S' },
      { AttributeName: 'timestamp', AttributeType: 'S' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });

  // Enable TTL for chat-messages
  try {
    await rawDynamoClient.send(new UpdateTimeToLiveCommand({
      TableName: CHAT_MESSAGES_TABLE,
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      }
    }));
    console.log(`[DynamoDB] ✅ TTL enabled for table "${CHAT_MESSAGES_TABLE}" on attribute "ttl".`);
  } catch (error) {
    if (error.name !== 'ValidationException' || !error.message.includes('already enabled')) {
      console.error(`[DynamoDB] ⚠️ Failed to enable TTL for table "${CHAT_MESSAGES_TABLE}":`, error.message);
    }
  }

  await createGenericTable({
    TableName: CHAT_CONNECTIONS_TABLE,
    KeySchema: [{ AttributeName: 'connectionId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'connectionId', AttributeType: 'S' },
      { AttributeName: 'roomId', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'roomId-index',
        KeySchema: [{ AttributeName: 'roomId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });

  await createGenericTable({
    TableName: CHAT_REACTIONS_TABLE,
    KeySchema: [
      { AttributeName: 'messageId', KeyType: 'HASH' },
      { AttributeName: 'userId', KeyType: 'RANGE' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'messageId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
}

// ============================================================
//  VOICE CHANNELS TABLE
// ============================================================

const VOICE_CHANNELS_TABLE = 'voice-channels';

/**
 * Ensures the `voice-channels` DynamoDB table exists.
 * Schema mirrors `text-channels`:
 *   PK  : roomId      (String, UUID) — partition key
 *   GSI : adminUserId-index          — list all channels per admin
 */
async function ensureVoiceChannelsTable() {
  await createGenericTable({
    TableName: VOICE_CHANNELS_TABLE,
    KeySchema: [{ AttributeName: 'roomId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'roomId', AttributeType: 'S' },
      { AttributeName: 'adminUserId', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'adminUserId-index',
        KeySchema: [{ AttributeName: 'adminUserId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
  console.log(`[DynamoDB] ✅ Table "${VOICE_CHANNELS_TABLE}" ready.`);
}

// ============================================================
//  TASK CHANNELS TABLE
// ============================================================

const TASK_CHANNELS_TABLE = 'task-channels';

/**
 * Ensures the `task-channels` DynamoDB table exists.
 * Schema mirrors `text-channels`:
 *   PK  : roomId      (String, UUID) — partition key
 *   GSI : adminUserId-index          — list all channels per admin
 */
async function ensureTaskChannelsTable() {
  await createGenericTable({
    TableName: TASK_CHANNELS_TABLE,
    KeySchema: [{ AttributeName: 'roomId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'roomId', AttributeType: 'S' },
      { AttributeName: 'adminUserId', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'adminUserId-index',
        KeySchema: [{ AttributeName: 'adminUserId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
  console.log(`[DynamoDB] ✅ Table "${TASK_CHANNELS_TABLE}" ready.`);
}

// ============================================================
//  AI-HR CHANNELS TABLE
// ============================================================

const AI_HR_CHANNELS_TABLE = 'AI-HR-channel';

/**
 * Ensures the `AI-HR-channel` DynamoDB table exists.
 * Schema mirrors `text-channels`:
 *   PK  : roomId      (String, UUID) — partition key
 *   GSI : adminUserId-index          — list all channels per admin
 */
async function ensureAiHrChannelsTable() {
  await createGenericTable({
    TableName: AI_HR_CHANNELS_TABLE,
    KeySchema: [{ AttributeName: 'roomId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'roomId', AttributeType: 'S' },
      { AttributeName: 'adminUserId', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'adminUserId-index',
        KeySchema: [{ AttributeName: 'adminUserId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
  console.log(`[DynamoDB] ✅ Table "${AI_HR_CHANNELS_TABLE}" ready.`);
}

// ============================================================
//  AI CHAT TABLE
// ============================================================

const AI_CHAT_TABLE = 'AI-chat';

/**
 * Ensures the `AI-chat` DynamoDB table exists for storing history.
 * Schema:
 *   PK  : roomId      (String, UUID) — partition key
 *   SK  : timestamp   (String, ISO)  — sort key for chronological order
 */
async function ensureAiChatTable() {
  await createGenericTable({
    TableName: AI_CHAT_TABLE,
    KeySchema: [
      { AttributeName: 'roomId', KeyType: 'HASH' },
      { AttributeName: 'timestamp', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'roomId', AttributeType: 'S' },
      { AttributeName: 'timestamp', AttributeType: 'S' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
  console.log(`[DynamoDB] ✅ Table "${AI_CHAT_TABLE}" ready.`);
}

// ============================================================
//  CATEGORIES TABLE
// ============================================================

const CATEGORIES_TABLE = 'categories';

/**
 * Ensures the `categories` DynamoDB table exists.
 * Schema:
 *   PK  : categoryId   (String, UUID) — partition key
 *   GSI : adminUserId-index           — list all categories per admin
 */
async function ensureCategoriesTable() {
  await createGenericTable({
    TableName: CATEGORIES_TABLE,
    KeySchema: [{ AttributeName: 'categoryId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'categoryId', AttributeType: 'S' },
      { AttributeName: 'adminUserId', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'adminUserId-index',
        KeySchema: [{ AttributeName: 'adminUserId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
  console.log(`[DynamoDB] ✅ Table "${CATEGORIES_TABLE}" ready.`);
}

// ============================================================
//  PERMISSION AUDIT LOGS TABLE
// ============================================================

const AUDIT_LOG_TABLE = 'permission-audit-logs';

/**
 * Ensures the `permission-audit-logs` table exists.
 * Schema:
 *   PK  : WORKSPACE#<adminUserId>  (String) — partition key
 *   SK  : LOG#<ISO8601>#<logId>    (String) — sort key (sortable by time)
 *   GSI : actorId-index — list all logs by a specific actor
 */
async function ensureAuditLogTable() {
  await createGenericTable({
    TableName: AUDIT_LOG_TABLE,
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'PK',        AttributeType: 'S' },
      { AttributeName: 'SK',        AttributeType: 'S' },
      { AttributeName: 'actorId',   AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'actorId-index',
        KeySchema: [
          { AttributeName: 'actorId',   KeyType: 'HASH'  },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });

  // Enable TTL so old log entries are automatically purged after 90 days
  try {
    await rawDynamoClient.send(new UpdateTimeToLiveCommand({
      TableName: AUDIT_LOG_TABLE,
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    }));
    console.log(`[DynamoDB] ✅ TTL enabled for table "${AUDIT_LOG_TABLE}" on attribute "ttl".`);
  } catch (error) {
    if (error.name !== 'ValidationException' || !error.message.includes('already enabled')) {
      console.error(`[DynamoDB] ⚠️ Failed to enable TTL for "${AUDIT_LOG_TABLE}":`, error.message);
    }
  }

  console.log(`[DynamoDB] ✅ Table "${AUDIT_LOG_TABLE}" ready.`);
}

// ============================================================
//  ASSIGNED TASK TABLE
// ============================================================

const TASK_MANAGER_TABLE = 'assigned-task';

/**
 * Ensures the `assigned-task` DynamoDB table exists.
 * Schema:
 *   PK  : WORKSPACE#<adminUserId>  (String) — partition key
 *   SK  : TASK#<taskId>            (String) — sort key
 *
 * GSIs:
 *   workspaceId-status-index    — filter tasks by status per workspace
 *   workspaceId-dueDate-index   — sort by dueDate, find overdue tasks
 *   workspaceId-assignee-index  — tasks assigned to a user/role key
 *   workspaceId-createdAt-index — chronological listing
 */
async function ensureTaskManagerTable() {
  await createGenericTable({
    TableName: TASK_MANAGER_TABLE,
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'PK',          AttributeType: 'S' },
      { AttributeName: 'SK',          AttributeType: 'S' },
      { AttributeName: 'workspaceId', AttributeType: 'S' },
      { AttributeName: 'status',      AttributeType: 'S' },
      { AttributeName: 'dueDate',     AttributeType: 'S' },
      { AttributeName: 'assigneeKey', AttributeType: 'S' },
      { AttributeName: 'createdAt',   AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'workspaceId-status-index',
        KeySchema: [
          { AttributeName: 'workspaceId', KeyType: 'HASH'  },
          { AttributeName: 'status',      KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'workspaceId-dueDate-index',
        KeySchema: [
          { AttributeName: 'workspaceId', KeyType: 'HASH'  },
          { AttributeName: 'dueDate',     KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'workspaceId-assignee-index',
        KeySchema: [
          { AttributeName: 'workspaceId', KeyType: 'HASH'  },
          { AttributeName: 'assigneeKey', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'workspaceId-createdAt-index',
        KeySchema: [
          { AttributeName: 'workspaceId', KeyType: 'HASH'  },
          { AttributeName: 'createdAt',   KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
  console.log(`[DynamoDB] ✅ Table "${TASK_MANAGER_TABLE}" ready.`);
}

// ============================================================
//  SUBSCRIPTIONS TABLE
// ============================================================

const SUBSCRIPTIONS_TABLE = 'subscriptions';

async function ensureSubscriptionsTable() {
  await createGenericTable({
    TableName: SUBSCRIPTIONS_TABLE,

    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH'  }, // WORKSPACE#<adminUserId>
      { AttributeName: 'SK', KeyType: 'RANGE' }, // SUBSCRIPTION#<subscriptionId>
    ],

    AttributeDefinitions: [
      { AttributeName: 'PK',          AttributeType: 'S' },
      { AttributeName: 'SK',          AttributeType: 'S' },
      { AttributeName: 'workspaceId', AttributeType: 'S' },
      { AttributeName: 'status',      AttributeType: 'S' },
    ],

    GlobalSecondaryIndexes: [
      {
        IndexName: 'workspaceId-index',
        KeySchema: [{ AttributeName: 'workspaceId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        // Allows querying all active/expired subs across all workspaces (admin monitoring)
        IndexName: 'status-index',
        KeySchema: [
          { AttributeName: 'status',      KeyType: 'HASH'  },
          { AttributeName: 'workspaceId', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],

    BillingMode: 'PAY_PER_REQUEST',
  });
  console.log(`[DynamoDB] ✅ Table "${SUBSCRIPTIONS_TABLE}" ready.`);
}

// ============================================================
//  ATTENDANCE LOGS TABLE
// ============================================================

const ATTENDANCE_LOGS_TABLE = 'attendance-logs';

/**
 * Ensures the `attendance-logs` DynamoDB table exists.
 *
 * Primary Key (composite):
 *   PK  : ADMIN#<adminUserId>           — workspace partition
 *   SK  : SESSION#<memberId>#<ISO8601>  — unique per session, time-sortable
 *
 * Global Secondary Indexes:
 *   adminUserId-date-index  — list all sessions for a workspace on a given date
 *   memberId-date-index     — all sessions for a single member by date
 *
 * Attributes stored per item:
 *   logId, adminUserId, memberId, username
 *   loginAt, logoutAt, dayOfWeek, date
 *   workingHoursMs, workingHours, ttl
 */
async function ensureAttendanceLogsTable() {
  await createGenericTable({
    TableName: ATTENDANCE_LOGS_TABLE,
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH'  },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'PK',           AttributeType: 'S' },
      { AttributeName: 'SK',           AttributeType: 'S' },
      { AttributeName: 'adminUserId',  AttributeType: 'S' },
      { AttributeName: 'date',         AttributeType: 'S' },
      { AttributeName: 'memberId',     AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'adminUserId-date-index',
        KeySchema: [
          { AttributeName: 'adminUserId', KeyType: 'HASH'  },
          { AttributeName: 'date',        KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'memberId-date-index',
        KeySchema: [
          { AttributeName: 'memberId', KeyType: 'HASH'  },
          { AttributeName: 'date',     KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });

  // Enable 1-year TTL for automatic purge
  try {
    await rawDynamoClient.send(new UpdateTimeToLiveCommand({
      TableName: ATTENDANCE_LOGS_TABLE,
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    }));
    console.log(`[DynamoDB] ✅ TTL enabled for table "${ATTENDANCE_LOGS_TABLE}" on attribute "ttl".`);
  } catch (error) {
    if (error.name !== 'ValidationException' || !error.message.includes('already enabled')) {
      console.error(`[DynamoDB] ⚠️ Failed to enable TTL for "${ATTENDANCE_LOGS_TABLE}":`, error.message);
    }
  }

  console.log(`[DynamoDB] ✅ Table "${ATTENDANCE_LOGS_TABLE}" ready.`);
}

module.exports = {
  ensureDynamoDBTable,
  ensureRolesTable,
  ROLES_TABLE_NAME,
  ensureTeamMembersTable,
  TEAM_MEMBERS_TABLE_NAME,
  ensureChatTables,
  TEXT_CHANNELS_TABLE,
  CHAT_MESSAGES_TABLE,
  CHAT_CONNECTIONS_TABLE,
  CHAT_REACTIONS_TABLE,
  ensureVoiceChannelsTable,
  VOICE_CHANNELS_TABLE,
  ensureCategoriesTable,
  CATEGORIES_TABLE,
  ensureTaskChannelsTable,
  TASK_CHANNELS_TABLE,
  ensureAuditLogTable,
  AUDIT_LOG_TABLE,
  ensureTaskManagerTable,
  TASK_MANAGER_TABLE,
  ensureSubscriptionsTable,
  SUBSCRIPTIONS_TABLE,
  ensureAiHrChannelsTable,
  AI_HR_CHANNELS_TABLE,
  ensureAiChatTable,
  AI_CHAT_TABLE,
  ensureAttendanceLogsTable,
  ATTENDANCE_LOGS_TABLE,
};
