import { DurableObject } from "cloudflare:workers";

const DEV_PASSKEY = "password";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/rooms" && request.method === "GET") {
      const id = env.CHAT_ROOM.idFromName("__ROOM_LOBBY__");
      const room = env.CHAT_ROOM.get(id);
      return room.fetch(new Request(url.toString(), request));
    }

    if (path === "/api/rooms" && request.method === "POST") {
      const id = env.CHAT_ROOM.idFromName("__ROOM_LOBBY__");
      const room = env.CHAT_ROOM.get(id);
      return room.fetch(new Request(url.toString(), request));
    }

    if (path === "/api/history" && request.method === "GET") {
      const roomCode = url.searchParams.get("room") || "general";
      const id = env.CHAT_ROOM.idFromName(roomCode);
      const room = env.CHAT_ROOM.get(id);
      return room.fetch(new Request(url.toString(), request));
    }

    if (path === "/api/ws" && request.headers.get("Upgrade") === "websocket") {
      const roomCode = cleanRoomCode(url.searchParams.get("room")) || "general";

      const id = env.CHAT_ROOM.idFromName(roomCode);
      const room = env.CHAT_ROOM.get(id);

      return room.fetch(
        new Request(
          `https://chatroom.internal/ws?room=${encodeURIComponent(roomCode)}&name=${encodeURIComponent(url.searchParams.get("name") || "Guest")}&avatar=${encodeURIComponent(url.searchParams.get("avatar") || "")}`,
          request
        )
      );
    }

    if (path === "/api/dev/login" && request.method === "POST") {
      try {
        const body = await request.json();

        if (body.passkey !== DEV_PASSKEY) {
          return json({ error: "Invalid passkey." }, 401);
        }

        const token = btoa(
          JSON.stringify({
            dev: true,
            issued: Date.now(),
            secret: DEV_PASSKEY
          })
        );

        return json({ token });
      } catch {
        return json({ error: "Invalid request." }, 400);
      }
    }

    if (path === "/api/dev/users" && request.method === "GET") {
      if (!isDevRequest(request)) {
        return json({ error: "Unauthorized." }, 401);
      }

      const id = env.CHAT_ROOM.idFromName("__ROOM_LOBBY__");
      const room = env.CHAT_ROOM.get(id);

      return room.fetch(
        new Request("https://chatroom.internal/dev/users", {
          method: "GET",
          headers: request.headers
        })
      );
    }

    if (path === "/api/dev/action" && request.method === "POST") {
      if (!isDevRequest(request)) {
        return json({ error: "Unauthorized." }, 401);
      }

      const id = env.CHAT_ROOM.idFromName("__ROOM_LOBBY__");
      const room = env.CHAT_ROOM.get(id);

      return room.fetch(
        new Request("https://chatroom.internal/dev/action", {
          method: "POST",
          headers: request.headers,
          body: await request.text()
        })
      );
    }

    return env.ASSETS.fetch(request);
  }
};

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;

    // Restore any WebSocket sessions after hibernation.
    // Cloudflare recommends using getWebSockets() plus
    // serializeAttachment()/deserializeAttachment() for this.
    this.sessions = new Map();

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment();

      if (attachment) {
        this.sessions.set(ws, attachment);
      }
    }

    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong")
      );
    } catch {}

    this.initialized = false;
  }

  async ensureDatabase() {
    if (this.initialized) return;

    this.initialized = true;

    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          avatar TEXT DEFAULT '',
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          edited INTEGER DEFAULT 0,
          pinned INTEGER DEFAULT 0
        )
      `);
    } catch (e) {
      console.error("Database initialization error:", e);
    }
  }

  async fetch(request) {
    await this.ensureDatabase();

    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return this.handleWebSocket(url);
    }

    if (url.pathname === "/api/history") {
      return this.history();
    }

    if (url.pathname === "/api/rooms" && request.method === "GET") {
      return this.getRooms();
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return this.createRoom(request);
    }

    if (url.pathname === "/dev/users") {
      return this.devUsers();
    }

    if (url.pathname === "/dev/action") {
      return this.devAction(request);
    }

    return new Response("Not found", { status: 404 });
  }

  async handleWebSocket(url) {
    const room =
      cleanRoomCode(url.searchParams.get("room")) || "general";

    const name =
      cleanName(url.searchParams.get("name")) || "Guest";

    const avatar =
      cleanAvatar(url.searchParams.get("avatar"));

    // Make sure this Durable Object really represents the requested room.
    const roomExists = await this.roomExists(room);

    if (!roomExists) {
      return new Response("Room does not exist.", { status: 404 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    const session = {
      username: name,
      avatar,
      room,
      joinedAt: Date.now()
    };

    // Hibernatable WebSocket.
    this.ctx.acceptWebSocket(server);

    // Persist connection information so it survives DO hibernation.
    server.serializeAttachment(session);

    this.sessions.set(server, session);

    await this.broadcastMembers();

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws, rawMessage) {
    await this.ensureDatabase();

    const session =
      ws.deserializeAttachment() ||
      this.sessions.get(ws);

    if (!session) {
      try {
        ws.close(1011, "Session missing");
      } catch {}
      return;
    }

    this.sessions.set(ws, session);

    let data;

    try {
      data =
        typeof rawMessage === "string"
          ? JSON.parse(rawMessage)
          : JSON.parse(new TextDecoder().decode(rawMessage));
    } catch {
      this.send(ws, {
        type: "error",
        message: "Invalid message."
      });
      return;
    }

    if (data.action === "message") {
      await this.createMessage(ws, session, data.text);
      return;
    }

    if (data.action === "edit") {
      await this.editMessage(ws, session, data.id, data.text);
      return;
    }

    if (data.action === "delete") {
      await this.deleteMessage(ws, session, data.id);
      return;
    }

    if (data.action === "pin") {
      await this.pinMessage(ws, session, data.id);
      return;
    }
  }

  async webSocketClose(ws) {
    this.sessions.delete(ws);
    await this.broadcastMembers();
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
    await this.broadcastMembers();
  }

  async createMessage(ws, session, text) {
    text = String(text || "").trim();

    if (!text) return;

    if (text.length > 2000) {
      this.send(ws, {
        type: "error",
        message: "Message is too long."
      });
      return;
    }

    const id = crypto.randomUUID();
    const createdAt = Date.now();

    this.ctx.storage.sql.exec(
      `INSERT INTO messages
       (id, username, avatar, text, created_at, edited, pinned)
       VALUES (?, ?, ?, ?, ?, 0, 0)`,
      id,
      session.username,
      session.avatar || "",
      text,
      createdAt
    );

    const message = {
      id,
      username: session.username,
      avatar: session.avatar || "",
      text,
      created_at: createdAt,
      edited: false,
      pinned: false
    };

    this.broadcast({
      type: "message",
      message
    });
  }

  async editMessage(ws, session, id, text) {
    text = String(text || "").trim();

    if (!id || !text || text.length > 2000) return;

    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM messages WHERE id = ? LIMIT 1`,
      id
    ).toArray();

    const msg = rows[0];

    if (!msg) return;

    if (msg.username !== session.username) {
      this.send(ws, {
        type: "error",
        message: "You can only edit your own messages."
      });
      return;
    }

    this.ctx.storage.sql.exec(
      `UPDATE messages SET text = ?, edited = 1 WHERE id = ?`,
      text,
      id
    );

    const updated = {
      ...msg,
      text,
      edited: true,
      pinned: Boolean(msg.pinned)
    };

    this.broadcast({
      type: "message_edit",
      message: updated
    });
  }

  async deleteMessage(ws, session, id) {
    if (!id) return;

    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM messages WHERE id = ? LIMIT 1`,
      id
    ).toArray();

    const msg = rows[0];

    if (!msg) return;

    if (msg.username !== session.username) {
      this.send(ws, {
        type: "error",
        message: "You can only delete your own messages."
      });
      return;
    }

    this.ctx.storage.sql.exec(
      `DELETE FROM messages WHERE id = ?`,
      id
    );

    this.broadcast({
      type: "message_delete",
      id
    });
  }

  async pinMessage(ws, session, id) {
    if (!id) return;

    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM messages WHERE id = ? LIMIT 1`,
      id
    ).toArray();

    const msg = rows[0];

    if (!msg) return;

    if (msg.username !== session.username) {
      this.send(ws, {
        type: "error",
        message: "You can only pin your own messages."
      });
      return;
    }

    const newPinned = !Boolean(msg.pinned);

    this.ctx.storage.sql.exec(
      `UPDATE messages SET pinned = ? WHERE id = ?`,
      newPinned ? 1 : 0,
      id
    );

    const updated = {
      ...msg,
      pinned: newPinned,
      edited: Boolean(msg.edited)
    };

    this.broadcast({
      type: "message_edit",
      message: updated
    });
  }

  async history() {
    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM messages ORDER BY created_at ASC LIMIT 500`
    ).toArray();

    const messages = rows.map(row => ({
      ...row,
      edited: Boolean(row.edited),
      pinned: Boolean(row.pinned)
    }));

    return json({ messages });
  }

  async getRooms() {
    let rooms = [];

    try {
      const stored =
        await this.ctx.storage.get("rooms");

      if (Array.isArray(stored)) {
        rooms = stored;
      }
    } catch {}

    if (!rooms.some(r => r.code === "general")) {
      rooms.unshift({
        name: "General",
        code: "general"
      });

      await this.ctx.storage.put("rooms", rooms);
    }

    return json({ rooms });
  }

  async createRoom(request) {
    let body;

    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }

    const name = cleanRoomName(body.name);
    const code = cleanRoomCode(body.code);

    if (!name) {
      return json({ error: "Room name is required." }, 400);
    }

    if (!code || !/^[a-z0-9_-]{2,30}$/.test(code)) {
      return json({ error: "Invalid room code." }, 400);
    }

    let rooms =
      (await this.ctx.storage.get("rooms")) || [];

    if (!Array.isArray(rooms)) rooms = [];

    if (rooms.some(r => r.code === code)) {
      return json({ error: "That room code already exists." }, 409);
    }

    rooms.push({
      name,
      code
    });

    await this.ctx.storage.put("rooms", rooms);

    return json({
      success: true,
      room: { name, code }
    });
  }

  async roomExists(code) {
    let rooms =
      (await this.ctx.storage.get("rooms")) || [];

    if (!Array.isArray(rooms)) rooms = [];

    if (code === "general") return true;

    return rooms.some(r => r.code === code);
  }

  async broadcastMembers() {
    const members = [];

    for (const ws of this.ctx.getWebSockets()) {
      const session =
        ws.deserializeAttachment() ||
        this.sessions.get(ws);

      if (!session) continue;

      if (ws.readyState !== WebSocket.OPEN) continue;

      members.push({
        username: session.username,
        avatar: session.avatar || ""
      });
    }

    this.broadcast({
      type: "members",
      members
    });
  }

  broadcast(data) {
    const payload = JSON.stringify(data);

    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      } catch {
        try {
          ws.close();
        } catch {}
      }
    }
  }

  send(ws, data) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    } catch {}
  }

  async devUsers() {
    const users = [];

    for (const ws of this.ctx.getWebSockets()) {
      const session =
        ws.deserializeAttachment() ||
        this.sessions.get(ws);

      if (!session) continue;

      users.push({
        username: session.username,
        avatar: session.avatar || "",
        room: session.room
      });
    }

    return json({ users });
  }

  async devAction(request) {
    let body;

    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }

    const action = body.action;
    const target = String(body.target || "").trim();

    if (!target) {
      return json({ error: "Target is required." }, 400);
    }

    const seconds = Math.max(
      1,
      Math.min(
        Number(body.seconds) || 60,
        86400
      )
    );

    for (const ws of this.ctx.getWebSockets()) {
      const session =
        ws.deserializeAttachment() ||
        this.sessions.get(ws);

      if (!session) continue;

      if (session.username !== target) continue;

      if (action === "kick") {
        this.send(ws, {
          type: "error",
          message: "You have been kicked from this chatroom."
        });

        try {
          ws.close(4001, "Kicked");
        } catch {}

        continue;
      }

      if (action === "timeout") {
        this.send(ws, {
          type: "error",
          message:
            "You have been timed out for " +
            seconds +
            " seconds."
        });

        try {
          ws.close(4002, "Timed out");
        } catch {}

        continue;
      }
    }

    return json({
      success: true,
      action,
      seconds
    });
  }
}

function cleanName(value) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 24);
}

function cleanRoomName(value) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 40);
}

function cleanRoomCode(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 30);
}

function cleanAvatar(value) {
  const avatar = String(value || "").trim();

  if (!avatar) return "";

  if (
    avatar.startsWith("https://") ||
    avatar.startsWith("http://")
  ) {
    return avatar.slice(0, 500);
  }

  return "";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function isDevRequest(request) {
  const auth =
    request.headers.get("Authorization") || "";

  if (!auth.startsWith("Bearer ")) {
    return false;
  }

  try {
    const token = auth.slice(7);
    const data = JSON.parse(atob(token));

    return (
      data.dev === true &&
      data.secret === DEV_PASSKEY
    );
  } catch {
    return false;
  }
}
