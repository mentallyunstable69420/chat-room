import { DurableObject } from "cloudflare:workers";

const MAX_NAME = 24;
const MAX_MESSAGE = 500;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/ws") {
      if (
        request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
      ) {
        return new Response("WebSocket required", {
          status: 426
        });
      }

      const room =
        (url.searchParams.get("room") || "general")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "")
          .slice(0, 40);

      if (!room) {
        return new Response("Invalid room", {
          status: 400
        });
      }

      const id = env.CHAT_ROOM.idFromName(room);
      const chat = env.CHAT_ROOM.get(id);

      return chat.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};


export class ChatRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          avatar TEXT,
          message TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          pinned INTEGER DEFAULT 0,
          deleted INTEGER DEFAULT 0
        )
      `);
    });
  }


  async fetch(request) {

    const url = new URL(request.url);

    const room =
      url.searchParams.get("room") || "general";

    let username =
      url.searchParams.get("name") || "Guest";

    let avatar =
      url.searchParams.get("avatar") || "";

    username = username
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, MAX_NAME);

    avatar = avatar.slice(0, 500);


    const [client, server] =
      Object.values(new WebSocketPair());

    this.ctx.acceptWebSocket(server);


    server.serializeAttachment({
      id: crypto.randomUUID(),
      username,
      avatar,
      room,
      admin: false
    });


    /*
     * SEND CHAT HISTORY
     */

    const history =
      this.ctx.storage.sql
        .exec(`
          SELECT
            id,
            username,
            avatar,
            message,
            created_at,
            pinned
          FROM messages
          WHERE deleted = 0
          ORDER BY id DESC
          LIMIT 100
        `)
        .toArray()
        .reverse();


    server.send(
      JSON.stringify({
        type: "history",
        messages: history
      })
    );


    /*
     * UPDATE MEMBERS
     */

    this.sendMembers();


    /*
     * TELL EVERYONE THAT SOMEONE JOINED
     */

    this.broadcast({
      type: "system",
      message: username + " joined the room."
    }, server);


    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }


  async webSocketMessage(ws, raw) {

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }


    const user =
      ws.deserializeAttachment();

    if (!user) return;


    /*
     * =========================
     * SEND MESSAGE
     * =========================
     */

    if (data.type === "message") {

      const message =
        String(data.message || "")
          .trim()
          .slice(0, MAX_MESSAGE);

      if (!message) return;


      const result =
        this.ctx.storage.sql.exec(
          `
            INSERT INTO messages
            (
              username,
              avatar,
              message,
              created_at
            )
            VALUES (?, ?, ?, ?)
          `,
          user.username,
          user.avatar,
          message,
          Date.now()
        );


      const row =
        this.ctx.storage.sql
          .exec(
            `
              SELECT
                id,
                username,
                avatar,
                message,
                created_at,
                pinned
              FROM messages
              WHERE id = ?
            `,
            result.lastInsertRowId
          )
          .one();


      /*
       * IMPORTANT FIX
       *
       * The frontend expects:
       *
       * data.message.id
       * data.message.username
       * data.message.message
       *
       * So we put the database row inside
       * "message".
       */

      this.broadcast({
        type: "message",
        message: row
      });

      return;
    }


    /*
     * =========================
     * EDIT MESSAGE
     * =========================
     */

    if (data.type === "edit") {

      const id = Number(data.id);

      const message =
        String(data.message || "")
          .trim()
          .slice(0, MAX_MESSAGE);

      if (!id || !message) return;


      this.ctx.storage.sql.exec(
        `
          UPDATE messages
          SET message = ?
          WHERE id = ?
          AND username = ?
          AND deleted = 0
        `,
        message,
        id,
        user.username
      );


      this.broadcast({
        type: "edit",
        id,
        message
      });

      return;
    }


    /*
     * =========================
     * DELETE MESSAGE
     * =========================
     */

    if (data.type === "delete") {

      const id = Number(data.id);

      if (!id) return;


      this.ctx.storage.sql.exec(
        `
          UPDATE messages
          SET deleted = 1
          WHERE id = ?
          AND username = ?
        `,
        id,
        user.username
      );


      this.broadcast({
        type: "delete",
        id
      });

      return;
    }


    /*
     * =========================
     * PIN MESSAGE
     * =========================
     */

    if (data.type === "pin") {

      const id = Number(data.id);

      if (!id) return;


      this.ctx.storage.sql.exec(
        `
          UPDATE messages
          SET pinned =
            CASE
              WHEN pinned = 1 THEN 0
              ELSE 1
            END
          WHERE id = ?
        `,
        id
      );


      const row =
        this.ctx.storage.sql
          .exec(
            `
              SELECT pinned
              FROM messages
              WHERE id = ?
            `,
            id
          )
          .one();


      this.broadcast({
        type: "pin",
        id,
        pinned: Boolean(row?.pinned)
      });

      return;
    }


    /*
     * =========================
     * KICK USER
     * =========================
     */

    if (data.type === "kick") {

      if (!user.admin) return;

      for (
        const client
        of this.ctx.getWebSockets()
      ) {

        const target =
          client.deserializeAttachment();

        if (
          target?.username ===
          data.username
        ) {

          client.send(
            JSON.stringify({
              type: "kicked"
            })
          );

          client.close();
        }
      }

      return;
    }


    /*
     * =========================
     * BAN USER
     * =========================
     */

    if (data.type === "ban") {

      if (!user.admin) return;

      const targetName =
        String(data.username || "");

      if (!targetName) return;


      this.ctx.storage.put(
        "ban:" + targetName,
        true
      );


      for (
        const client
        of this.ctx.getWebSockets()
      ) {

        const target =
          client.deserializeAttachment();

        if (
          target?.username === targetName
        ) {
          client.close();
        }
      }

      return;
    }


    /*
     * =========================
     * PRIVATE MESSAGE
     * =========================
     */

    if (data.type === "dm") {

      const targetName =
        String(data.to || "");

      const text =
        String(data.message || "")
          .trim()
          .slice(0, MAX_MESSAGE);

      if (!targetName || !text) return;


      for (
        const client
        of this.ctx.getWebSockets()
      ) {

        const target =
          client.deserializeAttachment();

        if (
          target?.username === targetName
        ) {

          client.send(
            JSON.stringify({
              type: "dm",
              from: user.username,
              message: text,
              created_at: Date.now()
            })
          );
        }
      }

      return;
    }
  }


  /*
   * =========================
   * USER LEFT
   * =========================
   */

  webSocketClose(ws) {

    const user =
      ws.deserializeAttachment();

    if (user) {

      this.broadcast({
        type: "system",
        message:
          user.username +
          " left the room."
      }, ws);

    }

    this.sendMembers();
  }


  webSocketError() {}


  /*
   * =========================
   * MEMBERS
   * =========================
   */

  sendMembers() {

    const members = [];

    for (
      const ws
      of this.ctx.getWebSockets()
    ) {

      const user =
        ws.deserializeAttachment();

      if (user) {

        members.push({
          username: user.username,
          avatar: user.avatar
        });

      }
    }


    this.broadcast({
      type: "members",
      members
    });
  }


  /*
   * =========================
   * BROADCAST
   * =========================
   */

  broadcast(
    data,
    except = null
  ) {

    const text =
      JSON.stringify(data);

    for (
      const ws
      of this.ctx.getWebSockets()
    ) {

      if (ws === except) continue;

      try {
        ws.send(text);
      } catch {}
    }
  }
}
