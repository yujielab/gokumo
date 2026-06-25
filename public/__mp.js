/* ============================================================================
 *  五子棋 · 联机客户端 (__mp.js)
 *  —— 不修改 index.html，作为一个经典外部脚本注入；与游戏主脚本共享全局作用域。
 *
 *  工作原理
 *   · humanPlay / newGame 是主脚本里的「函数声明」→ 同时是 window 上的属性，
 *     重写 window.humanPlay / window.newGame 即可拦截后续的「裸名」调用。
 *   · game / Engine 是 const（词法全局），只能用裸名访问（window 上没有）。
 *   · 落子不做本地乐观更新：所有棋子都以「服务器回声」为准，双方画面强一致。
 *   · 双方都把「自己」设为 game.human（蓝），「对手」设为 game.ai（灰），
 *     服务器用绝对角色 'h'/'a' 下发，客户端据此着色，天然正确。
 * ========================================================================== */
(function () {
  "use strict";

  // —— 找到服务器来源：优先用本脚本的 src（支持把 index.html 部署在别处的情况）——
  var THIS = document.currentScript;
  function originOf() {
    try {
      if (THIS && THIS.src) return new URL(THIS.src).origin;
    } catch (e) {}
    return location.origin;
  }
  var ORIGIN = originOf();
  var WS_BASE = ORIGIN.replace(/^http/i, "ws"); // http→ws, https→wss

  var other = function (r) { return r === "h" ? "a" : "h"; };

  // —— 联机状态机 ——
  var MP = {
    active: false,                 // 是否处于联机会话（含等待中）
    phase: "idle",                 // idle | waiting | playing | over
    mode: null,                    // quick | create | join
    myRole: null,                  // 'h' | 'a'
    oppRole: null,
    code: "",                      // 房间号
    name: "",                      // 我的昵称
    oppName: "对手",
    ws: null,
    intentionalClose: false,       // 主动断开（退出/换房）时不自动重连
    reconnectTimer: null,
    reconnectAttempts: 0,
    quickRetries: 0,
    pingTimer: null,
  };
  window.MP = MP; // 便于调试

  /* ----------------------------- 本地存储 ----------------------------- */
  function tokenKey(code) { return "gomoku_mp_token_" + code; }
  function saveToken(code, tok) { try { localStorage.setItem(tokenKey(code), tok); } catch (e) {} }
  function loadToken(code) { try { return localStorage.getItem(tokenKey(code)) || ""; } catch (e) { return ""; } }
  function loadName() { try { return localStorage.getItem("gomoku_mp_name") || ""; } catch (e) { return ""; } }
  function saveName(n) { try { localStorage.setItem("gomoku_mp_name", n); } catch (e) {} }

  /* --------------------------- 捕获原始函数 --------------------------- */
  // 必须在重写之前抓取（此脚本在主脚本之后执行，函数都已就绪）
  var _humanPlay = window.humanPlay;
  var _newGame = window.newGame;

  // 重写落子：联机时改为发送给服务器
  window.humanPlay = function (i, j) {
    if (MP.active) { MP.tryMove(i, j); return; }
    return _humanPlay.apply(this, arguments);
  };

  // 重写重开：联机进行中禁止重开；已结束→请求再来一局；单机→原逻辑
  window.newGame = function () {
    if (MP.active) {
      if (MP.phase === "over") { MP.requestRematch(); }
      else { safeToast("联机对局进行中，无法重开"); }
      return;
    }
    return _newGame.apply(this, arguments);
  };

  function safeToast(msg) {
    try { if (typeof toast === "function") { toast(msg); return; } } catch (e) {}
    try { if (typeof window.toast === "function") window.toast(msg); } catch (e) {}
  }

  /* --------------------------- 棋盘 / 灵动岛 --------------------------- */
  function applyBoard(arr) {
    var lastX, lastY, has = false;
    for (var k = 0; k < (arr ? arr.length : 0); k++) {
      var e = arr[k], x = e[0], y = e[1], who = e[2];
      if (!game.board.has(Engine.k(x, y))) place(x, y, who);
      lastX = x; lastY = y; has = true;
    }
    if (has) ensureVisible(lastX, lastY);
  }

  // 落子轮转提示（复用灵动岛的 turn-human 形态：我方=蓝点，对方=灰点）
  function syncTurn() {
    var isl = document.getElementById("island");
    var lab = document.getElementById("islandLabel");
    if (!isl) return;
    isl.dataset.state = "turn-human";
    if (game.turn === game.human) {
      isl.dataset.side = "human";
      if (lab) lab.textContent = "轮到你落子";
    } else {
      isl.dataset.side = "ai";
      if (lab) lab.textContent = "对方落子中";
    }
    isl.classList.remove("pop"); void isl.offsetWidth; isl.classList.add("pop");
  }

  function patchTitle(text) {
    var t = document.getElementById("resultTitle");
    if (t) t.textContent = text;
  }
  function patchSub(text) {
    var s = document.getElementById("resultSub");
    if (s) s.textContent = text;
  }

  /* ------------------------------ 开局 ------------------------------ */
  function beginGame(m) {
    MP.myRole = m.role; MP.oppRole = other(m.role);
    MP.oppName = m.opponent || "对手";
    MP.code = m.code || MP.code;
    MP.active = true; MP.phase = "playing";
    MP.quickRetries = 0; MP.reconnectAttempts = 0;

    game.human = MP.myRole;
    game.ai = MP.oppRole;
    _newGame();               // 清空棋盘 + 复位视图（原始实现）
    applyBoard(m.board || []); // 起始通常为空
    game.turn = m.turn;
    syncTurn();

    closeModal();
    refreshBar();
    safeToast(m.turn === game.human ? "对战开始 · 你先手" : "对战开始 · 对手先手");
  }

  // 断线重连后恢复对局
  function resumeGame(m) {
    MP.myRole = m.role; MP.oppRole = other(m.role);
    MP.oppName = m.opponent || "对手";
    MP.code = m.code || MP.code;
    MP.active = true;
    MP.quickRetries = 0; MP.reconnectAttempts = 0;

    game.human = MP.myRole;
    game.ai = MP.oppRole;
    _newGame();
    applyBoard(m.board || []);

    if (m.over) {
      MP.phase = "over";
      game.turn = m.winner || game.turn;
      endGame(m.winner, m.line || null);
      if (m.winner !== game.human) patchTitle("对方获胜");
    } else {
      MP.phase = "playing";
      game.turn = m.turn;
      syncTurn();
    }
    closeModal();
    refreshBar();
  }

  /* ---------------------------- 应用一步棋 ---------------------------- */
  function applyMove(m) {
    if (!game.board.has(Engine.k(m.x, m.y))) {
      place(m.x, m.y, m.who);
      ensureVisible(m.x, m.y);
    }
    if (m.win) {
      MP.phase = "over";
      endGame(m.who, m.win);
      if (m.who !== game.human) patchTitle("对方获胜");
      refreshBar();
    } else {
      game.turn = m.turn;
      syncTurn();
    }
  }

  // 认输 / 对手掉线判负
  function gameOver(m) {
    MP.phase = "over";
    if (m.winner != null) {
      game.turn = m.winner;
      endGame(m.winner, m.line || null);
      if (m.winner === game.human) {
        patchTitle("你赢了");
        if (m.reason === "forfeit") patchSub("对手已离开 · 你获胜");
      } else {
        patchTitle("对方获胜");
      }
    }
    refreshBar();
  }

  /* ------------------------------ 收发 ------------------------------ */
  function send(obj) {
    try {
      if (MP.ws && MP.ws.readyState === 1) MP.ws.send(JSON.stringify(obj));
    } catch (e) {}
  }

  MP.tryMove = function (i, j) {
    if (!MP.active || MP.phase !== "playing" || game.over) return;
    if (game.turn !== game.human) { safeToast("还没轮到你"); return; }
    if (game.board.has(Engine.k(i, j))) return; // 本地已知占用
    if (!MP.ws || MP.ws.readyState !== 1) { safeToast("连接已断开，正在重连…"); return; }
    send({ t: "move", x: i, y: j });
  };

  MP.requestRematch = function () {
    if (!MP.active) return;
    if (MP.phase !== "over") { safeToast("对局进行中"); return; }
    send({ t: "rematch" });
    safeToast("已请求再来一局…");
  };

  /* ----------------------------- 连接管理 ----------------------------- */
  function startPing() {
    stopPing();
    MP.pingTimer = setInterval(function () { send({ t: "ping" }); }, 25000);
  }
  function stopPing() { if (MP.pingTimer) { clearInterval(MP.pingTimer); MP.pingTimer = null; } }
  function stopReconnect() { if (MP.reconnectTimer) { clearTimeout(MP.reconnectTimer); MP.reconnectTimer = null; } }

  function connect(mode, code) {
    stopReconnect();
    MP.mode = mode;
    if (code) MP.code = String(code).toUpperCase().replace(/[^A-Z0-9]/g, "");

    var url = WS_BASE + "/ws?mode=" + encodeURIComponent(mode);
    if (mode === "join") url += "&code=" + encodeURIComponent(MP.code);

    var token = MP.code ? loadToken(MP.code) : "";
    var ws;
    try { ws = new WebSocket(url); }
    catch (e) { setStatus("连接失败，请稍后再试"); return; }

    MP.ws = ws;
    MP.intentionalClose = false;

    ws.onopen = function () {
      send({ t: "hello", name: MP.name || "玩家", token: token || "" });
      startPing();
    };
    ws.onmessage = function (ev) { onMessage(ev.data); };
    ws.onclose = function () { stopPing(); onClose(); };
    ws.onerror = function () { /* onclose 会接管 */ };
  }

  function onClose() {
    MP.ws = null;
    if (MP.intentionalClose) return;
    if (!MP.active || MP.phase === "over") return; // 结束或未激活：不重连
    MP.reconnectAttempts++;
    var delay = Math.min(1500 * MP.reconnectAttempts, 6000);
    setStatus("连接断开，重连中…");
    refreshBar();
    MP.reconnectTimer = setTimeout(function () {
      if (MP.code) connect("join", MP.code);
    }, delay);
  }

  function cleanupToIdle() {
    MP.active = false; MP.phase = "idle";
    MP.intentionalClose = true;
    stopReconnect(); stopPing();
    try { if (MP.ws) MP.ws.close(); } catch (e) {}
    MP.ws = null;
    refreshBar();
  }

  function exitOnline() {
    cleanupToIdle();
    game.human = "h"; game.ai = "a"; // 还原人机模式
    _newGame();
    safeToast("已退出联机");
  }
  MP.exit = exitOnline;

  /* ----------------------------- 消息分发 ----------------------------- */
  function onMessage(data) {
    var m; try { m = JSON.parse(data); } catch (e) { return; }
    switch (m.t) {
      case "welcome": onWelcome(m); break;
      case "waiting": onWaiting(m); break;
      case "start": beginGame(m); break;
      case "resume": resumeGame(m); break;
      case "move": applyMove(m); break;
      case "over": gameOver(m); break;
      case "opponent_left": onOppLeft(m); break;
      case "opponent_back": onOppBack(m); break;
      case "rematch_offer": onRematchOffer(m); break;
      case "rematch_wait": onRematchWait(m); break;
      case "chat": onChat(m); break;
      case "error": onError(m); break;
      case "pong": break;
    }
  }

  function onWelcome(m) {
    MP.myRole = m.role; MP.oppRole = other(m.role);
    MP.code = m.code || MP.code;
    MP.active = true;
    MP.reconnectAttempts = 0; MP.quickRetries = 0;
    if (m.token && MP.code) saveToken(MP.code, m.token);
    refreshBar();
    showRoomCodeInModal();
  }

  function onWaiting(m) {
    MP.phase = "waiting";
    MP.code = m.code || MP.code;
    setStatus(MP.mode === "create" ? "房间已创建，等待好友加入…" : "等待对手加入…");
    refreshBar();
    showRoomCodeInModal();
  }

  function onOppLeft(m) {
    if (m && m.grace) safeToast("对手已离开，" + m.grace + "s 内可重连…");
    else safeToast("对手已离开");
    refreshBar();
  }
  function onOppBack() { safeToast("对手已重连"); refreshBar(); }
  function onRematchOffer() { safeToast("对手想再来一局 · 点「再来一局」即可开始"); }
  function onRematchWait() { safeToast("已请求再来一局，等待对手…"); }
  function onChat(m) { if (m && m.msg) safeToast("对方：" + String(m.msg).slice(0, 120)); }

  function onError(m) {
    var code = (m && m.code) || "";
    if (code === "full") {
      // 快速匹配偶发抢座失败 → 自动重试
      if (MP.mode === "quick" && MP.quickRetries < 4) {
        MP.quickRetries++;
        setStatus("正在重新匹配…");
        setTimeout(function () { connect("quick"); }, 500);
        return;
      }
      safeToast("房间已满");
      cleanupToIdle();
      setStatus("该房间已满，换个房间号试试");
      return;
    }
    if (code === "turn" || code === "occupied" || code === "oob" || code === "state") {
      safeToast(m.msg || "操作无效");
      return;
    }
    if (code === "noopp") { safeToast("对手不在，暂时无法再来一局"); return; }
    safeToast((m && m.msg) || "出错了");
  }

  /* ============================================================================
   *  UI —— 与主界面一致的玻璃拟态（直接复用 :root 的设计变量）
   * ========================================================================== */
  function injectStyle() {
    if (document.getElementById("mp-style")) return;
    var css = `
    #mpBar{ position:fixed; left:calc(env(safe-area-inset-left,0px) + 16px);
      bottom:calc(env(safe-area-inset-bottom,0px) + 16px); z-index:45;
      display:flex; gap:8px; align-items:center; }
    .mp-pill{ display:inline-flex; align-items:center; gap:9px; height:44px; padding:0 16px;
      border-radius:980px; font:inherit; font-size:14px; font-weight:580; color:var(--t1);
      cursor:pointer; border:0.5px solid rgba(0,0,0,0.06); background:var(--glass);
      -webkit-backdrop-filter:blur(36px) saturate(180%); backdrop-filter:blur(36px) saturate(180%);
      box-shadow:0 8px 28px rgba(0,0,0,0.10),0 1px 3px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.7);
      transition:transform var(--dur-fast) var(--spring); white-space:nowrap; }
    .mp-pill:active{ transform:scale(0.97); }
    .mp-pill .net{ width:17px; height:17px; display:inline-block; color:var(--blue); }
    .mp-pill .dot{ width:8px; height:8px; border-radius:50%; background:#34c759;
      box-shadow:0 0 0 3px rgba(52,199,89,0.18); }
    .mp-pill .dot.wait{ background:#ff9f0a; box-shadow:0 0 0 3px rgba(255,159,10,0.18); }
    .mp-pill .code{ font-variant-numeric:tabular-nums; letter-spacing:1px; color:var(--blue); font-weight:700; }
    .mp-pill .muted{ color:var(--t2); font-weight:560; }
    .mp-x{ display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px;
      border-radius:50%; border:0.5px solid rgba(0,0,0,0.06); background:var(--glass);
      -webkit-backdrop-filter:blur(36px) saturate(180%); backdrop-filter:blur(36px) saturate(180%);
      box-shadow:0 8px 28px rgba(0,0,0,0.10),0 1px 3px rgba(0,0,0,0.05);
      color:var(--t1); cursor:pointer; font-size:16px; line-height:1;
      transition:transform var(--dur-fast) var(--spring); }
    .mp-x:active{ transform:scale(0.92); }

    #mpModal{ position:fixed; inset:0; z-index:60; display:none; align-items:center;
      justify-content:center; padding:24px; }
    #mpModal.open{ display:flex; }
    .mp-backdrop{ position:absolute; inset:0; background:rgba(0,0,0,0.28);
      -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); animation:mpFade var(--dur-fast) ease; }
    .mp-card{ position:relative; width:min(92vw,360px); border-radius:28px; padding:24px 22px 20px;
      background:var(--glass-strong);
      -webkit-backdrop-filter:blur(36px) saturate(180%); backdrop-filter:blur(36px) saturate(180%);
      border:0.5px solid rgba(0,0,0,0.06);
      box-shadow:0 24px 64px rgba(0,0,0,0.22),0 2px 8px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.7);
      animation:mpRise var(--dur) var(--spring); }
    .mp-close{ position:absolute; top:14px; right:14px; width:30px; height:30px; border-radius:50%;
      border:none; background:rgba(0,0,0,0.05); color:var(--t1); font-size:18px; line-height:1;
      cursor:pointer; transition:transform var(--dur-fast) var(--spring); }
    .mp-close:active{ transform:scale(0.92); }
    .mp-title{ font-size:22px; font-weight:680; letter-spacing:0.2px; }
    .mp-sub{ font-size:13px; color:var(--t2); margin:4px 0 18px; }
    .mp-field{ display:block; margin-bottom:14px; }
    .mp-field span{ display:block; font-size:12px; color:var(--t2); margin:0 0 6px 4px; }
    .mp-field input, .mp-code-input{ width:100%; height:46px; border-radius:14px;
      border:0.5px solid var(--hairline); background:rgba(255,255,255,0.6); padding:0 14px;
      font:inherit; font-size:16px; color:var(--t1); outline:none;
      transition:border-color var(--dur-fast),box-shadow var(--dur-fast); }
    .mp-field input:focus, .mp-code-input:focus{ border-color:var(--blue); box-shadow:0 0 0 4px var(--blue-soft); }
    .mp-btn{ width:100%; height:46px; border-radius:980px; border:0.5px solid var(--hairline);
      background:rgba(255,255,255,0.7); color:var(--t1); font:inherit; font-size:16px; font-weight:580;
      cursor:pointer; margin-bottom:10px;
      transition:transform var(--dur-fast) var(--spring), background var(--dur-fast); }
    .mp-btn:active{ transform:scale(0.985); }
    .mp-primary{ background:var(--blue); color:#fff; border-color:transparent;
      box-shadow:0 1px 2px rgba(0,0,0,0.12); }
    .mp-primary:active{ background:#0064cc; }
    .mp-row{ display:flex; gap:10px; align-items:stretch; margin-bottom:2px; }
    .mp-row .mp-code-input{ flex:1; text-transform:uppercase; letter-spacing:3px;
      font-variant-numeric:tabular-nums; font-weight:600; }
    .mp-join{ width:auto; padding:0 22px; margin:0; background:var(--indigo); color:#fff; border-color:transparent; }
    .mp-join:active{ background:#4b49c4; }
    .mp-divider{ display:flex; align-items:center; gap:10px; margin:6px 0 12px; color:var(--t3); font-size:12px; }
    .mp-divider::before, .mp-divider::after{ content:""; flex:1; height:1px; background:var(--hairline); }
    .mp-status{ min-height:18px; font-size:13px; color:var(--t2); margin-top:12px; text-align:center; }
    .mp-roomcode{ margin-top:12px; text-align:center; }
    .mp-roomcode .big{ font-size:30px; font-weight:720; letter-spacing:7px; color:var(--blue);
      font-variant-numeric:tabular-nums; cursor:pointer; }
    .mp-roomcode .tip{ font-size:12px; color:var(--t2); margin-top:6px; }
    @keyframes mpFade{ from{opacity:0} to{opacity:1} }
    @keyframes mpRise{ 0%{opacity:0; transform:translateY(10px) scale(0.97)} 100%{opacity:1; transform:translateY(0) scale(1)} }
    `;
    var s = document.createElement("style");
    s.id = "mp-style";
    s.textContent = css;
    document.head.appendChild(s);
  }

  var NET_ICON =
    '<svg class="net" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

  function buildDOM() {
    injectStyle();

    if (!document.getElementById("mpBar")) {
      var bar = document.createElement("div");
      bar.id = "mpBar";
      document.body.appendChild(bar);
    }

    if (!document.getElementById("mpModal")) {
      var modal = document.createElement("div");
      modal.id = "mpModal";
      modal.innerHTML =
        '<div class="mp-backdrop" id="mpBackdrop"></div>' +
        '<div class="mp-card glass" role="dialog" aria-modal="true">' +
          '<button class="mp-close" id="mpClose" aria-label="关闭">×</button>' +
          '<div class="mp-title">联机对战</div>' +
          '<div class="mp-sub">和好友实时对弈 · 五子连珠</div>' +
          '<label class="mp-field"><span>昵称</span>' +
            '<input id="mpName" maxlength="16" placeholder="玩家" autocomplete="off"></label>' +
          '<button class="mp-btn mp-primary" id="mpQuick">快速匹配</button>' +
          '<button class="mp-btn" id="mpCreate">创建房间</button>' +
          '<div class="mp-divider">或加入好友房间</div>' +
          '<div class="mp-row">' +
            '<input id="mpCode" class="mp-code-input" maxlength="6" placeholder="房间号" autocomplete="off">' +
            '<button class="mp-btn mp-join" id="mpJoin">加入</button>' +
          '</div>' +
          '<div class="mp-status" id="mpStatus"></div>' +
          '<div class="mp-roomcode" id="mpRoomCode" hidden></div>' +
        '</div>';
      document.body.appendChild(modal);

      document.getElementById("mpBackdrop").addEventListener("click", closeModal);
      document.getElementById("mpClose").addEventListener("click", closeModal);

      var nameInput = document.getElementById("mpName");
      nameInput.value = MP.name || "";
      nameInput.addEventListener("input", function () {
        MP.name = nameInput.value.trim().slice(0, 16);
        saveName(MP.name);
      });

      document.getElementById("mpQuick").addEventListener("click", function () {
        commitName(); setStatus("正在匹配对手…"); connect("quick");
      });
      document.getElementById("mpCreate").addEventListener("click", function () {
        commitName(); setStatus("正在创建房间…"); connect("create");
      });
      document.getElementById("mpJoin").addEventListener("click", function () {
        commitName();
        var c = (document.getElementById("mpCode").value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!c) { setStatus("请输入房间号"); return; }
        setStatus("正在加入房间…"); connect("join", c);
      });
      document.getElementById("mpCode").addEventListener("keydown", function (e) {
        if (e.key === "Enter") document.getElementById("mpJoin").click();
      });
    }

    // 接管结果岛的「再来一局」按钮：克隆以剥离原始监听，改走 newGame（已被重写）
    rebindAgain();
    refreshBar();
  }

  function rebindAgain() {
    var b = document.getElementById("againBtn");
    if (!b || b.dataset.mpBound) return;
    var c = b.cloneNode(true);
    c.dataset.mpBound = "1";
    b.parentNode.replaceChild(c, b);
    c.addEventListener("click", function () { window.newGame(); });
  }

  function commitName() {
    var el = document.getElementById("mpName");
    if (el) { MP.name = (el.value || "").trim().slice(0, 16); saveName(MP.name); }
  }

  function openModal() {
    var modal = document.getElementById("mpModal");
    var nameInput = document.getElementById("mpName");
    if (nameInput && !nameInput.value) nameInput.value = MP.name || "";
    setStatus("");
    showRoomCodeInModal();
    modal.classList.add("open");
  }
  function closeModal() {
    var modal = document.getElementById("mpModal");
    if (modal) modal.classList.remove("open");
  }

  function setStatus(text) {
    var el = document.getElementById("mpStatus");
    if (el) el.textContent = text || "";
  }

  function showRoomCodeInModal() {
    var box = document.getElementById("mpRoomCode");
    if (!box) return;
    if (MP.active && MP.phase === "waiting" && MP.code) {
      box.hidden = false;
      box.innerHTML =
        '<div class="big" id="mpRoomBig" title="点按复制">' + MP.code + '</div>' +
        '<div class="tip">把房间号发给好友，等待加入…</div>';
      var big = document.getElementById("mpRoomBig");
      if (big) big.addEventListener("click", function () { copyCode(MP.code); });
    } else {
      box.hidden = true;
      box.innerHTML = "";
    }
  }

  function copyCode(code) {
    if (!code) return;
    var done = function () { safeToast("已复制房间号 " + code); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done, function () { fallbackCopy(code, done); });
      } else { fallbackCopy(code, done); }
    } catch (e) { fallbackCopy(code, done); }
  }
  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      done();
    } catch (e) { safeToast("房间号：" + text); }
  }

  // 底部左侧药丸：随状态切换（入口 / 等待 / 对局中）
  function refreshBar() {
    var bar = document.getElementById("mpBar");
    if (!bar) return;
    bar.innerHTML = "";

    if (!MP.active) {
      var entry = document.createElement("button");
      entry.className = "mp-pill";
      entry.innerHTML = NET_ICON + "<span>联机对战</span>";
      entry.addEventListener("click", openModal);
      bar.appendChild(entry);
      return;
    }

    var pill = document.createElement("button");
    pill.className = "mp-pill";
    if (MP.phase === "waiting") {
      pill.innerHTML =
        '<span class="dot wait"></span><span class="muted">房间</span>' +
        '<span class="code">' + (MP.code || "----") + '</span>' +
        '<span class="muted">等待中</span>';
      pill.title = "点按复制房间号";
      pill.addEventListener("click", function () { copyCode(MP.code); });
    } else {
      var label = MP.phase === "over" ? "已结束" : "";
      pill.innerHTML =
        '<span class="dot"></span><span>VS ' + escapeHtml(MP.oppName || "对手") + '</span>' +
        '<span class="muted">·</span><span class="code">' + (MP.code || "----") + '</span>' +
        (label ? '<span class="muted">' + label + '</span>' : "");
      pill.title = "点按复制房间号";
      pill.addEventListener("click", function () { copyCode(MP.code); });
    }
    bar.appendChild(pill);

    var x = document.createElement("button");
    x.className = "mp-x";
    x.setAttribute("aria-label", "退出联机");
    x.textContent = "×";
    x.addEventListener("click", exitOnline);
    bar.appendChild(x);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ------------------------------ 启动 ------------------------------ */
  function init() {
    MP.name = loadName();
    buildDOM();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
