'use strict';

const express = require('express');
const cors = require('cors');
const config = require('./config/env');
const authRoutes = require('./routes/authRoutes');
const rolesRoutes = require('./routes/rolesRoutes');
const membersRoutes = require('./routes/membersRoutes');
const channelRoutes = require('./routes/channelRoutes');
const chatRoutes = require('./routes/chatRoutes');
const voiceRoutes = require('./routes/voiceRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const permissionsRoutes = require('./routes/permissionsRoutes');
const taskRoutes = require('./routes/taskRoutes');
const taskChannelRoutes = require('./routes/taskChannelRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const aiHrRoutes = require('./routes/aiHrRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const auditLogsRoutes = require('./routes/auditLogsRoutes');
const { startRecurringTaskEngine } = require('./cron/recurringTaskEngine');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// ---- CORS ----
app.use(
  cors({
    origin: config.CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// ---- Body Parsers ----
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ---- Health Check ----
// app.get('/health', (_req, res) => {
//   res.json({ status: 'ok', timestamp: new Date().toISOString() });
// });

// ---- API Routes ----
app.use('/api/auth', authRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/members', membersRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/task-channels', taskChannelRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/ai-hr', aiHrRoutes);
app.use('/api/audit-logs', auditLogsRoutes);


// ---- Start Cron Jobs ----
startRecurringTaskEngine();

// ---- 404 Handler ----
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.' });
});

// ---- Global Error Handler (must be last) ----
app.use(errorHandler);

module.exports = app;
