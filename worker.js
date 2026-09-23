import { DurableObject } from "cloudflare:workers";

const DEV_PASSKEY = "password";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================================
    // ROOM LIST
    // =========================================================

    if (url.pathname === "/api/rooms") {
      const id = env.CHAT_ROOM.idFromName("__ROOM_LOBBY__");
      const room = env.CHAT_ROOM.get(id);

      return room.fetch(
        new Request("https://chatroom.internal/api/rooms", {
          method: request.method,
          body:
            request.method === "POST"
              ? await request.text()
              : undefined,
          headers: request.headers
        })
      );
    }

    // =========================================================
    // CHAT HISTORY
    // =========================================================

    if (url.pathname === "/api/history") {
      const roomCode =
        cleanRoomCode(url.searchParams.get("room")) ||
        "general";

      const id = env.CHAT_ROOM.idFromName(roomCode);
      const room = env.CHAT_ROOM.get(id);

      return room.fetch(
        new Request(
          "https://chatroom.internal/api/history"
        )
      );
    }

    // =========================================================
    // WEBSOCKET
    // =========================================================

    if (
      url.pathname === "/api/ws" &&
      request.headers.get("Upgrade")?.toLowerCase() ===
        "websocket"
    ) {
      const roomCode =
        cleanRoomCode(url.searchParams.get("room")) ||
        "general";

      const name =
        cleanName(url.searchParams.get("name")) ||
        "Guest";

      const avatar =
        cleanAvatar(url.searchParams.get("avatar"));

      const id =
        env.CHAT_ROOM.idFromName(roomCode);

      const room =
        env.CHAT_ROOM.get(id);

      const wsUrl =
        new URL("https://chatroom.internal/ws");

      wsUrl.searchParams.set(
        "room",
        roomCode
      );

      wsUrl.searchParams.set(
        "name",
        name
      );

      wsUrl.searchParams.set(
        "avatar",
        avatar
      );

      return room.fetch(
        new Request(wsUrl.toString(), request)
      );
    }

    // =========================================================
    // DEV LOGIN
    // =========================================================

    if (
      url.pathname === "/api/dev/login" &&
      request.method === "POST"
    ) {
      let body;

      try {
        body = await request.json();
      } catch {
        return json(
          { error: "Invalid request." },
          400
        );
      }

      if (body.passkey !== DEV_PASSKEY) {
        return json(
          { error: "Invalid passkey." },
          401
        );
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

    // =========================================================
    // DEV USERS
    // =========================================================

    if (url.pathname === "/api/dev/users") {
      if (!isDevRequest(request)) {
        return json(
          { error: "Unauthorized." },
          401
        );
      }

      const id =
        env.CHAT_ROOM.idFromName(
          "__ROOM_LOBBY__"
        );

      const room =
        env.CHAT_ROOM.get(id);

      return room.fetch(
        new Request(
          "https://chatroom.internal/dev/users"
        )
      );
    }

    // =========================================================
    // DEV ACTION
    // =========================================================

    if (
      url.pathname === "/api/dev/action" &&
      request.method === "POST"
    ) {
      if (!isDevRequest(request)) {
        return json(
          { error: "Unauthorized." },
          401
        );
      }

      const id =
        env.CHAT_ROOM.idFromName(
          "__ROOM_LOBBY__"
        );

      const room =
        env.CHAT_ROOM.get(id);

      return room.fetch(
        new Request(
          "https://chatroom.internal/dev/action",
          {
            method: "POST",
            body: await request.text(),
            headers: {
              "Content-Type":
                "application/json"
            }
          }
        )
      );
    }

    // =========================================================
    // WEBSITE FILES
    // =========================================================

    return env.ASSETS.fetch(request);
  }
};


// =============================================================
// CHAT ROOM DURABLE OBJECT
// =============================================================

export class ChatRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;

    // Rebuild the in-memory session map after
    // Durable Object hibernation.
    this.sessions = new Map();

    for (const ws of ctx.getWebSockets()) {
      try {
        const session =
          ws.deserializeAttachment();

        if (session) {
          this.sessions.set(
            ws,
            session
          );
        }
      } catch {}
    }

    this.ready = false;
  }


  // ===========================================================
  // DATABASE SETUP / REPAIR
  // ===========================================================

  async setup() {
    if (this.ready) {
      return;
    }

    // Create the table if this is a brand-new room.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL DEFAULT 'Guest',
        avatar TEXT DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT 0,
        edited INTEGER DEFAULT 0,
        pinned INTEGER DEFAULT 0
      )
    `);

    // Find existing columns.
    const columns =
      this.ctx.storage.sql
        .exec(`PRAGMA table_info(messages)`)
        .toArray()
        .map(row => String(row.name));

    // ---------------------------------------------------------
    // Repair older database versions.
    // ---------------------------------------------------------

    if (!columns.includes("username")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE messages
        ADD COLUMN username TEXT
        NOT NULL DEFAULT 'Guest'
      `);
    }

    if (!columns.includes("avatar")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE messages
        ADD COLUMN avatar TEXT
        DEFAULT ''
      `);
    }

    if (!columns.includes("text")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE messages
        ADD COLUMN text TEXT
        NOT NULL DEFAULT ''
      `);

      // Older version may have used "message".
      if (columns.includes("message")) {
        this.ctx.storage.sql.exec(`
          UPDATE messages
          SET text = message
          WHERE text = ''
          AND message IS NOT NULL
        `);
      }

      // Older version may have used "content".
      if (columns.includes("content")) {
        this.ctx.storage.sql.exec(`
          UPDATE messages
          SET text = content
          WHERE text = ''
          AND content IS NOT NULL
        `);
      }
    }

    if (!columns.includes("created_at")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE messages
        ADD COLUMN created_at INTEGER
        NOT NULL DEFAULT 0
      `);

      // Older version may have used "timestamp".
      if (columns.includes("timestamp")) {
        this.ctx.storage.sql.exec(`
          UPDATE messages
          SET created_at = timestamp
          WHERE created_at = 0
          AND timestamp IS NOT NULL
        `);
      }
    }

    if (!columns.includes("edited")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE messages
        ADD COLUMN edited INTEGER
        DEFAULT 0
      `);
    }

    if (!columns.includes("pinned")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE messages
        ADD COLUMN pinned INTEGER
        DEFAULT 0
      `);
    }

    this.ready = true;
  }


  // ===========================================================
  // DURABLE OBJECT REQUEST HANDLER
  // ===========================================================

  async fetch(request) {
    await this.setup();

    const url =
      new URL(request.url);

    // WebSocket connection.
    if (url.pathname === "/ws") {
      return this.connect(url);
    }

    // History.
    if (url.pathname === "/api/history") {
      return this.getHistory();
    }

    // Rooms.
    if (
      url.pathname === "/api/rooms" &&
      request.method === "GET"
    ) {
      return this.getRooms();
    }

    if (
      url.pathname === "/api/rooms" &&
      request.method === "POST"
    ) {
      return this.createRoom(request);
    }

    // Developer tools.
    if (url.pathname === "/dev/users") {
      return this.getDevUsers();
    }

    if (url.pathname === "/dev/action") {
      return this.devAction(request);
    }

    return new Response(
      "Not found",
      { status: 404 }
    );
  }


  // ===========================================================
  // CONNECT WEBSOCKET
  // ===========================================================

  async connect(url) {
    const room =
      cleanRoomCode(
        url.searchParams.get("room")
      ) || "general";

    const username =
      cleanName(
        url.searchParams.get("name")
      ) || "Guest";

    const avatar =
      cleanAvatar(
        url.searchParams.get("avatar")
      );

    const pair =
      new WebSocketPair();

    const client = pair[0];
    const server = pair[1];

    const session = {
      username,
      avatar,
      room,
      joinedAt: Date.now(),
      sessionId: crypto.randomUUID()
    };

    // IMPORTANT:
    // Save the session on the WebSocket so it survives
    // Durable Object hibernation.
    server.serializeAttachment(
      session
    );

    // Accept as a hibernatable WebSocket.
    this.ctx.acceptWebSocket(
      server
    );

    this.sessions.set(
      server,
      session
    );

    // Send history immediately.
    try {
      server.send(
        JSON.stringify({
          type: "history",
          messages: this.getMessages()
        })
      );
    } catch {}

    // Tell everyone about the new member.
    await this.sendMembers();

    return new Response(
      null,
      {
        status: 101,
        webSocket: client
      }
    );
  }


  // ===========================================================
  // RECEIVE WEBSOCKET MESSAGE
  // ===========================================================

  async webSocketMessage(
    ws,
    message
  ) {
    const session =
      this.getSession(ws);

    if (!session) {
      return;
    }

    let data;

    try {
      if (
        typeof message === "string"
      ) {
        data =
          JSON.parse(message);
      } else {
        data =
          JSON.parse(
            new TextDecoder().decode(
              message
            )
          );
      }
    } catch {
      this.send(ws, {
        type: "error",
        message:
          "Invalid message."
      });

      return;
    }

    // New message.
    if (
      data.action === "message"
    ) {
      await this.sendMessage(
        session,
        data.text
      );

      return;
    }

    // Edit.
    if (
      data.action === "edit"
    ) {
      await this.editMessage(
        session,
        data.id,
        data.text
      );

      return;
    }

    // Delete.
    if (
      data.action === "delete"
    ) {
      await this.deleteMessage(
        session,
        data.id
      );

      return;
    }

    // Pin.
    if (
      data.action === "pin"
    ) {
      await this.pinMessage(
        session,
        data.id
      );

      return;
    }
  }


  // ===========================================================
  // WEBSOCKET CLOSE
  // ===========================================================

  async webSocketClose(ws) {
    this.sessions.delete(ws);

    await this.sendMembers();
  }


  // ===========================================================
  // WEBSOCKET ERROR
  // ===========================================================

  async webSocketError(ws) {
    this.sessions.delete(ws);

    await this.sendMembers();
  }


  // ===========================================================
  // GET SESSION
  // ===========================================================

  getSession(ws) {
    try {
      const attached =
        ws.deserializeAttachment();

      if (attached) {
        return attached;
      }
    } catch {}

    return this.sessions.get(ws);
  }


  // ===========================================================
  // GET MESSAGE HISTORY
  // ===========================================================

  getMessages() {
    const rows =
      this.ctx.storage.sql
        .exec(`
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
        `)
        .toArray();

    return rows.map(row => ({
      id: String(row.id),

      username:
        String(
          row.username ||
          "Guest"
        ),

      avatar:
        String(
          row.avatar || ""
        ),

      text:
        String(
          row.text || ""
        ),

      created_at:
        Number(
          row.created_at ||
          Date.now()
        ),

      edited:
        Boolean(row.edited),

      pinned:
        Boolean(row.pinned)
    }));
  }


  // ===========================================================
  // SEND NEW MESSAGE
  // ===========================================================

  async sendMessage(
    session,
    text
  ) {
    text =
      String(text || "")
        .trim();

    if (!text) {
      return;
    }

    if (text.length > 2000) {
      return;
    }

    const message = {
      id:
        crypto.randomUUID(),

      username:
        session.username,

      avatar:
        session.avatar || "",

      text,

      created_at:
        Date.now(),

      edited: false,

      pinned: false
    };

    // Save first.
    this.ctx.storage.sql.exec(
      `
      INSERT INTO messages
      (
        id,
        username,
        avatar,
        text,
        created_at,
        edited,
        pinned
      )
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

    /*
     * IMPORTANT:
     *
     * Send the message to EVERY WebSocket currently
     * connected to this Durable Object.
     *
     * That means:
     * - the person who sent it sees it immediately
     * - everyone else in the room sees it immediately
     * - nobody needs to refresh
     */

    this.broadcast({
      type: "message",

      // Main format used by the newer frontend.
      message,

      // Also include the fields directly for compatibility
      // with older frontend versions.
      id: message.id,
      username: message.username,
      avatar: message.avatar,
      text: message.text,
      created_at: message.created_at,
      edited: false,
      pinned: false
    });
  }


  // ===========================================================
  // EDIT MESSAGE
  // ===========================================================

  async editMessage(
    session,
    id,
    text
  ) {
    text =
      String(text || "")
        .trim();

    if (!id || !text) {
      return;
    }

    const rows =
      this.ctx.storage.sql
        .exec(
          `
          SELECT *
          FROM messages
          WHERE id = ?
          `,
          id
        )
        .toArray();

    const old = rows[0];

    if (!old) {
      return;
    }

    // Users can only edit their own messages.
    if (
      old.username !==
      session.username
    ) {
      return;
    }

    this.ctx.storage.sql.exec(
      `
      UPDATE messages
      SET
        text = ?,
        edited = 1
      WHERE id = ?
      `,
      text,
      id
    );

    const updated = {
      id: String(old.id),

      username:
        String(old.username),

      avatar:
        String(old.avatar || ""),

      text,

      created_at:
        Number(old.created_at),

      edited: true,

      pinned:
        Boolean(old.pinned)
    };

    this.broadcast({
      type: "message_edit",
      message: updated,

      // Compatibility fields.
      id: updated.id,
      username: updated.username,
      avatar: updated.avatar,
      text: updated.text,
      created_at: updated.created_at,
      edited: true,
      pinned: updated.pinned
    });
  }


  // ===========================================================
  // DELETE MESSAGE
  // ===========================================================

  async deleteMessage(
    session,
    id
  ) {
    if (!id) {
      return;
    }

    const rows =
      this.ctx.storage.sql
        .exec(
          `
          SELECT *
          FROM messages
          WHERE id = ?
          `,
          id
        )
        .toArray();

    const old = rows[0];

    if (!old) {
      return;
    }

    if (
      old.username !==
      session.username
    ) {
      return;
    }

    this.ctx.storage.sql.exec(
      `
      DELETE FROM messages
      WHERE id = ?
      `,
      id
    );

    this.broadcast({
      type: "message_delete",
      id
    });
  }


  // ===========================================================
  // PIN MESSAGE
  // ===========================================================

  async pinMessage(
    session,
    id
  ) {
    if (!id) {
      return;
    }

    const rows =
      this.ctx.storage.sql
        .exec(
          `
          SELECT *
          FROM messages
          WHERE id = ?
          `,
          id
        )
        .toArray();

    const old = rows[0];

    if (!old) {
      return;
    }

    if (
      old.username !==
      session.username
    ) {
      return;
    }

    const pinned =
      !Boolean(old.pinned);

    this.ctx.storage.sql.exec(
      `
      UPDATE messages
      SET pinned = ?
      WHERE id = ?
      `,
      pinned ? 1 : 0,
      id
    );

    const updated = {
      id:
        String(old.id),

      username:
        String(old.username),

      avatar:
        String(old.avatar || ""),

      text:
        String(old.text || ""),

      created_at:
        Number(old.created_at),

      edited:
        Boolean(old.edited),

      pinned
    };

    this.broadcast({
      type: "message_edit",
      message: updated,

      id: updated.id,
      username: updated.username,
      avatar: updated.avatar,
      text: updated.text,
      created_at: updated.created_at,
      edited: updated.edited,
      pinned: updated.pinned
    });
  }


  // ===========================================================
  // HISTORY HTTP ENDPOINT
  // ===========================================================

  async getHistory() {
    return json({
      messages:
        this.getMessages()
    });
  }


  // ===========================================================
  // GET ROOMS
  // ===========================================================

  async getRooms() {
    let rooms =
      await this.ctx.storage.get(
        "rooms"
      );

    if (!Array.isArray(rooms)) {
      rooms = [];
    }

    if (
      !rooms.some(
        room =>
          room.code ===
          "general"
      )
    ) {
      rooms.unshift({
        name: "General",
        code: "general"
      });

      await this.ctx.storage.put(
        "rooms",
        rooms
      );
    }

    return json({
      rooms
    });
  }


  // ===========================================================
  // CREATE ROOM
  // ===========================================================

  async createRoom(request) {
    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          error:
            "Invalid request."
        },
        400
      );
    }

    const name =
      cleanRoomName(
        body.name
      );

    const code =
      cleanRoomCode(
        body.code
      );

    if (!name) {
      return json(
        {
          error:
            "Room name is required."
        },
        400
      );
    }

    if (
      !/^[a-z0-9_-]{2,30}$/.test(
        code
      )
    ) {
      return json(
        {
          error:
            "Invalid room code."
        },
        400
      );
    }

    let rooms =
      await this.ctx.storage.get(
        "rooms"
      );

    if (!Array.isArray(rooms)) {
      rooms = [];
    }

    if (
      rooms.some(
        room =>
          room.code ===
          code
      )
    ) {
      return json(
        {
          error:
            "That room already exists."
        },
        409
      );
    }

    const room = {
      name,
      code
    };

    rooms.push(room);

    await this.ctx.storage.put(
      "rooms",
      rooms
    );

    return json({
      success: true,
      room
    });
  }


  // ===========================================================
  // SEND ONLINE MEMBERS
  // ===========================================================

  async sendMembers() {
    const members = [];

    for (
      const ws of
      this.ctx.getWebSockets()
    ) {
      if (
        ws.readyState !==
        WebSocket.OPEN
      ) {
        continue;
      }

      const session =
        this.getSession(ws);

      if (!session) {
        continue;
      }

      members.push({
        username:
          session.username,

        avatar:
          session.avatar || ""
      });
    }

    this.broadcast({
      type: "members",
      members
    });
  }


  // ===========================================================
  // BROADCAST TO EVERYONE
  // ===========================================================

  broadcast(data) {
    const output =
      JSON.stringify(data);

    const sockets =
      this.ctx.getWebSockets();

    for (
      const ws of sockets
    ) {
      try {
        if (
          ws.readyState ===
          WebSocket.OPEN
        ) {
          ws.send(output);
        }
      } catch (error) {
        console.error(
          "WebSocket send error:",
          error
        );
      }
    }
  }


  // ===========================================================
  // SEND TO ONE SOCKET
  // ===========================================================

  send(ws, data) {
    try {
      if (
        ws.readyState ===
        WebSocket.OPEN
      ) {
        ws.send(
          JSON.stringify(data)
        );
      }
    } catch {}
  }


  // ===========================================================
  // DEV USER LIST
  // ===========================================================

  async getDevUsers() {
    const users = [];

    for (
      const ws of
      this.ctx.getWebSockets()
    ) {
      const session =
        this.getSession(ws);

      if (!session) {
        continue;
      }

      users.push({
        username:
          session.username,

        avatar:
          session.avatar || "",

        room:
          session.room
      });
    }

    return json({
      users
    });
  }


  // ===========================================================
  // DEV ACTION
  // ===========================================================

  async devAction(request) {
    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          error:
            "Invalid request."
        },
        400
      );
    }

    const target =
      String(
        body.target || ""
      ).trim();

    const action =
      String(
        body.action || ""
      );

    let seconds =
      Number(body.seconds) ||
      60;

    seconds =
      Math.max(
        1,
        Math.min(
          seconds,
          86400
        )
      );

    for (
      const ws of
      this.ctx.getWebSockets()
    ) {
      const session =
        this.getSession(ws);

      if (!session) {
        continue;
      }

      if (
        session.username !==
        target
      ) {
        continue;
      }

      if (
        action === "kick"
      ) {
        this.send(ws, {
          type: "error",
          message:
            "You were kicked from the chatroom."
        });

        try {
          ws.close(
            4001,
            "Kicked"
          );
        } catch {}
      }

      if (
        action === "timeout"
      ) {
        this.send(ws, {
          type: "error",
          message:
            `You were timed out for ${seconds} seconds.`
        });

        try {
          ws.close(
            4002,
            "Timed out"
          );
        } catch {}
      }
    }

    return json({
      success: true
    });
  }
}


// =============================================================
// CLEANING FUNCTIONS
// =============================================================

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
    .replace(
      /[^a-z0-9_-]/g,
      ""
    )
    .slice(0, 30);
}


function cleanAvatar(value) {
  const valueString =
    String(value || "")
      .trim();

  if (
    valueString.startsWith(
      "https://"
    ) ||
    valueString.startsWith(
      "http://"
    )
  ) {
    return valueString.slice(
      0,
      500
    );
  }

  return "";
}


// =============================================================
// JSON RESPONSE
// =============================================================

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json",

        "Cache-Control":
          "no-store"
      }
    }
  );
}


// =============================================================
// DEV AUTH
// =============================================================

function isDevRequest(
  request
) {
  const header =
    request.headers.get(
      "Authorization"
    ) || "";

  if (
    !header.startsWith(
      "Bearer "
    )
  ) {
    return false;
  }

  try {
    const token =
      header.slice(7);

    const data =
      JSON.parse(
        atob(token)
      );

    return (
      data.dev === true &&
      data.secret ===
        DEV_PASSKEY
    );
  } catch {
    return false;
  }
}
