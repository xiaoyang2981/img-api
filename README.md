# img-api · 自建图床

一个可以整包搬走的独立图床服务：公开首页、账户注册/登录、多账户、拖拽上传、原图 + WebP 双版本、随机取图接口。

- Node.js **>= 22.13**（使用内置 `node:sqlite`）
- 端口默认 `2618`，可用环境变量 `PORT` 覆盖
- 所有路径都基于项目目录，**整个文件夹移动到别处也能直接跑**
- 账户、会话、图片索引和设置都存在 SQLite：`data/img-api.db`
- 图片文件存 `data/images/` 和 `data/webp/`；API 水印缓存存 `data/watermarks/`

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
| **审核员** | 只能访问审核台、个人信息页和前台，不能上传、不能进入后台其他页面 |
| **成员** | 登录后上传图片、查看共享图库、编辑/删除自己上传的图片 |

- 第一个账户自动成为站长；公开注册的账户固定为成员
- 站长可以创建管理员/审核员/成员；管理员只能创建审核员/成员
- 管理员不能修改/禁用/删除管理员或站长账户
- 图库是共享的，但**只有审核通过的图片才会进入图库**
- 登录状态使用 HttpOnly + SameSite=Lax 的会话 Cookie，默认 30 天
- 连续登录失败 10 次会锁定 15 分钟（按 IP + 用户名）

### 个人信息

所有登录用户都可以访问 `/admin/profile`（`/profile` 也会重定向到这里）：

- 修改显示名；用户名作为账户标识不可修改
- 首次绑定邮箱：验证码发送到新邮箱，验证后完成绑定
- 修改已绑定邮箱：验证码发送到当前邮箱，确认后才能改成新邮箱
- 修改密码：需要当前密码 + 当前邮箱验证码；成功后其他设备的登录会失效
- 创建/吊销 API Token；创建时只在弹窗中显示一次
- 创建成功后当前浏览器会保存 Token，复制 API 地址时自动带上；换浏览器或本机 Token 失效时，复制前会确认重新生成 Token（旧 Token 失效）
- 吊销后需要重新点击「创建 Token」生成，旧 Token 立即失效
- 查看 Token 尾号、创建时间、限流触发次数和封禁状态
- 上传头像或从自己的图片中选择头像；头像接口默认输出 JPG，支持 `?type=png`
- 未绑定邮箱时不能修改密码，需要先绑定邮箱
- 邮箱或密码修改需要 SMTP 已配置；未配置时页面会提示并暂时禁用相关操作
- 站长/管理员在 `/admin/users` 为其他账户重置密码或设置邮箱；自己的邮箱和密码必须在个人信息页修改

### 审核流程

1. 成员/管理员/站长上传图片，或管理员扫描目录，图片状态为 `pending`（待审核）
2. 审核员/管理员/站长在 `/admin/review` 审核
3. 「通过」后状态变为 `approved`，才会出现在 `/api/v1rd`、`/api/v1`、`/list`、`/stats` 和前台；`/api/v2` 还需要单独加入 V2 图库
4. 「拒绝」后状态为 `rejected`，不进入图库，但上传者仍能在后台上看到
5. 未审核/被拒绝的图片，匿名访问 `/i`、`/w` 会返回 404；上传者、审核员、管理员、站长可以预览
6. 从 0.1.0 迁移过来的旧图片默认视为 `approved`

后台选择或拖入图片后不会立即上传，会先弹出确认框，显示待上传缩略图、标签、标题和来源，并可勾选「接口水印」；点「确认上传」后才真正开始上传。

接口水印只作用于通过 API 输出的图片：一张可见水印（默认右下角 `✨`，透明度和样式可在设置页调整）和一条不可见的 EXIF 标识。随机图、公开图片接口和头像接口都会遵循该开关；直接访问 `/i`、`/w` 不添加水印。

### 前台展示开关

每张已通过审核的图片在后台卡片下方有「隐藏前台 / 显示前台」按钮：

- 隐藏只影响前台首页展示，不会影响 `/api/v1rd`、`/api/v1`、`/api/v2`、`/list`、`/stats`、`/info` 或 `/i`、`/w` 直链
- 前台首页使用内部图片出口，只选择未隐藏的图片；该出口不列入公开 API
- 隐藏状态不会改变接口、统计或直链对已通过审核图片的开放程度
- 新图片默认在前台展示；审核状态变化不会自动改变这个开关
- 上传者可以控制自己的图片，管理员/站长可以控制所有图片

### V2 接口图库

`/api/v2` 使用独立的 V2 图库，不会直接调用全部已审核图片：

- 成员在 `/admin/v2` 选择自己已通过审核的图片提交，状态变为 `pending`
- 管理员/站长可以直接把已审核图片加入或移出 V2 图库
- 审核员/管理员/站长在 `/admin/review` 的「V2 接口审核」中处理成员申请
- 只有 `v2Status=approved` 的图片会进入 `/api/v2`
- `/api/v2rd` 从 V2 图库随机并返回 302 跳转
- 隐藏前台和 V2 图库互不影响
- V2 审核通过/拒绝会记录审核人和备注

### 邮箱验证

站长可以在 `/admin/setting` 的「邮箱验证」面板开启此功能，并配置 SMTP：

- 开启后，公开注册必须填写邮箱并输入邮箱验证码
- 开启后，登录页显示「忘记密码？」，通过用户名或邮箱接收验证码重置密码
- 验证码 10 分钟有效，同一邮箱 60 秒内不能重复发送，最多尝试 5 次
- 关闭后，注册不需要邮箱，忘记密码功能隐藏
- 用户自己的邮箱在个人信息页绑定或修改；站长/管理员可在账户页为其他账户设置邮箱
- SMTP 密码/授权码只保存不明文返回，设置页留空表示不修改
- SMTP 未配置时不能开启邮箱验证，注册页会提示暂不可用
- 设置页提供「发送测试邮件」按钮，可先保存 SMTP 配置再验证发信是否成功
- 注册验证码、密码重置、个人信息安全验证和测试邮件使用统一的品牌化 HTML 模板，并附带纯文本版本

SMTP 配置保存在 SQLite 的 `settings` 表；QQ/163 邮箱通常需要使用「授权码」而不是登录密码。

## 前台

- `/` 公开首页：左侧介绍 + 登录/注册按钮，右侧随机图片
- 左上角站点名称可在 `/admin/setting` 修改，默认「梦星的小图床」
- 所有页面支持深色/浅色切换，默认跟随系统，选择会保存在浏览器
- 页面底部显示站点版权信息
- 点图片或「换一张」会重新请求前台内部图片出口，每次从允许前台展示的图片中随机取图
- 首页图片通过内部出口输出，不再直接使用原图直链
- 登录且当前浏览器保存了 Token 时，「复制 API」会自动附带自己的 Token
- 图库为空时显示占位提示；登录后首页按钮会变成「进入后台」
- `/login` 登录，`/register` 注册（注册功能可在设置里关闭）
- `/docs` 使用文档：面向访客、成员、API 用户和管理员的完整操作说明

## 接口

公开接口：

| 接口 | 说明 |
|---|---|
| `GET /api/v1rd` | 随机一张，302 跳转；包含已通过图片（含前台隐藏） |
| `GET /api/v1rd?format=json` | 返回 JSON，含 `url` / `origin` / `webp` / `watermarked` |
| `GET /api/v1rd?type=origin` | 携带有效 Token/会话时返回原图，否则降级为 WebP |
| `GET /api/v2rd` | V2 图库随机一张，302 跳转到对应的 `/api/v2?id=...` |
| `GET /api/v1` | **直接返回图片字节，不 302**；包含已通过图片（含隐藏）；可用 `id` 指定单张 |
| `GET /api/v1?type=png` | 把选中图片转成 PNG 后直接返回，兼容只支持 PNG 的客户端 |
| `GET /api/v1.png` | 同上，URL 带 `.png` 后缀，兼容对扩展名敏感的客户端 |
| `GET /api/v2` | 随机图，只从 V2 接口图库中已加入的图片取图 |
| `GET /api/v2.png` | V2 图库随机 PNG |
| `GET /api/avatar?user={username}&type=jpg\|png` | 头像服务，默认 JPG；省略用户时使用当前用户或站长 |
| `GET /i/{file}` | 原图直链；未认证会跳转到 WebP，需 Token/会话，响应为私有缓存 |
| `GET /w/{file}` | WebP 版本 |
| `GET /list?page=1&pageSize=40&q=&tag=&tagMode=` | 分页列表（默认需要登录或 API Token） |
| `GET /info/{id}` | 单张图片信息 |
| `GET /stats` | 全部已通过审核图片的数量、标签与体积统计 |
| `GET /health` | 健康检查 |
| `GET /docs` | 前台使用文档（公开页面） |

### API 速率限制与 Token

`/api/v1rd`、`/api/v2rd`、`/api/v1`、`/api/v1.png`、`/api/v1/random.png`、`/api/v2`、`/api/v2.png`、`/api/v2/random.png`、`/list` 使用 60 秒窗口限流：

| 身份 | 默认额度 | 统计方式 |
|---|---:|---|
| 游客 | 200 次/分钟 | 按 IP |
| 注册用户 | 2000 次/分钟 | 按账户 |
| 站长 | 2,000,000 次/分钟 | 按账户，固定额度 |

- 每个账户在「个人信息」页可以创建或吊销自己的 **API Token**
- Token 是随机、非顺序的哈希值，**只在创建时显示一次**；关闭弹窗后只保留尾号
- 吊销只会让旧 Token 失效，再次使用需要重新点击「创建 Token」
- 支持三种携带方式：
  ```text
  Authorization: Bearer img_xxxxxxxx
  X-API-Token: img_xxxxxxxx
  /api/v1rd?token=img_xxxxxxxx
  ```
- 没带 Token 时：已登录会话按注册用户计算，否则按游客计算
- 未认证请求只能获取 WebP；`type=origin` 需要有效 Token 或登录会话
- 带错 Token 会直接返回 `401 Token 无效`
- 速率超限返回 `429`，并带 `Retry-After`、`X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`
- 游客和注册用户额度可在 `/admin/setting` 修改；站长固定额度不在设置页显示
- 限流计数在内存中，服务重启后清零
- `/w/{file}` 是长期缓存的公开图片直链，不打限流；`/i/{file}` 原图需要 Token/会话且使用私有缓存；`/api/avatar` 也不做随机限流

### Token 临时封禁

- 同一个 Token 在 10 分钟内 **5 次**触碰速率限制后，会自动临时封禁
- 封禁时长默认 12 小时，可在 `/admin/setting` 修改；管理员也可以在账户页针对单个账户手动设置
- 封禁期间该账户的 Token 请求返回 `403`，但网页登录会话仍可正常使用
- 账户页会显示每个账户的 Token 尾号、限流触发次数和封禁截止时间
- 管理员/站长可以对可管理账户执行「封禁」「调整封禁」「解除封禁」；解除封禁会清零触发次数
- 封禁状态保存在 SQLite，重启服务不会丢失

登录接口（`/admin/api` 下）：

| 接口 | 说明 |
|---|---|
| `POST /admin/api/auth/setup` | 首次初始化站长，仅在账户表为空时可用 |
| `GET /admin/api/auth/status` | 登录状态、是否已初始化、是否允许注册、是否开启邮箱验证 |
| `POST /admin/api/auth/register` | 公开注册（需开启允许注册；开启邮箱验证时需提供 `email` + `code`） |
| `POST /admin/api/auth/register-code` | 发送注册邮箱验证码，body：`{ "email": "..." }` |
| `POST /admin/api/auth/forgot-password` | 发送密码重置验证码，body：`{ "identifier": "用户名或邮箱" }` |
| `POST /admin/api/auth/reset-password` | 重置密码，body：`{ "identifier": "...", "code": "123456", "newPassword": "..." }` |
| `POST /admin/api/auth/login` | 用户名 + 密码登录，返回会话令牌 |
| `POST /admin/api/auth/logout` | 退出登录 |
| `GET /admin/api/auth/me` | 当前登录账户 |
| `GET /admin/api/profile` | 当前账户的个人资料、站点名和邮件服务状态 |
| `PUT /admin/api/profile` | 修改显示名，body：`{ "displayName": "..." }` |
| `POST /admin/api/profile/email-code` | 发送邮箱验证码；已绑定邮箱发到当前邮箱，未绑定发到新邮箱，body：`{ "newEmail": "..." }` |
| `PUT /admin/api/profile/email` | 修改/绑定邮箱，body：`{ "newEmail": "...", "code": "123456" }` |
| `POST /admin/api/profile/password-code` | 发送密码修改验证码，body：`{ "currentPassword": "..." }` |
| `PUT /admin/api/profile/password` | 修改密码，body：`{ "currentPassword": "...", "newPassword": "...", "code": "123456" }` |
| `POST /admin/api/profile/token` | 创建 API Token；Token 只在本次响应中返回 |
| `POST /admin/api/profile/token/revoke` | 吊销当前 Token，不自动生成新 Token |
| `POST /admin/api/auth/password` | 兼容接口；现在同样需要 `currentPassword` + `newPassword` + 邮箱验证码 `code` |

图片和设置接口（需要登录，写操作按权限校验）：

| 接口 | 说明 |
|---|---|
| `POST /admin/api/upload` | multipart，字段 `file`（可重复）、`tags`、`title`、`source`；上传后为待审核 |
| `GET /admin/api/images` | 后台列表，支持 `status=pending/approved/rejected`；成员只能看自己的图 |
| `PATCH /admin/api/images/{id}` | 改标签 / 标题 / 来源 / `visible` 前台展示状态（本人、管理员或站长） |
| `DELETE /admin/api/images/{id}` | 删除原图 + webp（本人、管理员或站长） |
| `POST /admin/api/scan` | 扫描 `data/images/`（站长/管理员），新增图片为待审核 |
| `GET/PUT /admin/api/settings` | 读取设置 / 保存设置（站长/管理员；端口仅站长） |
| `POST /admin/api/settings/test-email` | 发送 SMTP 测试邮件（仅站长），body：`{ "to": "收件邮箱" }` |
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
| `PATCH /admin/api/users/{id}` | 改角色 / 显示名 / 邮箱 / 禁用 / 重置密码；不能修改自己的邮箱或密码；`tokenBanned` + `tokenBanHours` 可封禁 Token |
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

- `/api/v1rd?tag=wolf`：只取带 `wolf` 标签的图
- `/api/v1rd?tag=wolf,dragon`：默认取带 `wolf` **或** `dragon` 的图
- `/api/v1rd?tag=wolf,dragon&tagMode=all`：只取同时带这两个标签的图
- `/api/v2?tag=...&tagMode=...` 使用相同规则，只从 V2 接口图库中已加入的图片取图
- `/list?tag=...&tagMode=...` 使用相同规则
- 标签在上传/编辑时填写，逗号分隔；自动转小写、去重

### 无法跟随 302 的客户端

`/api/v1rd` 默认返回 302 跳转。如果客户端不能跟随跳转，用 `/api/v1`，它直接返回图片字节：

```bash
# 保存一张随机 WebP
curl -o random.webp "http://localhost:2618/api/v1"

# 带 Token 取带 wolf 标签的原图（不带 Token 会降级为 WebP）
curl -o random.png "http://localhost:2618/api/v1?tag=wolf&type=origin&token=img_xxxxxxxx"

# 多标签：默认任意匹配，tagMode=all 要求全部匹配
curl -o random.webp "http://localhost:2618/api/v1?tag=wolf,dragon&tagMode=all"

# 只要 JSON 元数据
curl "http://localhost:2618/api/v1?format=json"
```

网站背景建议使用 V2 接口图库，只返回已加入 V2 的图片：

```bash
curl -o background.webp "http://localhost:2618/api/v2"
```

也可以直接用于 `<img>`：

V2 图库也可以使用随机跳转接口：

```bash
curl -L "http://localhost:2618/api/v2rd?tag=wolf"
```

```html
<img src="http://your-host:2618/api/v2?tag=wolf">
```

### HMCL 等不支持 WebP 的客户端

HMCL 支持网络背景图片，HTTP 和 HTTPS 都可以，**没有 HTTPS 不一定是失败原因**。如果 HMCL 不显示：

1. 先用带 `.png` 后缀的地址，避开 WebP 和扩展名识别问题：
   ```text
   http://your-host:2618/api/v1.png
   http://your-host:2618/api/v2.png
   http://your-host:2618/api/v1.png?token=img_xxxxxxxx
   http://your-host:2618/api/v1?type=png&token=img_xxxxxxxx
   ```
   把 `img_xxxxxxxx` 换成「个人信息」页里的 API Token 可以使用注册用户速率；不带 Token 时按游客速率，PNG 会从 WebP 转换，不能获取原图。
2. 确认 HMCL 所在机器能访问该地址，并且端口没有被防火墙拦截。
3. HMCL 默认会缓存网络背景图片，同一个 URL 可能一直使用第一次下载的图；如果一直不显示，可以关闭网络背景缓存，或换一个 URL 参数再试。
4. 如果仍然失败，查看 HMCL 日志里是否有背景图片加载错误。

`/api/v1.png` 会把图片按首帧转成 PNG，速度比直接返回 WebP 稍慢，但兼容性更好。

## 设置项

在 `/admin/setting` 里改，保存在 SQLite 的 `settings` 表：

| 字段 | 默认 | 说明 |
|---|---|---|
| `siteName` | `梦星的小图床` | 前台左上角显示的名称，可在设置页修改 |
| `randomPreferWebp` | `true` | `/api/v1rd` 默认跳 WebP；关闭后带 Token 的请求默认取原图，未认证仍强制 WebP |
| `watermarkText` | `✨` | 接口水印默认文字 |
| `watermarkOpacity` | `0.35` | 可见水印不透明度，0–1 |
| `watermarkPosition` | `bottom-right` | 水印位置 |
| `watermarkSize` | `7` | 水印大小，按短边百分比 |
| `watermarkColor` | `#ffffff` | 水印颜色 |
| `allowPublicList` | `false` | `/list` 是否需要登录 |
| `allowRegistration` | `true` | 是否允许前台公开注册；关闭后注册按钮隐藏，接口返回 403 |
| `enableEmailVerification` | `false` | 开启后注册必须邮箱验证码，忘记密码通过邮箱重置（仅站长可改） |
| `smtpHost` | 空 | SMTP 主机（仅站长可改） |
| `smtpPort` | `587` | SMTP 端口（仅站长可改） |
| `smtpSecure` | `false` | SMTP 使用 SSL/TLS（仅站长可改） |
| `smtpUser` | 空 | SMTP 用户名（仅站长可改） |
| `smtpPass` | 空 | SMTP 密码/授权码，只保存不回传（仅站长可改） |
| `rateLimitGuest` | `200` | 游客每分钟 GET 次数（按 IP） |
| `rateLimitUser` | `2000` | 注册用户每分钟 GET 次数（按账户） |
| `tokenBanHours` | `12` | Token 触发频繁超限后的默认临时封禁小时数 |
| `smtpFrom` | 空 | 发件地址（仅站长可改） |
| `maxUploadMB` | `20` | 单张上限 |
| `port` | `2618` | 端口（`PORT` 环境变量优先；仅站长可修改） |

标签始终启用；`/api/v1rd`、`/api/v1`、`/api/v2` 和 `/list` 都支持按标签筛选。

## 数据与备份

运行时数据：

```
data/img-api.db       # SQLite：账户、会话、图片元数据、设置
data/images/          # 原图
data/webp/            # WebP 副本
data/watermarks/      # API 水印缓存（可删除，按需重建）
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

如果不是 HTTPS 直连，记得让反代传 `X-Forwarded-Proto`，这样会话 Cookie 会带上 `Secure`，复制出来的图片链接也会使用 HTTPS。

### Cloudflare 缓存建议

WebP 直链 `/w/*` 会发送长期公共缓存和 Cloudflare 可识别的响应头；原图 `/i/*` 使用私有缓存：

- `/w/*`：`Cache-Control: public, max-age=31536000, immutable`
- `/i/*`：`Cache-Control: private, max-age=3600`
- `CDN-Cache-Control` / `Cloudflare-CDN-Cache-Control`
- `ETag` 和 `Last-Modified`

在 Cloudflare 中建议配置：

1. 开启代理，SSL/TLS 使用 **Full (strict)**。
2. 为 `/w/*` 添加 Cache Rule，启用缓存；Edge TTL 可设为 1 年，Browser TTL 选择 Respect origin。`/i/*` 原图可能携带 Token，响应为私有缓存，不要让公共 CDN 缓存原图。
3. `/api/v1rd`、`/api/v1`、`/api/v1.png`、`/api/v2`、`/api/v2.png`、`/list`、`/info`、`/stats` 保持不缓存，避免随机图和用户列表被 CDN 缓存。
4. 启用 Brotli；图片请求优先使用 `/w/...webp` 或 `/api/v1.png`，不要在图片直链后加无意义的随机参数。
5. 如果使用 Nginx 再转发到 Node，确保传递 `Host`、`X-Forwarded-Proto`，并保留 Cloudflare 的 `CF-Visitor` 请求头。

如果没有 Cloudflare 或反代没有传 `X-Forwarded-Proto`，后台复制出来的图片链接仍会是 Node 看到的 `http://` 地址。

### GitHub 自动同步

仓库包含 `.github/workflows/sync-from-gitee.yml`，用于从 Gitee 镜像同步到 GitHub：

- 默认每 30 分钟执行一次
- 也可以在 GitHub Actions 页面手动运行
- 同步所有分支和 tag
- 自动检测缺失的 GitHub Release，并读取 Gitee 对应 Release 的标题、说明和预发布标记
- 首次运行会补齐所有历史 Release；之后只创建新 tag 对应的 Release
- 如果 Gitee 还没有对应 Release，会尝试从 `CHANGELOG.md` 提取版本说明，再回退到 tag 信息
- 已存在的 GitHub Release 不会被覆盖
- Gitee 是唯一源仓库，GitHub 上的独立提交可能被覆盖

Gitee 仓库已公开，因此不需要 `GITEE_TOKEN`。工作流默认使用 GitHub Actions 自带的 `GITHUB_TOKEN` 推送和创建 Release。

如需同步 workflow 文件本身的改动，可以在 GitHub 的 `Settings → Secrets and variables → Actions` 中额外配置：

- `GH_SYNC_TOKEN`：GitHub PAT，具备 Contents 和 Workflows 读写权限

不配置 `GH_SYNC_TOKEN` 时，工作流会自动回退到 `GITHUB_TOKEN`。

GitHub 仓库地址：`https://github.com/xiaoyang2981/img-api`

## 接入其他服务

`/api/v2` 天然适合被别的站点当网站背景图源，它只返回已加入 V2 图库的图片。例如接回 Meting 首页：

```bash
# 在 Meting 项目里
BG_REMOTE_API="http://127.0.0.1:2618/api/v2" node.exe node.js
```

或者前端直接引用：

```html
<img src="http://your-host:2618/api/v2">
```

## 安全说明

- 密码使用 scrypt 加盐哈希，不存明文
- 会话令牌只存 SHA-256 哈希；Cookie 为 HttpOnly + SameSite=Lax
- 只接受 png / jpg / webp / gif / avif，拒绝 SVG（避免脚本注入）
- 图片文件名限制为十六进制 ID + 扩展名，挡掉路径穿越
- 未携带有效 Token 或登录会话时，所有图片接口只能输出 WebP，原图直链会跳转到 WebP 出口
- 原图访问、接口水印和头像接口都会校验账户/图片状态；前台隐藏只影响首页展示，不作为私有权限

## 许可证

本项目使用 **GNU General Public License v3.0 only**（GPL-3.0-only）。

完整许可证文本见 [LICENSE](LICENSE)。
