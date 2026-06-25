# 五子棋 · 联机对战

给你现有的单页五子棋（人机对战）加上**真人在线对战**：快速匹配、私人房间、断线重连、再来一局，全部由 Cloudflare Worker + Durable Objects 提供实时中继与权威判定。

服务端会在返回 HTML 时**自动注入**联机客户端脚本，因此你**无需手改 `index.html`**。

## 目录结构

```
.
├─ worker.js            # 服务端：路由 / WebSocket 中继 / 房间与匹配 / 胜负判定
├─ wrangler.jsonc       # 部署配置（静态资源绑定 + 两个 Durable Object）
├─ README.md            # 本文件
└─ public/
   ├─ index.html        # 你的游戏页面（原样保留，未改动）
   └─ __mp.js           # 联机客户端（玻璃拟态浮层 + 与游戏全局对接）
```

## 准备工作

需要一个 Cloudflare 账号，以及本机的 Node.js（建议 18 及以上）。Wrangler 是 Cloudflare 的命令行工具，下面的命令用 `npx` 直接调用，无需全局安装。

## 部署

在项目根目录执行：

```bash
npx wrangler login      # 首次使用，浏览器里授权登录
npx wrangler deploy     # 部署 Worker、静态资源与 Durable Object
```

部署成功后，终端会打印一个 `*.workers.dev` 地址。直接用浏览器打开它就是你的游戏，左下角会出现「联机对战」入口。把这个网址发给朋友，就能一起玩。

> 本项目把两个 Durable Object 用 SQLite 存储后端创建（见 `wrangler.jsonc` 的 `new_sqlite_classes`），在 Workers **免费套餐**即可运行。

如果想绑定自定义域名，在 Cloudflare 仪表盘里给这个 Worker 添加路由，或在 `wrangler.jsonc` 中配置 `routes` 后重新部署即可。

## 怎么玩

打开页面后点左下角的「**联机对战**」：

- **快速匹配** —— 自动和另一位也在排队的玩家配对开局。
- **创建房间** —— 生成一个房间号，发给好友；对方用「加入房间」输入该号即可进来。
- **加入房间** —— 输入好友给的房间号加入。

先手执蓝、后手执灰（在每个人自己的屏幕上，你**始终是蓝色**）。顶部灵动岛会提示「轮到你落子 / 对方落子中」。胜负出现后点「再来一局」——双方都点了才会重开，并自动交换先手。

## 行为说明

**断线重连**：对局进行中若网络中断或刷新页面，客户端会自动用房间号重连并恢复棋局；对手会看到「对手已离开（N 秒内可重连）」。

**掉线判负**：一方掉线超过约 30 秒仍未回来，另一方自动获胜。

**权威判定在服务端**：落子是否合法（是否轮到你、是否已有子、是否越界）和五连胜负都由服务端裁定，客户端不做乐观落子，因此双方画面强一致、也不易作弊。

**退出联机**：点左下角药丸旁的「×」即可退出，回到原来的人机对战模式。

## 本地开发

```bash
npx wrangler dev
```

它会在本地起一个服务（默认 `http://localhost:8787`），Durable Object 与静态资源都能正常工作，方便边改边试。开两个浏览器标签页即可自己和自己联机调试。

## 关于自动注入（以及手动接入）

`worker.js` 用 `HTMLRewriter` 在所有 HTML 响应的 `<body>` 末尾插入一行：

```html
<script src="/__mp.js"></script>
```

所以只要游戏是从这个 Worker 提供的，联机功能就会自动出现。

如果你想把 `index.html` 托管在**别的地方**（比如另一个静态站点），只需在它的 `</body>` 前手动加上指向本 Worker 的脚本即可——客户端会从脚本地址推断出服务器，并据此连接 WebSocket：

```html
<script src="https://<你的worker域名>/__mp.js"></script>
```

## 排错

- **打开页面只看到一段文字说明，没有棋盘**：说明静态资源绑定没生效。确认 `public/index.html` 存在，且用 `wrangler deploy`（而非只部署脚本）完成了部署。
- **左下角没有「联机对战」入口**：硬刷新（清缓存）一次；确认 `public/__mp.js` 已随部署上传，访问 `/__mp.js` 应能看到脚本内容。
- **一直在「等待对手」**：把房间号发给朋友让其加入；或两人同时点「快速匹配」。
- **提示「房间已满」**：私人房间只容纳两名玩家；换一个房间号，或改用快速匹配。

## 客户端与服务端约定（开发者参考）

WebSocket 入口：`/ws?mode=quick|create|join[&code=XXXX]`；角色 `h`（蓝/先手）与 `a`（灰/后手）。

客户端 → 服务端：`hello{name,token}`、`move{x,y}`、`rematch`、`chat{msg}`、`leave`、`ping`。

服务端 → 客户端：`welcome{role,token,code}`、`waiting{code}`、`start{role,you,opponent,turn,board,code}`、`resume{...,board,over,winner,line}`、`move{x,y,who,turn,win}`、`over{winner,reason,line}`、`opponent_left{grace}`、`opponent_back`、`rematch_offer`、`rematch_wait`、`chat{from,msg}`、`error{code,msg}`、`pong`。
