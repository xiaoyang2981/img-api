import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import os from 'node:os';

import { getPort, initConfig } from './config.js';
import { closeDb, countUsers } from './lib/db.js';
import { DB_FILE } from './lib/paths.js';
import { servePage } from './lib/pages.js';
import { loadIndex } from './lib/index.js';
import { adminRoutes } from './routes/admin.js';
import {
    basePath,
    healthHandler,
    imageHandler,
    infoHandler,
    listHandler,
    randomHandler,
    statsHandler,
    webpHandler
} from './routes/public.js';

const app = new Hono();

app.use('*', cors());
app.use('*', logger());

// —— 公开接口 ——
app.get('/random', randomHandler);
app.get('/i/:name', imageHandler);
app.get('/w/:name', webpHandler);
app.get('/list', listHandler);
app.get('/info/:id', infoHandler);
app.get('/stats', statsHandler);
app.get('/health', healthHandler);

// —— 兼容直接访问 / 旧链接 ——
// 后台的「设置」链接曾经是相对路径，在 /admin 下会解析成 /setting
app.get('/setting', (c) => c.redirect(`${basePath(c)}/admin/setting`));
app.get('/setting/', (c) => c.redirect(`${basePath(c)}/admin/setting`));
app.get('/admin/', (c) => c.redirect(`${basePath(c)}/admin`));

// —— 管理后台 ——
app.route('/admin', adminRoutes);

// —— 公开页面 ——
app.get('/', (c) => servePage(c, 'index.html'));
app.get('/login', (c) => servePage(c, 'login.html'));
app.get('/register', (c) => servePage(c, 'login.html'));

app.notFound((c) =>
    c.json({
        error: true,
        message: '未找到接口',
        path: c.req.path,
        endpoints: {
            random: '/random',
            origin: '/i/{file}',
            webp: '/w/{file}',
            list: '/list',
            info: '/info/{id}',
            stats: '/stats',
            health: '/health',
            admin: '/admin'
        }
    }, 404)
);

app.onError((error, c) => {
    console.error('应用错误:', error);
    return c.json({ error: true, message: error.message || '服务器内部错误' }, 500);
});

const getLocalIP = () => {
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }

    return '127.0.0.1';
};

const start = async () => {
    const config = await initConfig();
    const images = await loadIndex();
    const port = getPort();
    const localIP = getLocalIP();

    const server = serve({ fetch: app.fetch, port }, () => {
        const userCount = countUsers();
        console.log('');
        console.log('🖼️  图床服务已启动');
        console.log(`📡 本地地址: http://localhost:${port}`);
        console.log(`📡 网络地址: http://${localIP}:${port}`);
        console.log(`🎲 随机图接口: http://localhost:${port}/random`);
        console.log(`🔧 管理后台:   http://localhost:${port}/admin`);
        console.log('');
        console.log('🔐 账户系统: 用户名 + 密码（首次打开后台创建管理员）');
        console.log(`   （账户、会话、图片索引和设置都保存在 ${DB_FILE}）`);
        console.log('');
        console.log(`📦 图库数量: ${images.length} 张 | 标签功能: ${config.enableTags ? '已启用' : '未启用'}`);
        console.log(`👤 账户数量: ${userCount} 个${userCount ? '' : '（尚未初始化）'}`);
        console.log(`🔌 端口可通过环境变量 PORT 覆盖（当前 ${port}）`);
        console.log('');
    });

    let closing = false;

    const shutdown = () => {
        if (closing) return;
        closing = true;

        console.log('\n正在关闭图床服务...');
        server.close(() => {
            closeDb();
            console.log('✅ 已关闭');
            process.exit(0);
        });

        setTimeout(() => process.exit(1), 5000);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
};

start().catch((error) => {
    console.error('❌ 启动失败:', error);
    process.exit(1);
});
