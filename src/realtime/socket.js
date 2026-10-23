const { Server } = require('socket.io');
const { verifyAccessToken } = require('../utils/jwt');

// Real-time push for Module 36 chat. The REST API (chat.routes.js) stays the
// source of truth and keeps working on its own (both frontends still poll
// as a fallback) - this only shortens the delay for an open conversation
// from the existing 5s poll to near-instant.
let io = null;

// `user:<id>` - every connected user, for cross-thread events (unread bump)
// regardless of which conversation they currently have open.
// `thread:<id>` - only joined after the server has verified the socket's
// user is actually a participant on that thread (see 'thread:join' below) -
// never trust a client-supplied thread id without that check.
function init(httpServer) {
  io = new Server(httpServer, { cors: { origin: '*' } });

  io.use((socket, next) => {
    try {
      const decoded = verifyAccessToken(socket.handshake.auth?.token || '');
      socket.user = decoded; // { id, role, tenant_id }
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.user.id}`);

    socket.on('thread:join', async (threadId) => {
      try {
        // Lazy require: chat.service.js also requires this module (to emit),
        // so a top-level require here would be circular.
        await require('../services/chat.service').threadFor(socket.user, threadId);
        socket.join(`thread:${threadId}`);
      } catch {
        // Not a participant (or not a real thread) - no-op, nothing joined.
      }
    });

    socket.on('thread:leave', (threadId) => {
      socket.leave(`thread:${threadId}`);
    });
  });

  return io;
}

function getIo() {
  return io;
}

module.exports = { init, getIo };
