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

    // WhatsApp inbox: the business number is shared, so there's no
    // per-thread participant list to check like chat.service.js's threads -
    // every authenticated staff member with inbox access can join the
    // overview room. `whatsapp:open` additionally joins one contact's room
    // (room key = phone number or BSUID, whichever the contact is known by)
    // so an open conversation gets new messages pushed live.
    socket.on('whatsapp:join', () => socket.join('whatsapp:inbox'));

    socket.on('whatsapp:open', async ({ phoneNumber, waUserId } = {}) => {
      const key = phoneNumber || waUserId;
      if (!key) return;
      try {
        // Lazy require: whatsapp.service.js also requires this module (to emit).
        await require('../services/whatsapp.service').assertInboxAccess(socket.user, { phoneNumber, waUserId });
        socket.join(`whatsapp:contact:${key}`);
      } catch {
        // Different tenant's contact - no-op, nothing joined.
      }
    });

    socket.on('whatsapp:close', ({ phoneNumber, waUserId } = {}) => {
      const key = phoneNumber || waUserId;
      if (key) socket.leave(`whatsapp:contact:${key}`);
    });
  });

  return io;
}

function getIo() {
  return io;
}

module.exports = { init, getIo };
