/* =============================================================================
 *  worker.js — 五子棋 · 联机对战服务端
 *  Cloudflare Worker + Durable Objects
 *
 *  职责：
 *   1. 托管静态站点（public/ 里的 index.html），并在 HTML 中自动注入
 *      联机客户端脚本 <script src="/__mp.js">，无需手改你的 index.html。
 *   2. 提供 WebSocket 接口 /ws，做实时对战中继。
 *   3. 权威判定：落子合法性（轮次 / 占位 / 边界）、胜负（五连）。
 *   4. 房间系统：快速匹配、私人房间（房间号）、断线重连、再来一局、认输/掉线判负。
 *
 *  架构：
 *   - GameRoom（Durable Object）：一个对局房间 = 一个实例（按房间号寻址）。
 *     使用 WebSocket Hibernation API + 存储持久化，掉电/休眠后仍可恢复、重连。
 *   - Matchmaker（Durable Object，全局单例）：维护“正在等人”的开放房间队列，
 *     供快速匹配配对。
 * ========================================================================== */

import { DurableObject } from "cloudflare:workers";

/* ----------------------------- 常量 ----------------------------- */
const BOUND = 1000;          // 坐标上限（防止恶意巨量占位），|x|,|y| ≤ BOUND
const FORFEIT_MS = 30_000;   // 对局中掉线后的判负宽限（毫秒），期间可重连
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混字符 I O 0 1
const ROLE_FIRST = "h";      // 先手执蓝（与客户端配色一致：h=蓝, a=灰）
const ROLE_SECOND = "a";

const other = (r) => (r === ROLE_FIRST ? ROLE_SECOND : ROLE_FIRST);

function randCode(n = 5) {
  let s = "";
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return s;
}
function randToken() {
  return crypto.randomUUID().replace(/-/g, "");
}
function freshGame(first = ROLE_FIRST) {
  return {
    board: {},          // "x,y" -> role
    history: [],        // [ [x,y,role], ... ]
    turn: first,        // 当前该谁落子（角色）
    over: false,
    winner: null,       // 角色 or null
    line: null,         // 连五坐标 [[x,y]...] or null
    phase: "lobby",     // 'lobby' | 'playing' | 'over'
    firstMover: first,  // 本局先手角色（每次再来一局交替）
    rematch: {},        // { h:true, a:true }
    pendingForfeit: null, // 掉线一方的角色（等待宽限计时）
  };
}

/* 胜负判定：在 (x,y) 落下 who 后，是否形成 ≥5 连。返回连子坐标或 null。
 * board 为对象，键 "x,y"。与前端 Engine.checkWin 行为一致（freestyle，≥5 即胜）。*/
function checkWin(board, x, y, who) {
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of DIRS) {
    let cnt = 1;
    let nx = x + dx, ny = y + dy;
    while (board[nx + "," + ny] === who) { cnt++; nx += dx; ny += dy; }
    nx = x - dx; ny = y - dy;
    while (board[nx + "," + ny] === who) { cnt++; nx -= dx; ny -= dy; }
    if (cnt >= 5) {
      const line = [[x, y]];
      nx = x + dx; ny = y + dy;
      while (board[nx + "," + ny] === who) { line.push([nx, ny]); nx += dx; ny += dy; }
      nx = x - dx; ny = y - dy;
      while (board[nx + "," + ny] === who) { line.unshift([nx, ny]); nx -= dx; ny -= dy; }
      return line;
    }
  }
  return null;
}

/* ============================================================================
 *  Worker 入口：路由
 * ========================================================================== */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // WebSocket 对战接口
    if (path === "/ws") {
      return routeWebSocket(request, env, url);
    }

    // 静态资源（index.html / __mp.js / 其它），并向 HTML 注入联机客户端
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        return new HTMLRewriter()
          .on("body", {
            element(el) {
              el.append('\n<script src="/__mp.js"></script>\n', { html: true });
            },
          })
          .transform(res);
      }
      return res;
    }

    // 未配置静态资源时的兜底说明页
    return new Response(FALLBACK_PAGE, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

/* 解析对战模式 → 解析房间号 → 转交对应 GameRoom 实例 */
async function routeWebSocket(request, env, url) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const mode = (url.searchParams.get("mode") || "quick").toLowerCase();
  let code = (url.searchParams.get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (mode === "quick") {
    const mm = env.MATCHMAKER.get(env.MATCHMAKER.idFromName("global"));
    code = await mm.claimQuick();
  } else if (mode === "create") {
    code = randCode();
  } else if (mode === "join") {
    if (!code) return new Response("missing code", { status: 400, headers: corsHeaders() });
  } else {
    return new Response("bad mode", { status: 400, headers: corsHeaders() });
  }

  // 把最终房间号带给 DO（用于回传给客户端展示/分享）
  const u2 = new URL(url.toString());
  u2.searchParams.set("code", code);
  u2.searchParams.set("mode", mode);
  const fwd = new Request(u2.toString(), request);

  const id = env.GAME_ROOM.idFromName("room:" + code);
  const room = env.GAME_ROOM.get(id);
  return room.fetch(fwd);
}

/* ============================================================================
 *  GameRoom：一个对局房间
 * ========================================================================== */
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map(); // ws -> { role, token }
    this.game = freshGame();
    this.roles = { h: null, a: null }; // role -> { token, connected, name }
    this.code = null;

    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get(["game", "roles", "code"]);
      this.game = s.get("game") || freshGame();
      this.roles = s.get("roles") || { h: null, a: null };
      this.code = s.get("code") || null;
    });

    // 休眠唤醒后，重建在线会话表（角色信息存于附件）
    for (const ws of ctx.getWebSockets()) {
      this.sessions.set(ws, ws.deserializeAttachment() || {});
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const code = (url.searchParams.get("code") || "").toUpperCase();
    if (code && !this.code) {
      this.code = code;
      await this.ctx.storage.put("code", code);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server); // 走 Hibernation API
    return new Response(null, { status: 101, webSocket: client });
  }

  /* -------------------------- 消息分发 -------------------------- */
  async webSocketMessage(ws, message) {
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (!m || typeof m.t !== "string") return;

    switch (m.t) {
      case "hello":   return this.onHello(ws, m);
      case "move":    return this.onMove(ws, m);
      case "rematch": return this.onRematch(ws, m);
      case "chat":    return this.onChat(ws, m);
      case "leave":   { try { ws.close(4000, "leave"); } catch {} return; }
      case "ping":    return this.send(ws, { t: "pong" });
      default:        return;
    }
  }

  async webSocketClose(ws) { await this.onDisconnect(ws); }
  async webSocketError(ws) { await this.onDisconnect(ws); }

  /* -------------------------- hello / 入座 / 重连 -------------------------- */
  async onHello(ws, m) {
    const token = (m.token || "").toString().trim();
    const name = (m.name || "玩家").toString().slice(0, 24) || "玩家";

    // 1) 断线重连：token 命中已有角色
    let role = null;
    if (token && this.roles.h && this.roles.h.token === token) role = "h";
    else if (token && this.roles.a && this.roles.a.token === token) role = "a";

    if (role) {
      this.roles[role].connected = true;
      this.roles[role].name = name;
      this.attach(ws, role, this.roles[role].token);
      await this.persist();

      this.send(ws, { t: "welcome", role, token: this.roles[role].token, code: this.code });
      this.sendStateTo(ws, role);              // 把当前棋局发回，客户端据此恢复
      this.broadcastExcept(ws, { t: "opponent_back" });

      if (this.bothConnected() && this.game.pendingForfeit) {
        this.game.pendingForfeit = null;
        await this.ctx.storage.deleteAlarm();
        await this.persist();
      }
      await this.updateMatchmaker();
      return;
    }

    // 2) 新玩家入座
    if (!this.roles.h) role = "h";
    else if (!this.roles.a) role = "a";
    else {
      this.send(ws, { t: "error", code: "full", msg: "房间已满" });
      try { ws.close(4001, "full"); } catch {}
      return;
    }

    const tk = randToken();
    this.roles[role] = { token: tk, connected: true, name };
    this.attach(ws, role, tk);
    await this.persist();
    this.send(ws, { t: "welcome", role, token: tk, code: this.code });

    if (this.bothSeated()) {
      await this.startGame(false); // 凑齐两人 → 开局
    } else {
      this.send(ws, { t: "waiting", code: this.code });
      await this.updateMatchmaker(); // 仅 1 人 → 登记为开放房间，供快速匹配
    }
  }

  /* -------------------------- 落子 -------------------------- */
  async onMove(ws, m) {
    const s = this.sessions.get(ws);
    if (!s || !s.role) return;
    const role = s.role;

    if (this.game.phase !== "playing" || this.game.over) {
      return this.send(ws, { t: "error", code: "state", msg: "对局未在进行" });
    }
    if (this.game.turn !== role) {
      return this.send(ws, { t: "error", code: "turn", msg: "还没轮到你" });
    }
    const x = m.x | 0, y = m.y | 0;
    if (Math.abs(x) > BOUND || Math.abs(y) > BOUND) {
      return this.send(ws, { t: "error", code: "oob", msg: "超出范围" });
    }
    const key = x + "," + y;
    if (this.game.board[key]) {
      return this.send(ws, { t: "error", code: "occupied", msg: "该点已有棋子" });
    }

    this.game.board[key] = role;
    this.game.history.push([x, y, role]);
    const line = checkWin(this.game.board, x, y, role);
    if (line) {
      this.game.over = true;
      this.game.winner = role;
      this.game.line = line;
      this.game.phase = "over";
      this.game.turn = role;
    } else {
      this.game.turn = other(role);
    }
    await this.persist();

    this.broadcastPlayers({ t: "move", x, y, who: role, turn: this.game.turn, win: line || null });
    if (line) await this.updateMatchmaker();
  }

  /* -------------------------- 再来一局 -------------------------- */
  async onRematch(ws, m) {
    const s = this.sessions.get(ws);
    if (!s || !s.role) return;
    if (!this.bothSeated()) {
      return this.send(ws, { t: "error", code: "noopp", msg: "对手已离开" });
    }
    this.game.rematch = this.game.rematch || {};
    this.game.rematch[s.role] = true;
    await this.persist();

    if (this.game.rematch.h && this.game.rematch.a) {
      await this.startGame(true); // 双方同意 → 交替先手开新局
    } else {
      this.send(ws, { t: "rematch_wait" });
      this.broadcastExcept(ws, { t: "rematch_offer" });
    }
  }

  async onChat(ws, m) {
    const s = this.sessions.get(ws);
    if (!s || !s.role) return;
    const msg = (m.msg || "").toString().slice(0, 200);
    if (!msg) return;
    const from = (this.roles[s.role] && this.roles[s.role].name) || "对手";
    this.broadcastExcept(ws, { t: "chat", from, msg });
  }

  /* -------------------------- 掉线 / 离开 -------------------------- */
  async onDisconnect(ws) {
    const s = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (!s || !s.role) return;
    const role = s.role;
    if (this.roles[role]) this.roles[role].connected = false;
    await this.persist();

    if (this.game.phase === "playing" && !this.game.over) {
      // 对局中掉线：通知对手，给掉线方宽限时间重连，超时判负
      this.broadcastPlayers({ t: "opponent_left", grace: Math.round(FORFEIT_MS / 1000) });
      this.game.pendingForfeit = role;
      await this.persist();
      await this.ctx.storage.setAlarm(Date.now() + FORFEIT_MS);
    } else {
      // 大厅 / 已结束：通知对手
      this.broadcastPlayers({ t: "opponent_left" });
      if (this.connectedCount() === 0) {
        await this.cleanup(); // 房间空了 → 清理
      } else {
        await this.updateMatchmaker();
      }
    }
  }

  /* 宽限计时到点：仍未重连则判负 */
  async alarm() {
    if (this.game.phase !== "playing" || this.game.over || !this.game.pendingForfeit) return;
    const left = this.game.pendingForfeit;
    if (this.roles[left] && this.roles[left].connected) {
      this.game.pendingForfeit = null;
      await this.persist();
      return;
    }
    const winner = other(left);
    this.game.over = true;
    this.game.winner = winner;
    this.game.phase = "over";
    this.game.pendingForfeit = null;
    await this.persist();
    this.broadcastPlayers({ t: "over", winner, reason: "forfeit", line: null });
    await this.updateMatchmaker();
  }

  /* -------------------------- 开局 -------------------------- */
  async startGame(swapFirst) {
    let first = this.game.firstMover || ROLE_FIRST;
    if (swapFirst) first = other(first);
    this.game.board = {};
    this.game.history = [];
    this.game.over = false;
    this.game.winner = null;
    this.game.line = null;
    this.game.phase = "playing";
    this.game.firstMover = first;
    this.game.turn = first;
    this.game.rematch = {};
    this.game.pendingForfeit = null;
    await this.ctx.storage.deleteAlarm().catch(() => {});
    await this.persist();

    for (const [ws, s] of this.sessions) {
      if (!s || !s.role) continue;
      this.send(ws, {
        t: "start",
        role: s.role,
        you: (this.roles[s.role] && this.roles[s.role].name) || "你",
        opponent: (this.roles[other(s.role)] && this.roles[other(s.role)].name) || "对手",
        turn: this.game.turn,
        board: [],
        code: this.code,
      });
    }
    await this.updateMatchmaker(); // 满员 → 从开放队列移除
  }

  /* -------------------------- 工具 -------------------------- */
  attach(ws, role, token) {
    const att = { role, token };
    ws.serializeAttachment(att);
    this.sessions.set(ws, att);
  }

  boardArray() {
    const out = [];
    for (const k in this.game.board) {
      const c = k.indexOf(",");
      out.push([parseInt(k.slice(0, c), 10), parseInt(k.slice(c + 1), 10), this.game.board[k]]);
    }
    return out;
  }

  sendStateTo(ws, role) {
    const playing = this.game.phase === "playing" || this.game.phase === "over";
    this.send(ws, {
      t: playing ? "resume" : "waiting",
      role,
      turn: this.game.turn,
      board: this.boardArray(),
      over: this.game.over,
      winner: this.game.winner,
      line: this.game.line,
      code: this.code,
      opponent: (this.roles[other(role)] && this.roles[other(role)].name) || "对手",
    });
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcastPlayers(obj) { for (const [ws, s] of this.sessions) if (s && s.role) this.send(ws, obj); }
  broadcastExcept(except, obj) { for (const [ws, s] of this.sessions) if (ws !== except && s && s.role) this.send(ws, obj); }

  bothSeated() { return !!(this.roles.h && this.roles.a); }
  bothConnected() { return !!(this.roles.h && this.roles.h.connected && this.roles.a && this.roles.a.connected); }
  connectedCount() {
    let n = 0;
    if (this.roles.h && this.roles.h.connected) n++;
    if (this.roles.a && this.roles.a.connected) n++;
    return n;
  }

  async persist() {
    await this.ctx.storage.put({ game: this.game, roles: this.roles, code: this.code });
  }

  async cleanup() {
    const code = this.code;
    await this.ctx.storage.deleteAll();
    this.game = freshGame();
    this.roles = { h: null, a: null };
    this.code = null;
    if (code) {
      const mm = this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName("global"));
      await mm.close(code);
    }
  }

  /* 仅当“恰好 1 人在线且处于大厅等待”时，房间对快速匹配开放；其余情况关闭 */
  async updateMatchmaker() {
    if (!this.code) return;
    const mm = this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName("global"));
    const open = this.connectedCount() === 1 && this.game.phase === "lobby";
    if (open) await mm.open(this.code);
    else await mm.close(this.code);
  }
}

/* ============================================================================
 *  Matchmaker：快速匹配（全局单例）
 *  维护一组“开放房间”（恰有 1 人在等的房间号）。
 * ========================================================================== */
export class Matchmaker extends DurableObject {
  async claimQuick() {
    const rooms = (await this.ctx.storage.get("open")) || [];
    let code;
    if (rooms.length) {
      code = rooms.shift();           // 取出一个正在等人的房间，去当第二人
      await this.ctx.storage.put("open", rooms);
    } else {
      code = randCode();              // 没人等 → 开个新房，自己先手等待
    }
    return code;
  }
  async open(code) {
    let rooms = (await this.ctx.storage.get("open")) || [];
    if (!rooms.includes(code)) {
      rooms.push(code);
      if (rooms.length > 100) rooms = rooms.slice(-100); // 软上限，清理可能的陈旧条目
      await this.ctx.storage.put("open", rooms);
    }
  }
  async close(code) {
    const rooms = (await this.ctx.storage.get("open")) || [];
    const i = rooms.indexOf(code);
    if (i >= 0) {
      rooms.splice(i, 1);
      await this.ctx.storage.put("open", rooms);
    }
  }
}

/* ----------------------------- 兜底说明页 ----------------------------- */
const FALLBACK_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>五子棋 · 联机服务</title>
<body style="font-family:-apple-system,system-ui,'PingFang SC',sans-serif;max-width:640px;margin:14vh auto;padding:0 24px;color:#1d1d1f;line-height:1.7">
<h1 style="font-weight:680">五子棋 · 联机服务已就绪</h1>
<p style="color:#3c3c43a0">WebSocket 接口 <code>/ws</code> 正常工作，但还没有检测到静态站点绑定（ASSETS）。</p>
<p>请把游戏页面放到 <code>public/index.html</code> 并在 <code>wrangler.jsonc</code> 中配置静态资源绑定，部署后即可在本域名直接游玩；联机客户端会被自动注入。</p>
<p style="color:#3c3c43a0">详见随附的 README.md。</p>
</body></html>`;
