import { DurableObject } from "cloudflare:workers";

const DEV_PASSWORD = "password";

const MAX_NAME = 30;
const MAX_MESSAGE = 500;
const MAX_ROOM_NAME = 40;
const MAX_ROOM_CODE = 40;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* =========================
       ROOM API
    ========================= */

    if (url.pathname === "/api/rooms") {
      const id = env.CHAT_ROOM.idFromName("ROOM_LOBBY");
      const lobby = env.CHAT_ROOM.get(id);

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
       DEV LOGIN
    ========================= */

    if (url.pathname === "/api/dev/login") {
      if (request.method !== "POST") {
        return json({error:"Method not allowed."},405);
      }

      let data;

      try {
        data = await request.json();
      } catch {
        return json({error:"Invalid JSON."},400);
      }

      if (String(data.password || "") !== DEV_PASSWORD) {
        return json({error:"Incorrect passkey."},401);
      }

      /*
       * This token is intentionally simple because the
       * requested passkey is a fixed dev password.
       *
       * IMPORTANT:
       * This is not intended to be a production-grade
       * authentication system.
       */

      const token =
        btoa(
          "dev:" +
          DEV_PASSWORD +
          ":" +
          Date.now()
        );

      return json({
        success:true,
        token
      });
    }


    /* =========================
       DEV API
    ========================= */

    if (
      url.pathname === "/api/dev/users" ||
      url.pathname === "/api/dev/action"
    ) {
      const auth = request.headers.get("Authorization") || "";

      if (!isDevToken(auth)) {
        return json({error:"Developer authorization required."},401);
      }

      const room =
        cleanRoomCode(
          url.searchParams.get("room") || "general"
        );

      const id = env.CHAT_ROOM.idFromName(room);
      const roomDO = env.CHAT_ROOM.get(id);

      return roomDO.fetch(
        new Request(
          "https://internal" + url.pathname + url.search,
          {
            method:request.method,
            headers:request.headers,
            body:request.method === "POST"
              ? await request.text()
              : undefined
          }
        )
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

      const id = env.CHAT_ROOM.idFromName(room);
      const roomDO = env.CHAT_ROOM.get(id);

      return roomDO.fetch(request);
    }


    /* =========================
       WEBSITE
    ========================= */

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found",{status:404});
  }
};


export class ChatRoom extends DurableObject {

  constructor(ctx,env) {
    super(ctx,env);

    this.ctx=ctx;
    this.env=env;

    this.sockets=new Map();

    /*
     * Messages
     */

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


    /*
     * Rooms
     *
     * Only the lobby DO actually uses this table,
     * but creating it everywhere keeps the class safe.
     */

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);


    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO rooms
      (code,name,created_at)
      VALUES ('general','General',?)
    `,Date.now());


    /*
     * Moderation state.
     *
     * A timeout is stored by username.
     */

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS timeouts (
        username TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      )
    `);
  }


  async fetch(request) {

    const url=new URL(request.url);


    /* =========================
       ROOMS
    ========================= */

    if(url.pathname==="/api/rooms"){

      if(request.method==="GET"){
        return this.getRooms();
      }

      if(request.method==="POST"){
        return this.createRoom(request);
      }
    }


    /* =========================
       DEV USERS
    ========================= */

    if(url.pathname==="/api/dev/users"){

      if(!isDevToken(
        request.headers.get("Authorization")||""
      )){
        return json({error:"Unauthorized."},401);
      }

      return this.getDevUsers();
    }


    /* =========================
       DEV ACTION
    ========================= */

    if(url.pathname==="/api/dev/action"){

      if(!isDevToken(
        request.headers.get("Authorization")||""
      )){
        return json({error:"Unauthorized."},401);
      }

      return this.devAction(request);
    }


    /* =========================
       WEBSOCKET
    ========================= */

    if(url.pathname==="/api/ws"){

      if(
        request.headers.get("Upgrade")
        !== "websocket"
      ){
        return new Response(
          "Expected WebSocket",
          {status:426}
        );
      }

      const username=cleanName(
        url.searchParams.get("name")||"Guest"
      );

      const avatar=String(
        url.searchParams.get("avatar")||""
      ).slice(0,500);

      const room=cleanRoomCode(
        url.searchParams.get("room")||"general"
      );


      /*
       * Check whether this user is timed out.
       */

      const timeout=this.ctx.storage.sql.exec(`
        SELECT expires_at
        FROM timeouts
        WHERE username=?
      `,username).toArray();


      if(
        timeout.length &&
        timeout[0].expires_at > Date.now()
      ){
        const remaining=Math.ceil(
          (timeout[0].expires_at-Date.now())/60000
        );

        return new Response(
          "You are timed out for another "+
          remaining+
          " minute(s).",
          {status:403}
        );
      }


      /*
       * Remove expired timeout.
       */

      this.ctx.storage.sql.exec(`
        DELETE FROM timeouts
        WHERE username=?
        AND expires_at <= ?
      `,username,Date.now());


      const pair=new WebSocketPair();

      const client=pair[0];
      const server=pair[1];

      this.ctx.acceptWebSocket(server);


      const user={
        username,
        avatar,
        room,
        joinedAt:Date.now()
      };

      this.sockets.set(server,user);


      /*
       * History
       */

      const history=this.ctx.storage.sql.exec(`
        SELECT
          id,
          username,
          avatar,
          room,
          message,
          created_at,
          pinned
        FROM messages
        WHERE room=?
        ORDER BY id DESC
        LIMIT 100
      `,room)
      .toArray()
      .reverse();


      server.send(JSON.stringify({
        type:"history",
        messages:history
      }));


      /*
       * Room list
       */

      const rooms=this.ctx.storage.sql.exec(`
        SELECT code,name
        FROM rooms
        ORDER BY created_at ASC
      `).toArray();


      server.send(JSON.stringify({
        type:"rooms",
        rooms
      }));


      this.sendMembers();


      this.broadcastRoom({
        type:"member_joined",
        username
      },room,server);


      this.sendMembers();


      return new Response(null,{
        status:101,
        webSocket:client
      });
    }


    return new Response("Not found",{status:404});
  }


  /* =========================
     ROOM LIST
  ========================= */

  getRooms(){

    const rooms=this.ctx.storage.sql.exec(`
      SELECT code,name
      FROM rooms
      ORDER BY created_at ASC
    `).toArray();

    return json({rooms});
  }


  /* =========================
     CREATE ROOM
  ========================= */

  async createRoom(request){

    let data;

    try{
      data=await request.json();
    }catch{
      return json({
        error:"Invalid JSON."
      },400);
    }


    const name=String(
      data.name||""
    )
    .trim()
    .slice(0,MAX_ROOM_NAME);


    let code=String(
      data.code||""
    )
    .trim()
    .toLowerCase()
    .slice(0,MAX_ROOM_CODE);


    if(!name){
      return json({
        error:"Room name is required."
      },400);
    }


    if(!code){
      code=name
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g,"-")
        .replace(/-+/g,"-")
        .replace(/^-|-$/g,"")
        .slice(0,MAX_ROOM_CODE);
    }


    if(!code){
      return json({
        error:"Invalid room code."
      },400);
    }


    const existing=this.ctx.storage.sql.exec(`
      SELECT code
      FROM rooms
      WHERE code=?
    `,code).toArray();


    if(existing.length){
      return json({
        error:"That room already exists."
      },409);
    }


    this.ctx.storage.sql.exec(`
      INSERT INTO rooms
      (code,name,created_at)
      VALUES (?,?,?)
    `,code,name,Date.now());


    return json({
      success:true,
      room:{
        code,
        name
      }
    });
  }


  /* =========================
     DEV USERS
  ========================= */

  getDevUsers(){

    const users=[];

    for(const [ws,user] of this.sockets){

      users.push({
        username:user.username,
        avatar:user.avatar,
        joinedAt:user.joinedAt
      });
    }

    return json({users});
  }


  /* =========================
     DEV ACTIONS
  ========================= */

  async devAction(request){

    let data;

    try{
      data=await request.json();
    }catch{
      return json({
        error:"Invalid JSON."
      },400);
    }


    const action=String(data.action||"");
    const target=String(data.target||"").trim();


    if(!target){
      return json({
        error:"Target user is required."
      },400);
    }


    /*
     * KICK
     */

    if(action==="kick"){

      let found=false;

      for(const [ws,user] of this.sockets){

        if(
          user.username.toLowerCase()
          === target.toLowerCase()
        ){

          found=true;

          try{
            ws.send(JSON.stringify({
              type:"kicked",
              reason:"You were kicked by a developer."
            }));

            ws.close(4001,"Kicked");
          }catch{}

          this.sockets.delete(ws);
        }
      }


      this.sendMembers();


      return json({
        success:true,
        found
      });
    }


    /*
     * TIMEOUT
     */

    if(action==="timeout"){

      const minutes=Math.max(
        1,
        Math.min(
          1440,
          Number(data.minutes)||5
        )
      );


      const expires=Date.now()+
        minutes*60*1000;


      this.ctx.storage.sql.exec(`
        INSERT OR REPLACE INTO timeouts
        (username,expires_at)
        VALUES (?,?)
      `,target,expires);


      for(const [ws,user] of this.sockets){

        if(
          user.username.toLowerCase()
          === target.toLowerCase()
        ){

          try{
            ws.send(JSON.stringify({
              type:"timed_out",
              minutes
            }));

            ws.close(
              4002,
              "Timed out"
            );

          }catch{}

          this.sockets.delete(ws);
        }
      }


      this.sendMembers();


      return json({
        success:true,
        minutes
      });
    }


    /*
     * RENAME
     */

    if(action==="rename"){

      const newName=String(
        data.newName||""
      )
      .trim()
      .slice(0,MAX_NAME);


      if(!newName){
        return json({
          error:"New name is required."
        },400);
      }


      let found=false;


      for(const [ws,user] of this.sockets){

        if(
          user.username.toLowerCase()
          === target.toLowerCase()
        ){

          found=true;

          const oldName=user.username;

          user.username=newName;


          /*
           * Tell that user to reconnect using
           * the new name.
           */

          try{
            ws.send(JSON.stringify({
              type:"renamed",
              oldName,
              newName
            }));
          }catch{}
        }
      }


      this.sendMembers();


      return json({
        success:true,
        found,
        newName
      });
    }


    /*
     * DELETE MESSAGE
     */

    if(action==="delete_message"){

      const id=Number(data.messageId);

      if(!id){
        return json({
          error:"Message ID required."
        },400);
      }


      this.ctx.storage.sql.exec(`
        DELETE FROM messages
        WHERE id=?
        AND room=?
      `,id,data.room||"general");


      this.broadcastRoom({
        type:"delete",
        id
      },data.room||"general");


      return json({
        success:true
      });
    }


    return json({
      error:"Unknown developer action."
    },400);
  }


  /* =========================
     NORMAL CHAT MESSAGES
  ========================= */

  async webSocketMessage(ws,message){

    const user=this.sockets.get(ws);

    if(!user) return;


    /*
     * Check timeout before accepting
     * a new message.
     */

    const timeout=this.ctx.storage.sql.exec(`
      SELECT expires_at
      FROM timeouts
      WHERE username=?
    `,user.username).toArray();


    if(
      timeout.length &&
      timeout[0].expires_at>Date.now()
    ){

      try{
        ws.send(JSON.stringify({
          type:"timed_out",
          minutes:Math.ceil(
            (timeout[0].expires_at-Date.now())/60000
          )
        }));

        ws.close(4002,"Timed out");
      }catch{}

      this.sockets.delete(ws);
      this.sendMembers();
      return;
    }


    let data;

    try{
      data=JSON.parse(message);
    }catch{
      return;
    }


    /* MESSAGE */

    if(data.type==="message"){

      const text=String(
        data.message||""
      )
      .trim()
      .slice(0,MAX_MESSAGE);


      if(!text) return;


      const result=this.ctx.storage.sql.exec(`
        INSERT INTO messages
        (
          username,
          avatar,
          room,
          message,
          created_at,
          pinned
        )
        VALUES (?,?,?,?,?,0)
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


      const row=result[0];


      /*
       * IMPORTANT:
       * The message is nested under "message".
       * This matches index.html.
       */

      this.broadcastRoom({
        type:"message",
        message:row
      },user.room);

      return;
    }


    /* EDIT */

    if(data.type==="edit"){

      const id=Number(data.id);

      const text=String(
        data.message||""
      )
      .trim()
      .slice(0,MAX_MESSAGE);


      if(!id||!text) return;


      this.ctx.storage.sql.exec(`
        UPDATE messages
        SET message=?
        WHERE id=?
        AND username=?
        AND room=?
      `,
      text,
      id,
      user.username,
      user.room
      );


      this.broadcastRoom({
        type:"edit",
        id,
        message:text
      },user.room);

      return;
    }


    /* DELETE */

    if(data.type==="delete"){

      const id=Number(data.id);

      if(!id) return;


      this.ctx.storage.sql.exec(`
        DELETE FROM messages
        WHERE id=?
        AND username=?
        AND room=?
      `,
      id,
      user.username,
      user.room
      );


      this.broadcastRoom({
        type:"delete",
        id
      },user.room);

      return;
    }


    /* PIN */

    if(data.type==="pin"){

      const id=Number(data.id);

      if(!id) return;


      const current=this.ctx.storage.sql.exec(`
        SELECT pinned
        FROM messages
        WHERE id=?
        AND room=?
        AND username=?
      `,
      id,
      user.room,
      user.username
      ).toArray();


      if(!current.length) return;


      const pinned=current[0].pinned?0:1;


      this.ctx.storage.sql.exec(`
        UPDATE messages
        SET pinned=?
        WHERE id=?
        AND room=?
        AND username=?
      `,
      pinned,
      id,
      user.room,
      user.username
      );


      this.broadcastRoom({
        type:"pin",
        id,
        pinned:Boolean(pinned)
      },user.room);
    }
  }


  /* =========================
     SOCKET CLOSED
  ========================= */

  async webSocketClose(ws){

    const user=this.sockets.get(ws);


    if(user){

      this.broadcastRoom({
        type:"member_left",
        username:user.username
      },user.room);
    }


    this.sockets.delete(ws);

    this.sendMembers();
  }


  async webSocketError(ws){

    this.sockets.delete(ws);

    this.sendMembers();
  }


  /* =========================
     MEMBERS
  ========================= */

  sendMembers(){

    const rooms=new Map();


    for(const [ws,user] of this.sockets){

      if(!rooms.has(user.room)){
        rooms.set(user.room,[]);
      }


      rooms.get(user.room).push({
        username:user.username,
        avatar:user.avatar
      });
    }


    for(const [room,members] of rooms){

      this.broadcastRoom({
        type:"members",
        members
      },room);
    }
  }


  /* =========================
     BROADCAST
  ========================= */

  broadcastRoom(data,room,except=null){

    const payload=JSON.stringify(data);


    for(const [ws,user] of this.sockets){

      if(
        user.room===room &&
        ws!==except
      ){

        try{
          ws.send(payload);
        }catch{
          this.sockets.delete(ws);
        }
      }
    }
  }
};


/* =========================
   HELPERS
========================= */

function json(data,status=200){

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers:{
        "Content-Type":"application/json",
        "Cache-Control":"no-store"
      }
    }
  );
}


function cleanName(name){

  return String(name||"Guest")
    .trim()
    .slice(0,MAX_NAME)
    || "Guest";
}


function cleanRoomCode(code){

  return String(code||"general")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g,"-")
    .slice(0,MAX_ROOM_CODE)
    || "general";
}


function isDevToken(header){

  if(!header.startsWith("Bearer "))
    return false;


  const token=header.slice(7);


  try{

    const decoded=atob(token);

    return decoded.startsWith(
      "dev:"+DEV_PASSWORD+":"
    );

  }catch{

    return false;
  }
}
