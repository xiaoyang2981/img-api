# img-api · 自建图床

一个可以整包搬走的独立图床服务：网页登录、多账户、拖拽上传、原图 + WebP 双版本、随机取图接口。

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

首次启动后打开 `http://localhost:2618/admin`，会进入**初始化管理员**页面：

1. 填写用户名和密码（至少 8 位）
2. 创建后自动登录
3. 之后在后台「账户」页添加其他成员

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
| 管理员 | 账户管理、全局设置、扫描目录、管理所有图片 |
| 成员 | 上传图片、查看共享图库、编辑/删除自己上传的图片 |

- 不开放自助注册，账户由管理员创建
- 图库是共享的：所有登录用户都能浏览
- 修改/删除图片时，服务端会校验“上传者本人或管理员”
- 登录状态使用 HttpOnly + SameSite=Lax 的会话 Cookie，默认 30 天
- 连续登录失败 10 次会锁定 15 分钟（按 IP + 用户名）

## 接口

公开接口：

| 接口 | 说明 |
|---|---|
| `GET /random` | 随机一张，302 跳转（默认 WebP） |
| `GET /random?format=json` | 返回 JSON，含 `url` / `origin` / `webp` |
| `GET /random?type=origin` | 强制返回原图 |
| `GET /random?tag=wolf,dragon` | 按标签筛选（需在设置里启用标签） |
| `GET /random?rating=sfw` | 按评级筛选：`sfw` / `questionable` / `nsfw` |
| `GET /i/{file}` | 原图，`Cache-Control: immutable` |
| `GET /w/{file}` | WebP 版本 |
| `GET /list?page=1&pageSize=40&q=&tag=&rating=` | 分页列表（默认需要登录） |
| `GET /info/{id}` | 单张图片信息 |
| `GET /stats` | 数量与体积统计 |
| `GET /health` | 健康检查 |

登录接口（`/admin/api` 下）：

| 接口 | 说明 |
|---|---|
| `POST /admin/api/auth/setup` | 首次初始化管理员，仅在账户表为空时可用 |
| `POST /admin/api/auth/login` | 用户名 + 密码登录，返回会话令牌 |
| `POST /admin/api/auth/logout` | 退出登录 |
| `GET /admin/api/auth/me` | 当前登录账户 |
| `POST /admin/api/auth/password` | 修改自己的密码 |

图片和设置接口（需要登录，写操作按权限校验）：

| 接口 | 说明 |
|---|---|
| `POST /admin/api/upload` | multipart，字段 `file`（可重复）、`tags`、`rating`、`title`、`source` |
| `GET /admin/api/images` | 后台列表（共享图库，带 `canEdit`） |
| `PATCH /admin/api/images/{id}` | 改标签 / 评级 / 标题 / 来源（本人或管理员） |
| `DELETE /admin/api/images/{id}` | 删除原图 + webp（本人或管理员） |
| `POST /admin/api/scan` | 扫描 `data/images/`（仅管理员） |
| `GET/PUT /admin/api/settings` | 读取设置 / 保存设置（保存仅管理员） |
| `GET /admin/api/stats` | 统计（需要登录） |

账户管理（仅管理员）：

| 接口 | 说明 |
|---|---|
| `GET /admin/api/users` | 账户列表（含图片数量） |
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
  -F "tags=wolf,night" \
  -F "rating=sfw"
```

浏览器页面使用 Cookie，不需要手动传令牌。

## 评级（SFW / Questionable / NSFW）

上传框左侧的下拉框是**手动评级**，不会自动识别图片内容：

- `SFW`：普通内容
- `Questionable`：擦边 / 需谨慎
- `NSFW`：成人内容

它只影响 `/random?rating=` 和 `/list?rating=` 的筛选。不填默认 `SFW`。

## 设置项

在 `/admin/setting` 里改，保存在 SQLite 的 `settings` 表：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enableTags` | `false` | 关闭时上传/编辑界面隐藏标签，`/random` 忽略 `tag` 参数，纯随机 |
| `randomPreferWebp` | `true` | `/random` 默认跳 WebP |
| `allowPublicList` | `false` | `/list` 是否需要登录 |
| `maxUploadMB` | `20` | 单张上限 |
| `port` | `2618` | 端口（`PORT` 环境变量优先） |

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
- 首次打开 `/admin` 创建管理员，迁移过来的无归属图片会自动归到第一任管理员
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
