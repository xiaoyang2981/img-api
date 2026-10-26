# img-api · 自建图床

一个可以整包搬走的独立图床服务：公开首页、账户注册/登录、多账户、拖拽上传、原图 + WebP 双版本、随机取图接口。

- Node.js **>= 22.13**（使用内置 `node:sqlite`）
- 端口默认 `2618`，可用环境变量 `PORT` 覆盖
- 所有路径都基于项目目录，**整个文件夹移动到别处也能直接跑**
- 账户、会话、图片索引和设置都存在 SQLite：`data/img-api.db`
- 图片文件仍存 `data/images/` 和 `data/webp/`

## 启动

```bash
npm install    # 只用于安装依赖
node server.js # 启动服务
```

首次启动后打开 `http://localhost:2618/admin`，会进入**初始化站长**页面：

1. 填写用户名和密码（至少 8 位）
2. 创建后自动登录，这个账户的身份组是**站长**
3. 之后可以在后台「账户」页添加管理员、审核员或成员，或让成员在前台自行注册

公开首页是 `http://localhost:2618/`：左侧是介绍和登录/注册入口，右侧会随机调用图库图片，点「换一张」或刷新页面就会换图。

改端口有两种方式，环境变量优先：

```bash
# Linux / macOS
PORT=3000 node server.js
```

```powershell
# Windows PowerShell
$env:PORT=3000; node server.js
```

也可以在 `/admin/setting` 页面里改（重启生效）。

## 账户与权限

| 角色 | 权限 |
|---|---|
| **站长** | 最高权限：全部设置（包括端口）、账户管理、审核、图片管理、扫描目录 |
| **管理员** | 审核、图片管理、账户管理（只能管理审核员和成员）、普通设置；**不能修改端口** |
| **审核员** | 只能访问审核台和前台，不能上传、不能进入后台其他页面 |
| **成员** | 登录后上传图片、查看共享图库、编辑/删除自己上传的图片 |

- 第一个账户自动成为站长；公开注册的账户固定为成员
- 站长可以创建管理员/审核员/成员；管理员只能创建审核员/成员
- 管理员不能修改/禁用/删除管理员或站长账户
- 图库是共享的，但**只有审核通过的图片才会进入图库**
- 登录状态使用 HttpOnly + SameSite=Lax 的会话 Cookie，默认 30 天
- 连续登录失败 10 次会锁定 15 分钟（按 IP + 用户名）

### 审核流程

1. 成员/管理员/站长上传图片，或管理员扫描目录，图片状态为 `pending`（待审核）
2. 审核员/管理员/站长在 `/admin/review` 审核
3. 「通过」后状态变为 `approved`，才会出现在 `/random`、`/list`、`/stats` 和前台
4. 「拒绝」后状态为 `rejected`，不进入图库，但上传者仍能在后台上看到
5. 未审核/被拒绝的图片，匿名访问 `/i`、`/w` 会返回 404；上传者、审核员、管理员、站长可以预览
6. 从 0.1.0 迁移过来的旧图片默认视为 `approved`

后台选择或拖入图片后不会立即上传，会先弹出确认框，显示待上传缩略图、标签、标题和来源；点「确认上传」后才真正开始上传。

## 前台

- `/` 公开首页：左侧介绍 + 登录/注册按钮，右侧随机图片
- 左上角站点名称可在 `/admin/setting` 修改，默认「梦星的小图床」
- 点图片或「换一张」会重新请求 `/random?format=json`，每次随机取图
- 图库为空时显示占位提示；登录后首页按钮会变成「进入后台」
- `/login` 登录，`/register` 注册（注册功能可在设置里关闭）

## 接口

公开接口：

| 接口 | 说明 |
|---|---|
| `GET /random` | 随机一张，302 跳转（默认 WebP） |
| `GET /random?format=json` | 返回 JSON，含 `url` / `origin` / `webp` |
| `GET /random?type=origin` | 强制返回原图 |
| `GET /random?tag=wolf` | 只从带 `wolf` 标签的图片里随机 |
| `GET /random?tag=wolf,dragon` | 从带 `wolf` **或** `dragon` 的图片里随机 |
| `GET /random?tag=wolf,dragon&tagMode=all` | 只从同时带 `wolf` 和 `dragon` 的图片里随机 |
| `GET /api/v1` | **直接返回图片字节，不 302**；支持同样的 `tag` / `tagMode` / `type` / `format=json` |
| `GET /i/{file}` | 原图，`Cache-Control: immutable` |
| `GET /w/{file}` | WebP 版本 |
| `GET /list?page=1&pageSize=40&q=&tag=&tagMode=` | 分页列表（默认需要登录） |
| `GET /info/{id}` | 单张图片信息 |
| `GET /stats` | 数量与体积统计 |
| `GET /health` | 健康检查 |

登录接口（`/admin/api` 下）：

| 接口 | 说明 |
|---|---|
| `POST /admin/api/auth/setup` | 首次初始化站长，仅在账户表为空时可用 |
| `GET /admin/api/auth/status` | 登录状态、是否已初始化、是否允许注册 |
| `POST /admin/api/auth/register` | 公开注册（需开启允许注册，注册账户固定为成员） |
| `POST /admin/api/auth/login` | 用户名 + 密码登录，返回会话令牌 |
| `POST /admin/api/auth/logout` | 退出登录 |
| `GET /admin/api/auth/me` | 当前登录账户 |
| `POST /admin/api/auth/password` | 修改自己的密码 |

图片和设置接口（需要登录，写操作按权限校验）：

| 接口 | 说明 |
|---|---|
| `POST /admin/api/upload` | multipart，字段 `file`（可重复）、`tags`、`title`、`source`；上传后为待审核 |
| `GET /admin/api/images` | 后台列表，支持 `status=pending/approved/rejected`；成员只能看自己的图 |
| `PATCH /admin/api/images/{id}` | 改标签 / 标题 / 来源（本人、管理员或站长） |
| `DELETE /admin/api/images/{id}` | 删除原图 + webp（本人、管理员或站长） |
| `POST /admin/api/scan` | 扫描 `data/images/`（站长/管理员），新增图片为待审核 |
| `GET/PUT /admin/api/settings` | 读取设置 / 保存设置（站长/管理员；端口仅站长） |
| `GET /admin/api/stats` | 统计（站长/管理员/成员） |

审核接口（站长 / 管理员 / 审核员）：

| 接口 | 说明 |
|---|---|
| `GET /admin/api/review?status=pending&page=1` | 审核列表，`status` 可为 `pending` / `approved` / `rejected` |
| `PATCH /admin/api/review/{id}` | 审核图片：`{ "status": "approved" \| "rejected" \| "pending", "note": "可选备注" }` |

账户管理（站长 / 管理员）：

| 接口 | 说明 |
|---|---|
| `GET /admin/api/users` | 账户列表（含图片数量、可分配身份组） |
| `POST /admin/api/users` | 创建账户：`username`、`password`、`role`、`displayName` |
| `PATCH /admin/api/users/{id}` | 改角色 / 显示名 / 禁用 / 重置密码 |
| `DELETE /admin/api/users/{id}` | 删除账户（图片保留，变为无归属） |

### 命令行上传

先登录拿会话令牌，再用 `Authorization: Bearer`：

```bash
TOKEN=$(curl -s http://localhost:2618/admin/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"你的密码"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')

curl -X POST http://localhost:2618/admin/api/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@wallpaper.png" \
  -F "tags=wolf,night"
```

浏览器页面使用 Cookie，不需要手动传令牌。

## 标签

评级系统已移除，标签是唯一的分类方式，并且始终启用。

- `/random?tag=wolf`：只取带 `wolf` 标签的图
- `/random?tag=wolf,dragon`：默认取带 `wolf` **或** `dragon` 的图
- `/random?tag=wolf,dragon&tagMode=all`：只取同时带这两个标签的图
- `/list?tag=...&tagMode=...` 使用相同规则
- 标签在上传/编辑时填写，逗号分隔；自动转小写、去重

### 无法跟随 302 的客户端

`/random` 默认返回 302 跳转。如果客户端不能跟随跳转，用 `/api/v1`，它直接返回图片字节：

```bash
# 保存一张随机 WebP
curl -o random.webp "http://localhost:2618/api/v1"

# 只取带 wolf 标签的图，要原图
curl -o random.png "http://localhost:2618/api/v1?tag=wolf&type=origin"

# 多标签：默认任意匹配，tagMode=all 要求全部匹配
curl -o random.webp "http://localhost:2618/api/v1?tag=wolf,dragon&tagMode=all"

# 只要 JSON 元数据
curl "http://localhost:2618/api/v1?format=json"
```

也可以直接用于 `<img>`：

```html
<img src="http://your-host:2618/api/v1?tag=wolf">
```

## 设置项

在 `/admin/setting` 里改，保存在 SQLite 的 `settings` 表：

| 字段 | 默认 | 说明 |
|---|---|---|
| `siteName` | `梦星的小图床` | 前台左上角显示的名称，可在设置页修改 |
| `randomPreferWebp` | `true` | `/random` 默认跳 WebP |
| `allowPublicList` | `false` | `/list` 是否需要登录 |
| `allowRegistration` | `true` | 是否允许前台公开注册；关闭后注册按钮隐藏，接口返回 403 |
| `maxUploadMB` | `20` | 单张上限 |
| `port` | `2618` | 端口（`PORT` 环境变量优先；仅站长可修改） |

标签功能默认关闭；需要按标签筛选时再到设置里打开。

## 数据与备份

运行时数据：

```
data/img-api.db       # SQLite：账户、会话、图片元数据、设置
data/images/          # 原图
data/webp/            # WebP 副本
```

备份建议先停服务，再复制 `data/img-api.db`、`data/images/`、`data/webp/`。运行中也可以用 SQLite 的在线备份：

```bash
sqlite3 data/img-api.db ".backup 'backup.db'"
```

想换数据目录（例如放到数据盘）：

```bash
IMG_API_DATA_DIR=/srv/img-api-data node server.js
```

## 从 0.1.0 升级

- 旧版 `data/index.json` 会在首次启动时自动导入 SQLite，成功后改名为 `index.json.migrated`
- 旧版 `data/config.json` 里的设置会自动迁移；`adminToken` 不再使用，会被忽略
- 旧用户自动迁移：首个管理员升级为**站长**，其他管理员保留管理员，旧 `user` 变为成员
- 旧图片自动标记为已通过，升级后不会突然从图库消失
- 首次打开 `/admin` 创建站长，迁移过来的无归属图片会自动归到第一任站长
- 旧版“管理令牌”失效，请改用用户名 + 密码登录

## 部署到服务器

```bash
# 把整个文件夹拷过去（不用带 node_modules）
scp -r img-api user@server:/opt/

cd /opt/img-api
npm install --omit=dev
PORT=2618 node server.js
```

systemd 示例：

```ini
[Unit]
Description=img-api
After=network.target

[Service]
WorkingDirectory=/opt/img-api
ExecStart=/usr/bin/node server.js
Environment=PORT=2618
Restart=always

[Install]
WantedBy=multi-user.target
```

Nginx 反代（想挂子路径也能用，接口里的跳转和页面链接会跟着子路径走）：

```nginx
location /img/ {
    proxy_pass http://127.0.0.1:2618/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 50m;
}
```

如果不是 HTTPS 直连，记得让反代传 `X-Forwarded-Proto`，这样会话 Cookie 会带上 `Secure`。

## 接入其他服务

`/random` 天然适合被别的站点当图源。例如把它接回 Meting 首页的背景图：

```bash
# 在 Meting 项目里
BG_REMOTE_API="http://127.0.0.1:2618/random" node.exe node.js
```

或者前端直接引用：

```html
<img src="http://your-host:2618/random">
```

## 安全说明

- 密码使用 scrypt 加盐哈希，不存明文
- 会话令牌只存 SHA-256 哈希；Cookie 为 HttpOnly + SameSite=Lax
- 只接受 png / jpg / webp / gif / avif，拒绝 SVG（避免脚本注入）
- 图片文件名限制为十六进制 ID + 扩展名，挡掉路径穿越
