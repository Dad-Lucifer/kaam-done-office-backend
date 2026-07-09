'use strict';

const config = require('./src/config/env');
const app = require('./src/app');
const { ensureDynamoDBTable, ensureRolesTable, ensureTeamMembersTable, ensureChatTables, ensureVoiceChannelsTable, ensureTaskChannelsTable, ensureCategoriesTable, ensureAuditLogTable, ensureTaskManagerTable, ensureSubscriptionsTable, ensureAiHrChannelsTable, ensureAiChatTable, ensureAttendanceLogsTable } = require('./src/config/dbSetup');

const { initWebSocketServer } = require('./src/websocket/chatSocket');
const { initChatArchiver } = require('./src/cron/archiveChat');

const PORT = config.PORT;

async function startServer() {
  try {
    // 1. Ensure DynamoDB tables exist (creates them if not found)
    await ensureDynamoDBTable();
    await ensureRolesTable();
    await ensureTeamMembersTable();

    await ensureChatTables();
    await ensureVoiceChannelsTable();
    await ensureTaskChannelsTable();
    await ensureCategoriesTable();
    await ensureAuditLogTable();
    await ensureTaskManagerTable();
    await ensureSubscriptionsTable();
    await ensureAiHrChannelsTable();
    await ensureAiChatTable();
    await ensureAttendanceLogsTable();

    // 2. Start the HTTP server
    const server = app.listen(PORT, () => {
      console.log(`\n🚀 WorkNest API server running on http://localhost:${PORT}`);
      console.log(`   Environment : ${config.NODE_ENV}`);
      console.log(`   Region      : ${config.AWS_REGION}`);
      // console.log(`   Health Check: http://localhost:${PORT}/health\n`);
    });

    // 3. Attach WebSocket server
    initWebSocketServer(server);

    // 4. Start scheduled cron jobs
    initChatArchiver();
  } catch (error) {
    console.error('\n❌ Server failed to start:', error.message);
    console.error(error);
    process.exit(1);
  }
}

startServer();
