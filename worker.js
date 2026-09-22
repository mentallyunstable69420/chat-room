import { DurableObject } from "cloudflare:workers";

const MAX_NAME = 24;
const MAX_MESSAGE = 500;
const HISTORY_LIMIT = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket required", { status: 426 });
      }

      const id = env.CHAT_ROOM.idFromName("public-chat");
      const room = env.CHAT_ROOM.get(id);

      return room.fetch(request);
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
          message TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    });
  }


  async fetch(request) {

    const [client, server] =
      Object.values(new WebSocketPair());

    this.ctx.acceptWebSocket(server);

    const url = new URL(request.url);

    let username =
      url.searchParams.get("name") || "Guest";

    username = username
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, MAX_NAME);

    if (!username) {
      username = "Guest";
    }

    server.serializeAttachment({
      username
    });


    const history = this.ctx.storage.sql
      .exec(`
        SELECT id, username, message, created_at
        FROM messages
        ORDER BY id DESC
        LIMIT ?
      `, HISTORY_LIMIT)
      .toArray()
      .reverse();


    server.send(JSON.stringify({
      type: "history",
      messages: history
    }));


    this.broadcast({
      type: "system",
      message: username + " joined the chat."
    }, server);


    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }


  async webSocketMessage(ws, rawMessage) {

    let data;

    try {
      data = JSON.parse(rawMessage);
    } catch {
      return;
    }

    if (data.type !== "message") {
      return;
    }

    const message = String(data.message || "")
      .trim()
      .slice(0, MAX_MESSAGE);

    if (!message) {
      return;
    }

    const attachment = ws.deserializeAttachment();

    const username =
      attachment?.username || "Guest";

    const createdAt = Date.now();


    this.ctx.storage.sql.exec(
      `
        INSERT INTO messages
        (username, message, created_at)
        VALUES (?, ?, ?)
      `,
      username,
      message,
      createdAt
    );


    this.broadcast({
      type: "message",
      username,
      message,
      created_at: createdAt
    });
  }


  webSocketClose(ws) {

    const attachment =
      ws.deserializeAttachment();

    const username =
      attachment?.username || "Guest";

    this.broadcast({
      type: "system",
      message: username + " left the chat."
    }, ws);
  }


  webSocketError(ws) {
    try {
      ws.close();
    } catch {}
  }


  broadcast(data, except = null) {

    const message = JSON.stringify(data);

    for (const ws of this.ctx.getWebSockets()) {

      if (ws === except) {
        continue;
      }

      try {
        ws.send(message);
      } catch {}
    }
  }
}
