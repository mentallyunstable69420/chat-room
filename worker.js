import { DurableObject } from "cloudflare:workers";

const MAX_NAME = 24;
const MAX_MESSAGE = 500;
const MAX_ROOM_NAME = 40;
const MAX_ROOM_CODE = 40;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        /* =========================
           ROOM LIST API
        ========================= */

        if (url.pathname === "/api/rooms") {
            const lobbyId = env.CHAT_ROOM.idFromName("ROOM_LOBBY");
            const lobby = env.CHAT_ROOM.get(lobbyId);

            return lobby.fetch(
                new Request("https://internal/api/rooms", {
                    method: request.method,
                    headers: request.headers,
                    body: request.method === "POST"
                        ? await request.text()
                        : undefined
                })
            );
        }

        /* =========================
           WEBSOCKET
        ========================= */

        if (url.pathname === "/api/ws") {
            const room =
                cleanRoomCode(
                    url.searchParams.get("room") || "general"
                );

            const id =
                env.CHAT_ROOM.idFromName(room);

            const stub =
                env.CHAT_ROOM.get(id);

            return stub.fetch(request);
        }

        /* =========================
           STATIC WEBSITE
        ========================= */

        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("Not found", {
            status: 404
        });
    }
};


export class ChatRoom extends DurableObject {

    constructor(ctx, env) {
        super(ctx, env);

        this.ctx = ctx;
        this.env = env;

        this.sockets = new Map();

        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                avatar TEXT,
                room TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                pinned INTEGER DEFAULT 0
            )
        `);

        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS rooms (
                code TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
        `);

        /* Make sure General always exists. */
        this.ctx.storage.sql.exec(`
            INSERT OR IGNORE INTO rooms
            (code, name, created_at)
            VALUES ('general', 'General', ?)
        `, Date.now());
    }


    async fetch(request) {

        const url = new URL(request.url);

        /* =========================
           ROOM API
        ========================= */

        if (url.pathname === "/api/rooms") {

            if (request.method === "GET") {
                return this.getRooms();
            }

            if (request.method === "POST") {
                return this.createRoomFromAPI(request);
            }
        }

        /* =========================
           WEBSOCKET
        ========================= */

        if (url.pathname === "/api/ws") {

            const upgrade =
                request.headers.get("Upgrade");

            if (upgrade !== "websocket") {
                return new Response(
                    "Expected WebSocket",
                    { status: 426 }
                );
            }

            const url = new URL(request.url);

            const username =
                cleanName(
                    url.searchParams.get("name") || "Guest"
                );

            const avatar =
                String(
                    url.searchParams.get("avatar") || ""
                ).slice(0, 500);

            const room =
                cleanRoomCode(
                    url.searchParams.get("room") || "general"
                );

            const pair =
                new WebSocketPair();

            const client = pair[0];
            const server = pair[1];

            this.ctx.acceptWebSocket(server);

            const user = {
                username,
                avatar,
                room,
                joinedAt: Date.now()
            };

            this.sockets.set(server, user);

            /* Send existing messages. */
            const history =
                this.ctx.storage.sql.exec(`
                    SELECT
                        id,
                        username,
                        avatar,
                        room,
                        message,
                        created_at,
                        pinned
                    FROM messages
                    WHERE room = ?
                    ORDER BY id DESC
                    LIMIT 100
                `, room).toArray().reverse();

            server.send(JSON.stringify({
                type: "history",
                messages: history
            }));

            /* Send rooms. */
            const rooms =
                this.ctx.storage.sql.exec(`
                    SELECT code, name
                    FROM rooms
                    ORDER BY created_at ASC
                `).toArray();

            server.send(JSON.stringify({
                type: "rooms",
                rooms
            }));

            this.sendMembers();

            this.broadcastRoom({
                type: "member_joined",
                username
            }, room, server);

            this.sendMembers();

            return new Response(null, {
                status: 101,
                webSocket: client
            });
        }

        return new Response("Not found", {
            status: 404
        });
    }


    /* =========================
       GET ROOMS
    ========================= */

    getRooms() {

        const rooms =
            this.ctx.storage.sql.exec(`
                SELECT code, name
                FROM rooms
                ORDER BY created_at ASC
            `).toArray();

        return Response.json({
            rooms
        });
    }


    /* =========================
       CREATE ROOM
    ========================= */

    async createRoomFromAPI(request) {

        let data;

        try {
            data = await request.json();
        } catch {
            return Response.json(
                { error: "Invalid JSON" },
                { status: 400 }
            );
        }

        const name =
            String(data.name || "")
                .trim()
                .slice(0, MAX_ROOM_NAME);

        let code =
            String(data.code || "")
                .trim()
                .toLowerCase()
                .slice(0, MAX_ROOM_CODE);

        if (!name) {
            return Response.json(
                { error: "Room name is required." },
                { status: 400 }
            );
        }

        if (!code) {
            code =
                name
                    .toLowerCase()
                    .replace(/[^a-z0-9_-]/g, "-")
                    .replace(/-+/g, "-")
                    .replace(/^-|-$/g, "")
                    .slice(0, MAX_ROOM_CODE);
        }

        if (!code) {
            return Response.json(
                { error: "Invalid room code." },
                { status: 400 }
            );
        }

        const existing =
            this.ctx.storage.sql.exec(`
                SELECT code, name
                FROM rooms
                WHERE code = ?
            `, code).toArray();

        if (existing.length) {
            return Response.json(
                {
                    error: "That room already exists."
                },
                { status: 409 }
            );
        }

        this.ctx.storage.sql.exec(`
            INSERT INTO rooms
            (code, name, created_at)
            VALUES (?, ?, ?)
        `, code, name, Date.now());

        const room = {
            code,
            name
        };

        /*
         * Tell every connected user about the new room.
         */
        this.broadcastAll({
            type: "room_created",
            room
        });

        return Response.json({
            success: true,
            room
        });
    }


    /* =========================
       WEBSOCKET MESSAGE
    ========================= */

    async webSocketMessage(ws, message) {

        const user =
            this.sockets.get(ws);

        if (!user) return;

        let data;

        try {
            data =
                JSON.parse(message);
        } catch {
            return;
        }

        /* =========================
           SEND MESSAGE
        ========================= */

        if (data.type === "message") {

            const text =
                String(data.message || "")
                    .trim()
                    .slice(0, MAX_MESSAGE);

            if (!text) return;

            const result =
                this.ctx.storage.sql.exec(`
                    INSERT INTO messages
                    (
                        username,
                        avatar,
                        room,
                        message,
                        created_at,
                        pinned
                    )
                    VALUES (?, ?, ?, ?, ?, 0)
                    RETURNING
                        id,
                        username,
                        avatar,
                        room,
                        message,
                        created_at,
                        pinned
                `,
                user.username,
                user.avatar,
                user.room,
                text,
                Date.now()
                ).toArray();

            const row = result[0];

            /*
             * IMPORTANT:
             * The frontend expects data.message
             * to be the entire message object.
             */
            this.broadcastRoom({
                type: "message",
                message: row
            }, user.room);

            return;
        }


        /* =========================
           EDIT
        ========================= */

        if (data.type === "edit") {

            const id =
                Number(data.id);

            const text =
                String(data.message || "")
                    .trim()
                    .slice(0, MAX_MESSAGE);

            if (!id || !text) return;

            this.ctx.storage.sql.exec(`
                UPDATE messages
                SET message = ?
                WHERE id = ?
                AND username = ?
                AND room = ?
            `,
            text,
            id,
            user.username,
            user.room
            );

            this.broadcastRoom({
                type: "edit",
                id,
                message: text
            }, user.room);

            return;
        }


        /* =========================
           DELETE
        ========================= */

        if (data.type === "delete") {

            const id =
                Number(data.id);

            if (!id) return;

            this.ctx.storage.sql.exec(`
                DELETE FROM messages
                WHERE id = ?
                AND username = ?
                AND room = ?
            `,
            id,
            user.username,
            user.room
            );

            this.broadcastRoom({
                type: "delete",
                id
            }, user.room);

            return;
        }


        /* =========================
           PIN
        ========================= */

        if (data.type === "pin") {

            const id =
                Number(data.id);

            if (!id) return;

            const current =
                this.ctx.storage.sql.exec(`
                    SELECT pinned
                    FROM messages
                    WHERE id = ?
                    AND room = ?
                    AND username = ?
                `,
                id,
                user.room,
                user.username
                ).toArray();

            if (!current.length) return;

            const pinned =
                current[0].pinned ? 0 : 1;

            this.ctx.storage.sql.exec(`
                UPDATE messages
                SET pinned = ?
                WHERE id = ?
                AND room = ?
                AND username = ?
            `,
            pinned,
            id,
            user.room,
            user.username
            );

            this.broadcastRoom({
                type: "pin",
                id,
                pinned: Boolean(pinned)
            }, user.room);

            return;
        }
    }


    /* =========================
       CLOSE
    ========================= */

    async webSocketClose(ws) {

        const user =
            this.sockets.get(ws);

        if (user) {

            this.broadcastRoom({
                type: "member_left",
                username: user.username
            }, user.room);
        }

        this.sockets.delete(ws);

        this.sendMembers();
    }


    /* =========================
       ERROR
    ========================= */

    async webSocketError(ws) {

        this.sockets.delete(ws);

        this.sendMembers();
    }


    /* =========================
       SEND MEMBERS
    ========================= */

    sendMembers() {

        const rooms =
            new Map();

        for (const [ws, user] of this.sockets) {

            if (!rooms.has(user.room)) {
                rooms.set(user.room, []);
            }

            rooms.get(user.room).push({
                username: user.username,
                avatar: user.avatar
            });
        }

        for (const [room, members] of rooms) {

            this.broadcastRoom({
                type: "members",
                members
            }, room);
        }
    }


    /* =========================
       BROADCAST TO ROOM
    ========================= */

    broadcastRoom(data, room, except = null) {

        const payload =
            JSON.stringify(data);

        for (const [ws, user] of this.sockets) {

            if (
                user.room === room &&
                ws !== except
            ) {
                try {
                    ws.send(payload);
                } catch {
                    this.sockets.delete(ws);
                }
            }
        }
    }


    /* =========================
       BROADCAST EVERYONE
    ========================= */

    broadcastAll(data) {

        const payload =
            JSON.stringify(data);

        for (const ws of this.sockets.keys()) {

            try {
                ws.send(payload);
            } catch {
                this.sockets.delete(ws);
            }
        }
    }
}


/* =========================
   HELPERS
========================= */

function cleanName(name) {

    return String(name || "Guest")
        .trim()
        .slice(0, MAX_NAME) || "Guest";
}


function cleanRoomCode(code) {

    return String(code || "general")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .slice(0, MAX_ROOM_CODE) || "general";
}
