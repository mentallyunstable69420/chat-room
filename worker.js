import { DurableObject } from "cloudflare:workers";

const DEV_PASSKEY = "password";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // -----------------------------
    // ROOM LIST
    // -----------------------------
    if (url.pathname === "/api/rooms") {
      const lobby = env.CHAT_ROOM.get(
        env.CHAT_ROOM.idFromName("__ROOM_LOBBY__")
      );

      return lobby.fetch(
        new Request("https://internal/api/rooms", {
          method: request.method,
          body:
            request.method === "POST"
              ? await request.text()
              : undefined,
          headers: request.headers
        })
      );
    }

    // -----------------------------
    // DEVELOPER LOGIN
    // -----------------------------
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

    // -----------------------------
    // DEVELOPER USERS
    // -----------------------------
    if (url.pathname === "/api/dev/users") {
      if (!isDevRequest(request)) {
        return json(
          { error: "Unauthorized." },
          401
        );
      }

      const roomCode =
        cleanRoomCode(
          url.searchParams.get("room")
        ) || "general";

      const room = env.CHAT_ROOM.get(
        env.CHAT_ROOM.idFromName(roomCode)
      );

      return room.fetch(
        new Request("https://internal/dev/users")
      );
    }

    // -----------------------------
    // DEVELOPER ACTIONS
    // -----------------------------
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

      let body;

      try {
        body = await request.json();
      } catch {
        return json(
          { error: "Invalid request." },
          400
        );
      }

      const action = String(
        body.action || ""
      );

      const roomCode =
        cleanRoomCode(body.room) ||
        "general";

      // These belong to the lobby.
      if (
        action === "create-room" ||
        action === "delete-room"
      ) {
        const lobby = env.CHAT_ROOM.get(
          env.CHAT_ROOM.idFromName(
            "__ROOM_LOBBY__"
          )
        );

        return lobby.fetch(
          new Request(
            "https://internal/dev/action",
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/json"
              },
              body: JSON.stringify(body)
            }
          )
        );
      }

      const room = env.CHAT_ROOM.get(
        env.CHAT_ROOM.idFromName(roomCode)
      );

      return room.fetch(
        new Request(
          "https://internal/dev/action",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify(body)
          }
        )
      );
    }

    // -----------------------------
    // HISTORY
    // -----------------------------
    if (url.pathname === "/api/history") {
      const roomCode =
        cleanRoomCode(
          url.searchParams.get("room")
        ) || "general";

      const room = env.CHAT_ROOM.get(
        env.CHAT_ROOM.idFromName(roomCode)
      );

      return room.fetch(
        new Request(
          "https://internal/api/history"
        )
      );
    }

    // -----------------------------
    // WEBSOCKET
    // -----------------------------
    if (
      url.pathname === "/api/ws" &&
      request.method === "GET"
    ) {
      const upgrade =
        request.headers
          .get("Upgrade")
          ?.toLowerCase();

      if (upgrade !== "websocket") {
        return new Response(
          "WebSocket upgrade required.",
          {
            status: 426,
            headers: {
              "Content-Type":
                "text/plain"
            }
          }
        );
      }

      const roomCode =
        cleanRoomCode(
          url.searchParams.get("room")
        ) || "general";

      const name =
        cleanName(
          url.searchParams.get("name")
        ) || "Guest";

      const avatar = cleanAvatar(
        url.searchParams.get("avatar")
      );

      const devToken =
        url.searchParams.get("devToken") ||
        "";

      const isDev =
        isDevToken(devToken);

      // Check that custom rooms actually exist.
      if (roomCode !== "general") {
        const lobby = env.CHAT_ROOM.get(
          env.CHAT_ROOM.idFromName(
            "__ROOM_LOBBY__"
          )
        );

        const check =
          await lobby.fetch(
            new Request(
              "https://internal/api/rooms?check=" +
                encodeURIComponent(roomCode)
            )
          );

        const data =
          await check.json();

        if (!data.exists) {
          return new Response(
            "Room not found.",
            { status: 404 }
          );
        }
      }

      const room = env.CHAT_ROOM.get(
        env.CHAT_ROOM.idFromName(roomCode)
      );

      /*
       * IMPORTANT:
       *
       * Do NOT create a new Request here.
       *
       * Passing the original request preserves
       * Cloudflare's WebSocket upgrade.
       */
      return room.fetch(request);
    }

    // -----------------------------
    // WEBSITE FILES
    // -----------------------------
    return env.ASSETS.fetch(request);
  }
};


// ============================================================
// CHAT ROOM DURABLE OBJECT
// ============================================================

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map();
    this.ready = false;

    // Restore existing WebSocket sessions
    // after Durable Object hibernation.
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
  }

  // ==========================================================
  // DATABASE SETUP
  // ==========================================================

  async setup() {
    if (this.ready) {
      return;
    }

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL DEFAULT 'Guest',
        avatar TEXT DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT 0,
        edited INTEGER DEFAULT 0,
        pinned INTEGER DEFAULT 0,
        is_dev_generated INTEGER DEFAULT 0
      )
    `);

    let columns =
      this.ctx.storage.sql
        .exec(
          "PRAGMA table_info(messages)"
        )
        .toArray()
        .map(row =>
          String(row.name)
        );

    const addColumn = (
      name,
      sql
    ) => {
      if (!columns.includes(name)) {
        this.ctx.storage.sql.exec(sql);
        columns.push(name);
      }
    };

    // Old database compatibility.
    addColumn(
      "username",
      `
      ALTER TABLE messages
      ADD COLUMN username
      TEXT NOT NULL DEFAULT 'Guest'
      `
    );

    addColumn(
      "avatar",
      `
      ALTER TABLE messages
      ADD COLUMN avatar
      TEXT DEFAULT ''
      `
    );

    if (!columns.includes("text")) {
      this.ctx.storage.sql.exec(
        `
        ALTER TABLE messages
        ADD COLUMN text
        TEXT NOT NULL DEFAULT ''
        `
      );

      if (
        columns.includes("message")
      ) {
        this.ctx.storage.sql.exec(
          `
          UPDATE messages
          SET text = message
          WHERE text = ''
          AND message IS NOT NULL
          `
        );
      }

      if (
        columns.includes("content")
      ) {
        this.ctx.storage.sql.exec(
          `
          UPDATE messages
          SET text = content
          WHERE text = ''
          AND content IS NOT NULL
          `
        );
      }

      columns.push("text");
    }

    if (
      !columns.includes(
        "created_at"
      )
    ) {
      this.ctx.storage.sql.exec(
        `
        ALTER TABLE messages
        ADD COLUMN created_at
        INTEGER NOT NULL DEFAULT 0
        `
      );

      if (
        columns.includes(
          "timestamp"
        )
      ) {
        this.ctx.storage.sql.exec(
          `
          UPDATE messages
          SET created_at = timestamp
          WHERE created_at = 0
          AND timestamp IS NOT NULL
          `
        );
      }

      columns.push(
        "created_at"
      );
    }

    addColumn(
      "edited",
      `
      ALTER TABLE messages
      ADD COLUMN edited
      INTEGER DEFAULT 0
      `
    );

    addColumn(
      "pinned",
      `
      ALTER TABLE messages
      ADD COLUMN pinned
      INTEGER DEFAULT 0
      `
    );

    addColumn(
      "is_dev_generated",
      `
      ALTER TABLE messages
      ADD COLUMN is_dev_generated
      INTEGER DEFAULT 0
      `
    );

    this.ready = true;
  }

  // ==========================================================
  // DURABLE OBJECT ROUTER
  // ==========================================================

  async fetch(request) {
    await this.setup();

    const url =
      new URL(request.url);

    // IMPORTANT:
    // Accept both paths so the original
    // WebSocket request can be passed through.
    if (
      url.pathname === "/api/ws" ||
      url.pathname === "/ws"
    ) {
      return this.connect(url);
    }

    if (
      url.pathname ===
      "/api/history"
    ) {
      return json({
        messages:
          this.getMessages()
      });
    }

    if (
      url.pathname === "/api/rooms" &&
      request.method === "GET"
    ) {
      return this.getRooms(url);
    }

    if (
      url.pathname === "/api/rooms" &&
      request.method === "POST"
    ) {
      return this.createRoom(
        request
      );
    }

    if (
      url.pathname === "/dev/users"
    ) {
      return this.getDevUsers();
    }

    if (
      url.pathname ===
      "/dev/action"
    ) {
      return this.devAction(
        request
      );
    }

    return new Response(
      "Not found",
      { status: 404 }
    );
  }

  // ==========================================================
  // WEBSOCKET CONNECTION
  // ==========================================================

  async connect(url) {
    const room =
      cleanRoomCode(
        url.searchParams.get(
          "room"
        )
      ) || "general";

    const username =
      cleanName(
        url.searchParams.get(
          "name"
        )
      ) || "Guest";

    const avatar =
      cleanAvatar(
        url.searchParams.get(
          "avatar"
        )
      );

    // FIX: The frontend sends devToken, so
    // recognize that token here as well.
    const isDev =
      url.searchParams.get("dev") === "1" ||
      isDevToken(
        url.searchParams.get("devToken") || ""
      );

    const pair =
      new WebSocketPair();

    const client =
      pair[0];

    const server =
      pair[1];

    const session = {
      username,
      avatar,
      room,
      isDev,
      joinedAt: Date.now(),
      sessionId:
        crypto.randomUUID(),
      lastMessageAt: 0
    };

    // FIX: Accept the WebSocket first.
    // Cloudflare's Hibernation API uses the accepted
    // server WebSocket for the connection lifecycle.
    this.ctx.acceptWebSocket(
      server
    );

    // Persist session through
    // Durable Object hibernation.
    server.serializeAttachment(
      session
    );

    this.sessions.set(
      server,
      session
    );

    // Immediately send chat history.
    try {
      server.send(
        JSON.stringify({
          type: "history",
          messages:
            this.getMessages()
        })
      );
    } catch {}

    // Update online users.
    await this.sendMembers();

    return new Response(
      null,
      {
        status: 101,
        webSocket: client
      }
    );
  }

  // ==========================================================
  // WEBSOCKET MESSAGE HANDLER
  // ==========================================================

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
      data =
        typeof message ===
        "string"
          ? JSON.parse(message)
          : JSON.parse(
              new TextDecoder()
                .decode(message)
            );
    } catch {
      this.send(
        ws,
        {
          type: "error",
          message:
            "Invalid message."
        }
      );

      return;
    }

    const action =
      data.action ||
      data.type;

    if (
      action === "message"
    ) {
      await this.sendMessage(
        session,
        data.text ??
          data.message
      );

      return;
    }

    if (
      action === "edit"
    ) {
      await this.editMessage(
        session,
        data.id,
        data.text ??
          data.message
      );

      return;
    }

    if (
      action === "delete"
    ) {
      await this.deleteMessage(
        session,
        data.id
      );

      return;
    }

    if (
      action === "pin"
    ) {
      await this.pinMessage(
        session,
        data.id
      );

      return;
    }
  }

  // ==========================================================
  // WEBSOCKET CLOSE
  // ==========================================================

  webSocketClose(ws) {
    this.sessions.delete(ws);

    this.sendMembers();
  }

  webSocketError(ws) {
    this.sessions.delete(ws);

    this.sendMembers();
  }

  // ==========================================================
  // SESSION
  // ==========================================================

  getSession(ws) {
    try {
      const session =
        ws.deserializeAttachment();

      if (session) {
        return session;
      }
    } catch {}

    return this.sessions.get(ws);
  }

  // ==========================================================
  // GET MESSAGES
  // ==========================================================

  getMessages() {
    const rows =
      this.ctx.storage.sql
        .exec(
          `
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
          `
        )
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
          row.avatar ||
            ""
        ),

      text:
        String(
          row.text ||
            ""
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

  // ==========================================================
  // SEND MESSAGE
  // ==========================================================

  async sendMessage(
    session,
    text,
    custom = {}
  ) {
    text =
      String(
        text || ""
      ).trim();

    if (
      !text ||
      text.length > 2000
    ) {
      return;
    }

    const now =
      Date.now();

    const slow =
      Number(
        (
          await this.ctx.storage.get(
            "slowMode"
          )
        ) || 0
      );

    if (
      !session.isDev &&
      slow > 0 &&
      now -
        session.lastMessageAt <
        slow * 1000
    ) {
      this.sendToSession(
        session,
        {
          type: "error",
          message:
            `Slow mode: wait ${Math.ceil(
              (
                slow * 1000 -
                (
                  now -
                  session.lastMessageAt
                )
              ) /
                1000
            )} seconds.`
        }
      );

      return;
    }

    const locked =
      Boolean(
        await this.ctx.storage.get(
          "locked"
        )
      );

    if (
      locked &&
      !session.isDev
    ) {
      this.sendToSession(
        session,
        {
          type: "error",
          message:
            "This room is currently locked."
        }
      );

      return;
    }

    session.lastMessageAt =
      now;

    const createdAt =
      Number(
        custom.created_at
      ) || now;

    const message = {
      id:
        crypto.randomUUID(),

      username:
        cleanName(
          custom.username ||
            session.username
        ) || "Guest",

      avatar:
        cleanAvatar(
          custom.avatar ||
            session.avatar
        ),

      text,

      created_at:
        createdAt,

      edited: false,

      pinned: false
    };

    this.ctx.storage.sql.exec(
      `
      INSERT INTO messages(
        id,
        username,
        avatar,
        text,
        created_at,
        edited,
        pinned,
        is_dev_generated
      )
      VALUES(
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )
      `,
      message.id,
      message.username,
      message.avatar,
      message.text,
      message.created_at,
      0,
      0,
      custom.devGenerated
        ? 1
        : 0
    );

    this.broadcast({
      type: "message",
      message
    });
  }

  // ==========================================================
  // EDIT MESSAGE
  // ==========================================================

  async editMessage(
    session,
    id,
    text
  ) {
    text =
      String(
        text || ""
      ).trim();

    if (
      !id ||
      !text ||
      text.length > 2000
    ) {
      return;
    }

    const old =
      this.ctx.storage.sql
        .exec(
          "SELECT * FROM messages WHERE id=?",
          id
        )
        .toArray()[0];

    if (!old) {
      return;
    }

    if (
      !session.isDev &&
      old.username !==
        session.username
    ) {
      return;
    }

    this.ctx.storage.sql.exec(
      `
      UPDATE messages
      SET text = ?, edited = 1
      WHERE id = ?
      `,
      text,
      id
    );

    const updated = {
      id:
        String(old.id),

      username:
        String(
          old.username
        ),

      avatar:
        String(
          old.avatar ||
            ""
        ),

      text,

      created_at:
        Number(
          old.created_at
        ),

      edited: true,

      pinned:
        Boolean(
          old.pinned
        )
    };

    this.broadcast({
      type:
        "message_edit",
      message:
        updated,
      id:
        updated.id
    });
  }

  // ==========================================================
  // DELETE MESSAGE
  // ==========================================================

  async deleteMessage(
    session,
    id
  ) {
    if (!id) {
      return;
    }

    const old =
      this.ctx.storage.sql
        .exec(
          "SELECT * FROM messages WHERE id=?",
          id
        )
        .toArray()[0];

    if (!old) {
      return;
    }

    if (
      !session.isDev &&
      old.username !==
        session.username
    ) {
      return;
    }

    this.ctx.storage.sql.exec(
      "DELETE FROM messages WHERE id=?",
      id
    );

    this.broadcast({
      type:
        "message_delete",
      id
    });
  }

  // ==========================================================
  // PIN MESSAGE
  // ==========================================================

  async pinMessage(
    session,
    id
  ) {
    if (!id) {
      return;
    }

    const old =
      this.ctx.storage.sql
        .exec(
          "SELECT * FROM messages WHERE id=?",
          id
        )
        .toArray()[0];

    if (!old) {
      return;
    }

    if (
      !session.isDev &&
      old.username !==
        session.username
    ) {
      return;
    }

    const pinned =
      !Boolean(
        old.pinned
      );

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
        String(
          old.username
        ),

      avatar:
        String(
          old.avatar ||
            ""
        ),

      text:
        String(
          old.text ||
            ""
        ),

      created_at:
        Number(
          old.created_at
        ),

      edited:
        Boolean(
          old.edited
        ),

      pinned
    };

    this.broadcast({
      type:
        "message_edit",
      message:
        updated,
      id:
        updated.id
    });
  }

  // ==========================================================
  // SEND TO ONE USER
  // ==========================================================

  sendToSession(
    session,
    payload
  ) {
    for (
      const ws of
      this.ctx.getWebSockets()
    ) {
      const current =
        this.getSession(ws);

      if (
        current &&
        current.sessionId ===
          session.sessionId
      ) {
        this.send(
          ws,
          payload
        );

        return;
      }
    }
  }

  // ==========================================================
  // SEND
  // ==========================================================

  send(
    ws,
    payload
  ) {
    try {
      if (
        ws.readyState ===
        WebSocket.OPEN
      ) {
        ws.send(
          JSON.stringify(
            payload
          )
        );
      }
    } catch {}
  }

  // ==========================================================
  // BROADCAST
  // ==========================================================

  broadcast(payload) {
    const encoded =
      JSON.stringify(
        payload
      );

    for (
      const ws of
      this.ctx.getWebSockets()
    ) {
      try {
        if (
          ws.readyState ===
          WebSocket.OPEN
        ) {
          ws.send(
            encoded
          );
        }
      } catch {}
    }
  }

  // ==========================================================
  // ONLINE MEMBERS
  // ==========================================================

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
          session.avatar ||
          ""
      });
    }

    this.broadcast({
      type:
        "members",
      members
    });
  }

  // ==========================================================
  // DEVELOPER USER LIST
  // ==========================================================

  async getDevUsers() {
    const users = [];

    for (
      const ws of
      this.ctx.getWebSockets()
    ) {
      const session =
        this.getSession(ws);

      if (session) {
        users.push({
          username:
            session.username,

          avatar:
            session.avatar ||
            "",

          room:
            session.room
        });
      }
    }

    return json({
      users
    });
  }

  // ==========================================================
  // DEVELOPER ACTIONS
  // ==========================================================

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

    const action =
      String(
        body.action || ""
      );

    if (
      action ===
      "create-room"
    ) {
      return this.createDevRoom(
        body
      );
    }

    if (
      action ===
      "delete-room"
    ) {
      return this.deleteDevRoom(
        body
      );
    }

    // Send a message with
    // a custom username/avatar/time.
    if (
      action ===
      "send-as"
    ) {
      await this.sendMessage(
        {
          username:
            "Developer",
          avatar: "",
          isDev: true,
          lastMessageAt: 0
        },
        body.text,
        {
          username:
            body.username,

          avatar:
            body.avatar,

          created_at:
            body.created_at,

          devGenerated:
            true
        }
      );

      return json({
        success: true
      });
    }

    // Announcement
    if (
      action ===
      "announcement"
    ) {
      const text =
        String(
          body.text || ""
        )
          .trim()
          .slice(0, 1000);

      if (text) {
        this.broadcast({
          type:
            "announcement",
          text
        });
      }

      return json({
        success: true
      });
    }

    // Effects
    if (
      action ===
      "effect"
    ) {
      this.broadcast({
        type:
          "effect",
        effect:
          String(
            body.effect ||
              "shake"
          )
      });

      return json({
        success: true
      });
    }

    // Clear room
    if (
      action ===
      "clear-room"
    ) {
      this.ctx.storage.sql.exec(
        "DELETE FROM messages"
      );

      this.broadcast({
        type:
          "history",
        messages: []
      });

      return json({
        success: true
      });
    }

    // Lock
    if (
      action ===
      "lock-room"
    ) {
      await this.ctx.storage.put(
        "locked",
        true
      );

      this.broadcast({
        type:
          "announcement",
        text:
          "This room has been locked by a developer."
      });

      return json({
        success: true
      });
    }

    // Unlock
    if (
      action ===
      "unlock-room"
    ) {
      await this.ctx.storage.delete(
        "locked"
      );

      this.broadcast({
        type:
          "announcement",
        text:
          "This room has been unlocked."
      });

      return json({
        success: true
      });
    }

    // Slow mode
    if (
      action ===
      "slow-mode"
    ) {
      const seconds =
        Math.max(
          0,
          Math.min(
            300,
            Number(
              body.seconds
            ) || 0
          )
        );

      if (seconds) {
        await this.ctx.storage.put(
          "slowMode",
          seconds
        );
      } else {
        await this.ctx.storage.delete(
          "slowMode"
        );
      }

      return json({
        success: true,
        seconds
      });
    }

    // Kick / timeout
    if (
      action === "kick" ||
      action === "timeout"
    ) {
      const target =
        cleanName(
          body.target
        );

      const seconds =
        Math.max(
          1,
          Math.min(
            86400,
            Number(
              body.seconds
            ) || 60
          )
        );

      for (
        const ws of
        this.ctx.getWebSockets()
      ) {
        const session =
          this.getSession(ws);

        if (
          !session ||
          session.username !==
            target
        ) {
          continue;
        }

        this.send(
          ws,
          {
            type:
              "error",
            message:
              action ===
              "kick"
                ? "You were kicked from the chatroom."
                : `You were timed out for ${seconds} seconds.`
          }
        );

        try {
          ws.close(
            action ===
              "kick"
              ? 4001
              : 4002,

            action ===
              "kick"
              ? "Kicked"
              : "Timed out"
          );
        } catch {}
      }

      return json({
        success: true
      });
    }

    return json(
      {
        error:
          "Unknown developer action."
      },
      400
    );
  }

  // ==========================================================
  // ROOMS
  // ==========================================================

  async getRooms(url) {
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

    const check =
      url.searchParams.get(
        "check"
      );

    if (check) {
      return json({
        exists:
          rooms.some(
            room =>
              room.code ===
              cleanRoomCode(
                check
              )
          )
      });
    }

    return json({
      rooms
    });
  }

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

  async createDevRoom(body) {
    const name =
      cleanRoomName(
        body.name
      );

    const code =
      cleanRoomCode(
        body.code
      );

    if (
      !name ||
      !/^[a-z0-9_-]{2,30}$/.test(
        code
      )
    ) {
      return json(
        {
          error:
            "Invalid room."
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

  async deleteDevRoom(body) {
    const code =
      cleanRoomCode(
        body.room
      );

    if (
      !code ||
      code === "general"
    ) {
      return json(
        {
          error:
            "That room cannot be deleted."
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

    const next =
      rooms.filter(
        room =>
          room.code !==
          code
      );

    await this.ctx.storage.put(
      "rooms",
      next
    );

    return json({
      success: true
    });
  }
}


// ============================================================
// HELPERS
// ============================================================

function cleanName(v) {
  return String(v || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 24);
}

function cleanRoomName(v) {
  return String(v || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 40);
}

function cleanRoomCode(v) {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(
      /[^a-z0-9_-]/g,
      ""
    )
    .slice(0, 30);
}

function cleanAvatar(v) {
  const s =
    String(v || "").trim();

  if (
    s.startsWith(
      "https://"
    ) ||
    s.startsWith(
      "http://"
    )
  ) {
    return s.slice(0, 500);
  }

  return "";
}

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

function isDevToken(token) {
  if (!token) {
    return false;
  }

  try {
    const data =
      JSON.parse(
       
