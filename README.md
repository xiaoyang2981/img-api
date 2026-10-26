# img-api · 自建图床

一个可以整包搬走的独立图床服务：网页拖拽上传、原图 + WebP 双版本、随机取图接口。

- 端口默认 `2618`，可用环境变量 `PORT` 覆盖
- 所有路径都基于项目目录，**整个文件夹移动到别处也能直接跑**
- 数据只存在 `data/` 里（图片 + `index.json` + `config.json`）

## 启动

```bash
npm install
npm start
```

首次启动会自动生成管理令牌并打印在控制台：

```
🖼️  图床服务已启动
📡 本地地址: http://localhost:2618
🎲 随机图接口: http://localhost:2618/random
🔧 管理后台:   http://localhost:2618/admin
🔑 管理令牌: xxxxxxxxxxxxxxxxxxxxxxxx
```

改端口有两种方式，环境变量优先：

```bash
PORT=3000 npm start
```

或者在 `/admin/setting` 页面里改（重启生效）。

## 使用

1. 打开 `http://localhost:2618/admin`
2. 粘贴管理令牌 → 进入
3. 把图片拖进上传框（可多选），需要的话填标签 / 评级 / 来源
4. 上传后自动：原图存 `data/images/{id}.{ext}`，WebP 存 `data/webp/{id}.webp`

图片用 sha256 内容寻址命名，同一张图重复上传会自动去重。

## 接口

| 接口 | 说明 |
|---|---|
| `GET /random` | 随机一张，302 跳转（默认 WebP） |
| `GET /random?format=json` | 返回 JSON，含 `url` / `origin` / `webp` |
| `GET /random?type=origin` | 强制返回原图 |
| `GET /random?tag=wolf,dragon` | 按标签筛选（需在设置里启用标签） |
| `GET /random?rating=sfw` | 按评级筛选：`sfw` / `questionable` / `nsfw` |
| `GET /i/{file}` | 原图，`Cache-Control: immutable` |
| `GET /w/{file}` | WebP 版本 |
| `GET /list?page=1&pageSize=40&q=&tag=&rating=` | 分页列表（默认需要令牌） |
| `GET /info/{id}` | 单张图片信息 |
| `GET /stats` | 数量与体积统计 |
| `GET /health` | 健康检查 |

管理接口（都需要 `Authorization: Bearer <token>`）：

| 接口 | 说明 |
|---|---|
| `POST /admin/api/upload` | multipart，字段 `file`（可重复）、`tags`、`rating`、`title`、`source` |
| `GET /admin/api/images` | 后台列表 |
| `PATCH /admin/api/images/{id}` | 改标签 / 评级 / 标题 / 来源 |
| `DELETE /admin/api/images/{id}` | 删除（原图 + webp） |
| `POST /admin/api/scan` | 扫描 `data/images/`，把手动丢进去的图补进索引 |
| `GET/PUT /admin/api/settings` | 读取 / 保存设置 |
| `POST /admin/api/token` | 重新生成令牌 |

### 命令行上传

```bash
curl -X POST http://localhost:2618/admin/api/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@wallpaper.png" \
  -F "tags=wolf,night" \
  -F "rating=sfw"
```

## 设置项

在 `/admin/setting` 里改，落在 `data/config.json`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enableTags` | `false` | 关闭时上传界面不显示标签，`/random` 忽略 `tag` 参数，纯随机 |
| `randomPreferWebp` | `true` | `/random` 默认跳 WebP |
| `allowPublicList` | `false` | `/list` 是否需要令牌 |
| `maxUploadMB` | `20` | 单张上限 |
| `port` | `2618` | 端口（`PORT` 环境变量优先） |
| `adminToken` | 首次生成 | 管理令牌 |

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

Nginx 反代（想挂子路径也能用，接口里的跳转会跟着子路径走）：

```nginx
location /img/ {
    proxy_pass http://127.0.0.1:2618/;
    proxy_set_header Host $host;
    client_max_body_size 50m;
}
```

## 备份 / 迁移

只需要备份这三个东西：

```
data/images/     # 原图
data/webp/       # WebP 副本（丢了可以重新生成，见下）
data/index.json  # 元数据（标签、评级、尺寸）
data/config.json # 设置和令牌
```

换了目录或者换了机器后，如果 `data/index.json` 丢了也没关系：把图片放进 `data/images/`，
打开后台点「扫描目录」即可重新建索引（webp 会一并补生成）。
