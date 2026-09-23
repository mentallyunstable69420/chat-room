import { DurableObject } from "cloudflare:workers";

const DEV_PASSKEY = "password";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ROOM LIST
    if (url.pathname === "/api/rooms") {
      const id = env.CHAT_ROOM.idFromName("__ROOM_LOBBY__");
      const room = env.CHAT_ROOM.get(id);
      return room.fetch(request);
    }

    // HISTORY
    if (url.pathname === "/api/history") {
      const roomCode = cleanRoomCode(url.searchParams.get("room")) || "general";
      const id = env.CHAT_ROOM.idFromName(roomCode);
      const room = env.CHAT_ROOM.get(id);
      return room.fetch(request);
    }

    // WEBSOCKET
    if (
      url.pathname === "/api/ws" &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      const roomCode =
        cleanRoomCode(url.searchParams.get("room")) || "general";

      const name =
        cleanName(url.searchParams.get("name")) || "Guest";

      const avatar =
        cleanAvatar(url.searchParams.get("avatar"));

      const id = env.CHAT_ROOM.idFromName(roomCode);
      const room = env.CHAT_ROOM.get(id);

      const wsUrl = new URL("https://chatroom.internal/ws");
      wsUrl.searchParams.set("room", roomCode);
      wsUrl.searchParams.set("name", name);
      wsUrl.searchParams.set("avatar", avatar);

      return room.fetch(
        new Request(wsUrl.toString(), request)
      );
    }

    // DEV LOGIN
    if (url.pathname === "/api/dev/login" && request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid request." }, 400);
      }

      if (body.passkey !== DEV_PASSKEY) {
        return json({ error: "Invalid passkey." }, 401);
      }

      const token = btoa(
        JSON.stringify({
          dev: true,
          secret: DEV_PASSKEY,
          time: Date.now()
        })
      );

      return json({ token });
    }

    // DEV USERS
    if (url.pathname === "/api/dev/users") {
      if (!isDevRequest(request)) {
        return json({ error: "Unauthorized." }, 401);
      }

      const id = env.CHAT_ROOM.idFromName("__ROOM_LOBBY__");
      const room = env.CHAT_ROOM.get(id);

      return room.fetch(
        new Request("https://chatroom.internal/dev/users")
      );
    }

    // DEV ACTION
    if (url.pathname === "/api/dev/action" && request.method === "POST") {
      if (!isDevRequest(request)) {
        return json({ error: "Unauthorized." }, 401);
      }

      const id = env.CHAT_ROOM.idFromName("__ROOM_LOBBY__");
      const room = env.CHAT_ROOM.get(id);

      return room.fetch(
        new Request("https://chatroom.internal/dev/action", {
          method: "POST",
          body: await request.text(),
          headers: {
            "Content-Type": "application/json"
          }
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

    this.sessions = new Map();

    for (const ws of ctx.getWebSockets()) {
      const data = ws.deserializeAttachment();

      if (data) {
        this.sessions.set(ws, data);
      }
    }

    this.ready = false;
  }

  async setup() {
    if (this.ready) return;

    this.ready = true;

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

    // Make sure the general room exists.
    let rooms = await this.ctx.storage.get("rooms");

    if (!Array.isArray(rooms)) {
      rooms = [
        {
          name: "General",
          code: "general"
        }
      ];

      await this.ctx.storage.put("rooms", rooms);
    }
  }

  async fetch(request) {
    await this.setup();

    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return this.connect(url);
    }

    if (url.pathname === "/api/history") {
      return this.getHistory();
    }

    if (url.pathname === "/api/rooms" && request.method === "GET") {
      return this.getRooms();
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return this.createRoom(request);
    }

    if (url.pathname === "/dev/users") {
      return this.getDevUsers();
    }

    if (url.pathname === "/dev/action") {
      return this.devAction(request);
    }

    return new Response("Not found", { status: 404 });
  }

  async connect(url) {
    const room =
      cleanRoomCode(url.searchParams.get("room")) || "general";

    const username =
      cleanName(url.searchParams.get("name")) || "Guest";

    const avatar =
      cleanAvatar(url.searchParams.get("avatar"));

    if (!(await this.roomExists(room))) {
      return new Response("Room does not exist.", {
        status: 404
      });
    }

    const pair = new WebSocketPair();

    const client = pair[0];
    const server = pair[1];

    const session = {
      username,
      avatar,
      room,
      joinedAt: Date.now()
    };

    server.serializeAttachment(session);

    this.ctx.acceptWebSocket(server);

    this.sessions.set(server, session);

    // Send existing messages immediately.
    const messages = this.getMessages();

    server.send(
      JSON.stringify({
        type: "history",
        messages
      })
    );

    await this.sendMembers();

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws, message) {
    const session =
      ws.deserializeAttachment() ||
      this.sessions.get(ws);

    if (!session) return;

    let data;

    try {
      data =
        typeof message === "string"
          ? JSON.parse(message)
          : JSON.parse(new TextDecoder().decode(message));
    } catch {
      this.send(ws, {
        type: "error",
        message: "Invalid message."
      });
      return;
    }

    if (data.action === "message") {
      await this.sendMessage(session, data.text);
    }

    if (data.action === "edit") {
      await this.editMessage(session, data.id, data.text);
    }

    if (data.action === "delete") {
      await this.deleteMessage(session, data.id);
    }

    if (data.action === "pin") {
      await this.pinMessage(session, data.id);
    }
  }

  async webSocketClose(ws) {
    this.sessions.delete(ws);
    await this.sendMembers();
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
    await this.sendMembers();
  }

  getMessages() {
    const rows = this.ctx.storage.sql.exec(`
      SELECT
        id,
        username,
        avatar,
        text,
        created_at,
        edited,
        pinned
      FROM messages
      ORDER BY created_at ASC
      LIMIT 500
    `).toArray();

    return rows.map(row => ({
      id: String(row.id),
      username: String(row.username || ""),
      avatar: String(row.avatar || ""),

      // IMPORTANT:
      // Always send the actual message text.
      text: String(row.text || ""),

      created_at: Number(row.created_at),
      edited: Boolean(row.edited),
      pinned: Boolean(row.pinned)
    }));
  }

  async sendMessage(session, text) {
    text = String(text || "").trim();

    if (!text) return;

    if (text.length > 2000) {
      return;
    }

    const message = {
      id: crypto.randomUUID(),
      username: session.username,
      avatar: session.avatar || "",
      text: text,
      created_at: Date.now(),
      edited: false,
      pinned: false
    };

    this.ctx.storage.sql.exec(
      `
      INSERT INTO messages
      (id, username, avatar, text, created_at, edited, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      message.id,
      message.username,
      message.avatar,
      message.text,
      message.created_at,
      0,
      0
    );

    this.broadcast({
      type: "message",
      message
    });
  }

  async editMessage(session, id, text) {
    text = String(text || "").trim();

    if (!id || !text) return;

    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM messages WHERE id = ?`,
      id
    ).toArray();

    const old = rows[0];

    if (!old) return;

    if (old.username !== session.username) return;

    this.ctx.storage.sql.exec(
      `
      UPDATE messages
      SET text = ?, edited = 1
      WHERE id = ?
      `,
      text,
      id
    );

    const message = {
      id: String(old.id),
      username: String(old.username),
      avatar: String(old.avatar || ""),
      text: text,
      created_at: Number(old.created_at),
      edited: true,
      pinned: Boolean(old.pinned)
    };

    this.broadcast({
      type: "message_edit",
      message
    });
  }

  async deleteMessage(session, id) {
    if (!id) return;

    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM messages WHERE id = ?`,
      id
    ).toArray();

    const old = rows[0];

    if (!old) return;

    if (old.username !== session.username) return;

    this.ctx.storage.sql.exec(
      `DELETE FROM messages WHERE id = ?`,
      id
    );

    this.broadcast({
      type: "message_delete",
      id
    });
  }

  async pinMessage(session, id) {
    if (!id) return;

    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM messages WHERE id = ?`,
      id
    ).toArray();

    const old = rows[0];

    if (!old) return;

    if (old.username !== session.username) return;

    const pinned = !Boolean(old.pinned);

    this.ctx.storage.sql.exec(
      `
      UPDATE messages
      SET pinned = ?
      WHERE id = ?
      `,
      pinned ? 1 : 0,
      id
    );

    const message = {
      id: String(old.id),
      username: String(old.username),
      avatar: String(old.avatar || ""),
      text: String(old.text || ""),
      created_at: Number(old.created_at),
      edited: Boolean(old.edited),
      pinned
    };

    this.broadcast({
      type: "message_edit",
      message
    });
  }

  async getHistory() {
    return json({
      messages: this.getMessages()
    });
  }

  async getRooms() {
    let rooms =
      await this.ctx.storage.get("rooms");

    if (!Array.isArray(rooms)) {
      rooms = [];
    }

    if (!rooms.some(room => room.code === "general")) {
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
      return json({
        error: "Invalid request."
      }, 400);
    }

    const name = cleanRoomName(body.name);
    const code = cleanRoomCode(body.code);

    if (!name) {
      return json({
        error: "Room name is required."
      }, 400);
    }

    if (!/^[a-z0-9_-]{2,30}$/.test(code)) {
      return json({
        error: "Invalid room code."
      }, 400);
    }

    let rooms =
      await this.ctx.storage.get("rooms");

    if (!Array.isArray(rooms)) {
      rooms = [];
    }

    if (rooms.some(room => room.code === code)) {
      return json({
        error: "That room already exists."
      }, 409);
    }

    const room = {
      name,
      code
    };

    rooms.push(room);

    await this.ctx.storage.put("rooms", rooms);

    return json({
      success: true,
      room
    });
  }

  async roomExists(code) {
    if (code === "general") return true;

    const rooms =
      await this.ctx.storage.get("rooms");

    if (!Array.isArray(rooms)) return false;

    return rooms.some(room => room.code === code);
  }

  async sendMembers() {
    const members = [];

    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      const session =
        ws.deserializeAttachment() ||
        this.sessions.get(ws);

      if (!session) continue;

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
    const output = JSON.stringify(data);

    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(output);
        }
      } catch {}
    }
  }

  send(ws, data) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    } catch {}
  }

  async getDevUsers() {
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
      return json({
        error: "Invalid request."
      }, 400);
    }

    const target = String(body.target || "").trim();
    const action = String(body.action || "");

    let seconds = Number(body.seconds) || 60;

    seconds = Math.max(
      1,
      Math.min(seconds, 86400)
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
          message: "You were kicked from the chatroom."
        });

        try {
          ws.close(4001, "Kicked");
        } catch {}
      }

      if (action === "timeout") {
        this.send(ws, {
          type: "error",
          message:
            `You were timed out for ${seconds} seconds.`
        });

        try {
          ws.close(4002, "Timed out");
        } catch {}
      }
    }

    return json({
      success: true
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
  const valueString = String(value || "").trim();

  if (
    valueString.startsWith("https://") ||
    valueString.startsWith("http://")
  ) {
    return valueString.slice(0, 500);
  }

  return "";
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}

function isDevRequest(request) {
  const header =
    request.headers.get("Authorization") || "";

  if (!header.startsWith("Bearer ")) {
    return false;
  }

  try {
    const token = header.slice(7);

    const data = JSON.parse(
      atob(token)
    );

    return (
      data.dev === true &&
      data.secret === DEV_PASSKEY
    );
  } catch {
    return false;
  }
}
