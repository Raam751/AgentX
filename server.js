require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Agent = require('./src/agent');
const logger = require('./src/logger');

// ═════════════════════════════════════════════════════════════════════════════
// Server — Express + Socket.IO for the real-time dashboard
// ═════════════════════════════════════════════════════════════════════════════

const app = express();
const server = createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10e6, // 10 MB — screenshots can be large
});

const PORT = process.env.PORT || 3000;

// ─── Static Files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

// ─── Agent State ─────────────────────────────────────────────────────────────
let activeAgent = null;

// ─── Socket.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info(`Dashboard connected (${socket.id})`);

  // Send current status
  socket.emit('status', { state: activeAgent?.running ? 'running' : 'idle' });

  // ── Start Task ──────────────────────────────────────────────────────────
  socket.on('start_task', async ({ task }) => {
    if (activeAgent?.running) {
      socket.emit('error', { message: 'An agent is already running. Stop it first.' });
      return;
    }

    if (!task || task.trim().length === 0) {
      socket.emit('error', { message: 'Task cannot be empty.' });
      return;
    }

    logger.info(`📋 Task received: ${task.substring(0, 100)}...`);

    // Create agent with Socket.IO as emitter for real-time events
    activeAgent = new Agent(socket);
    logger.setEmitter(socket);

    try {
      // Broadcast running status to all clients
      io.emit('status', { state: 'running' });

      const result = await activeAgent.run(task);

      logger.success(`🎉 Done in ${result.steps} steps`);
      io.emit('status', { state: 'idle' });
    } catch (err) {
      logger.error(`Agent failed: ${err.message}`);
      socket.emit('error', { message: err.message });
      io.emit('status', { state: 'error' });
    } finally {
      activeAgent = null;
      logger.setEmitter(null);
    }
  });

  // ── Stop Task ───────────────────────────────────────────────────────────
  socket.on('stop_task', () => {
    if (activeAgent?.running) {
      activeAgent.stop();
      logger.info('⏹ Agent stop requested by user');
      io.emit('status', { state: 'idle' });
    }
  });

  // ── Resume Task (after pause_for_user) ─────────────────────────────────
  socket.on('resume_task', () => {
    if (activeAgent) {
      activeAgent.resume();
      logger.info('▶ Agent resumed by user');
    }
  });

  // ── Disconnect ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    logger.info(`Dashboard disconnected (${socket.id})`);
  });
});

// ─── Start Server ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log('  ║                                                   ║');
  console.log('  ║   🤖  AI Browser Automation Agent v2              ║');
  console.log('  ║   Powered by Groq/OpenAI + Playwright             ║');
  console.log('  ║                                                   ║');
  console.log(`  ║   Dashboard:  http://localhost:${PORT}               ║`);
  console.log('  ║                                                   ║');
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');
  logger.info(`Server running on port ${PORT}`);
});
