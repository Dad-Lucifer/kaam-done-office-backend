'use strict';

const { WebSocketServer } = require('ws');
const { PutCommand, DeleteCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');
const { dynamoDbClient } = require('../config/awsConfig');

// dynamoDbClient is already a DynamoDBDocumentClient from awsConfig with proper credentials
const dynamoDb = dynamoDbClient;

const CHAT_MESSAGES_TABLE = 'chat-messages';
const CHAT_CONNECTIONS_TABLE = 'chat-connections';
const CHAT_REACTIONS_TABLE = 'chat-reactions';

// In-memory mappings for fast broadcasting
// roomId -> Set of ws clients
const roomClients = new Map();

function broadcastToRoom(roomId, messageObj) {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  const msgString = JSON.stringify(messageObj);
  for (const clientWs of clients) {
    if (clientWs.readyState === 1) { // OPEN
      clientWs.send(msgString);
    }
  }
}

function initWebSocketServer(server) {
  const wss = new WebSocketServer({ server });

  console.log(`[WebSocket] Server initialized and attached to HTTP server.`);

  wss.on('connection', async (ws) => {
    ws.connectionId = uuidv4();
    ws.currentRoom = null;
    ws.userId = null; // Can be set via authentication later if needed

    console.log(`[WebSocket] Client connected: ${ws.connectionId}`);

    // Save connection to DynamoDB
    await dynamoDb.send(new PutCommand({
      TableName: CHAT_CONNECTIONS_TABLE,
      Item: {
        connectionId: ws.connectionId,
        lastSeen: Math.floor(Date.now() / 1000),
      }
    })).catch(err => console.error('Failed to save connection:', err));

    ws.on('message', async (messageData) => {
      try {
        const data = JSON.parse(messageData.toString());
        const { action, roomId, message, emoji, messageId, user } = data;
        console.log(`[WS] action="${action}" room="${roomId || ws.currentRoom}" user="${user?.username}"`);

        if (action === 'joinRoom') {
          // Leave old room if any
          if (ws.currentRoom) {
            const oldRoomSet = roomClients.get(ws.currentRoom);
            if (oldRoomSet) oldRoomSet.delete(ws);
          }

          ws.currentRoom = roomId;
          ws.userId = user?.id || ws.userId;
          
          if (!roomClients.has(roomId)) {
            roomClients.set(roomId, new Set());
          }
          roomClients.get(roomId).add(ws);

          // Update connection record in DB with roomId
          await dynamoDb.send(new PutCommand({
            TableName: CHAT_CONNECTIONS_TABLE,
            Item: {
              connectionId: ws.connectionId,
              ...(roomId && { roomId }),
              ...(ws.userId && { userId: ws.userId }),
              lastSeen: Math.floor(Date.now() / 1000),
            }
          })).catch(err => console.error(err));

          console.log(`[WebSocket] ${ws.connectionId} joined room ${roomId}`);
        }
        else if (action === 'sendMessage') {
          const targetRoom = ws.currentRoom || roomId;
          if (!targetRoom) {
            console.warn('[WS] sendMessage: no room, dropping message');
            return;
          }

          const msgItem = {
            roomId: targetRoom,
            timestamp: new Date().toISOString(),
            messageId: uuidv4(),
            userId: user?.id || 'unknown',
            username: user?.username || 'Anonymous',
            avatar: user?.avatar || null,
            message: message,
            ttl: Math.floor(Date.now() / 1000) + 604800, // Expires in 7 days
          };

          // Save to DynamoDB
          await dynamoDb.send(new PutCommand({
            TableName: CHAT_MESSAGES_TABLE,
            Item: msgItem,
          })).catch(err => console.error('Error saving message:', err));

          // Broadcast to room
          broadcastToRoom(targetRoom, {
            type: 'message',
            ...msgItem
          });
        }
        else if (action === 'typing') {
          if (!ws.currentRoom) return;
          broadcastToRoom(ws.currentRoom, {
            type: 'typing',
            user: user?.username || 'Someone'
          });
        }
        else if (action === 'react') {
          if (!ws.currentRoom || !messageId || !emoji) return;

          // Save reaction
          await dynamoDb.send(new PutCommand({
            TableName: CHAT_REACTIONS_TABLE,
            Item: {
              messageId,
              userId: user?.id || 'unknown',
              emoji,
            }
          })).catch(err => console.error(err));

          // Broadcast reaction
          broadcastToRoom(ws.currentRoom, {
            type: 'reaction',
            roomId: ws.currentRoom,
            messageId,
            userId: user?.id || 'unknown',
            emoji
          });
        }
        else if (action === 'heartbeat') {
          await dynamoDb.send(new PutCommand({
            TableName: CHAT_CONNECTIONS_TABLE,
            Item: {
              connectionId: ws.connectionId,
              ...(ws.currentRoom && { roomId: ws.currentRoom }),
              ...(ws.userId && { userId: ws.userId }),
              lastSeen: Math.floor(Date.now() / 1000),
            }
          })).catch(err => console.error(err));
        }

      } catch (err) {
        console.error('[WebSocket] Error processing message:', err);
      }
    });

    ws.on('close', async () => {
      console.log(`[WebSocket] Client disconnected: ${ws.connectionId}`);
      if (ws.currentRoom) {
        const roomSet = roomClients.get(ws.currentRoom);
        if (roomSet) roomSet.delete(ws);
      }

      await dynamoDb.send(new DeleteCommand({
        TableName: CHAT_CONNECTIONS_TABLE,
        Key: { connectionId: ws.connectionId }
      })).catch(err => console.error('Failed to delete connection:', err));
    });
  });
}

module.exports = { initWebSocketServer };
