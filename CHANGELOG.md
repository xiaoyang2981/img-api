# Changelog

## 0.1.0

首个发布版本，一个可以整包搬走的独立图床服务。

### 功能

- 网页后台：拖拽 / 多选上传，支持标签、评级、标题、来源
- 原图 + WebP 双版本：原图存 `data/images/`，WebP 存 `data/webp/`
- 内容寻址命名（sha256）：同一张图重复上传自动去重
- 随机图接口 `/random`：默认 302 跳 WebP，支持 `?type=origin`、`?format=json`、`?tag=`、`?rating=`
- 图片接口 `/i/{file}`、`/w/{file}`，带 `immutable` 缓存头
- 分页列表 `/list`、单图信息 `/info/{id}`、统计 `/stats`、健康检查 `/health`
- 管理接口：上传、列表、编辑（标签/评级/标题/来源）、删除、扫描目录、设置、重置令牌
- 设置页 `/admin/setting`：端口、标签开关、默认 WebP、公开列表、上传大小上限、管理令牌
- 反向代理子路径适配；所有路径基于项目目录，可整体迁移
- 只接受 png / jpg / webp / gif / avif，拒绝 SVG 以防脚本注入

### 说明

- 端口默认 `2618`，`PORT` 环境变量优先
- 运行时数据（图片、索引、配置/令牌）不纳入版本控制
- 启动方式：`node server.js`；`npm` 仅用于安装依赖
