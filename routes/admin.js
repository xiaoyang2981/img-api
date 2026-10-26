import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PUBLIC_DIR, getConfig, regenerateToken, updateConfig } from '../config.js';
import { requireAuth } from '../lib/auth.js';
import { decorate } from './public.js';
import * as index from '../lib/index.js';
import * as store from '../lib/store.js';

export const adminRoutes = new Hono();

const ID_PATTERN = /^[a-f0-9]{24}$/;

const settingPayload = () => {
    const config = getConfig();
    return {
        port: config.port,
        enableTags: config.enableTags,
        randomPreferWebp: config.randomPreferWebp,
        allowPublicList: config.allowPublicList,
        maxUploadMB: config.maxUploadMB,
        token: config.adminToken
    };
};

const serveHtml = async (c, fileName) => {
    try {
        const html = await readFile(join(PUBLIC_DIR, fileName), 'utf8');
        c.header('Cache-Control', 'no-store');
        return c.html(html);
    } catch {
        return c.text('页面文件缺失: ' + fileName, 500);
    }
};

adminRoutes.get('/', (c) => serveHtml(c, 'admin.html'));
adminRoutes.get('/setting', (c) => serveHtml(c, 'setting.html'));

// 以下接口全部需要令牌
adminRoutes.use('/api/*', requireAuth);

adminRoutes.get('/api/settings', (c) => c.json(settingPayload()));

adminRoutes.put('/api/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    await updateConfig(body);
    return c.json(settingPayload());
});

adminRoutes.post('/api/token', async (c) => {
    const token = await regenerateToken();
    return c.json({ token });
});

adminRoutes.get('/api/images', (c) => {
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize')) || 40));
    const keyword = (c.req.query('q') || '').trim().toLowerCase();
    const rating = (c.req.query('rating') || '').trim().toLowerCase();

    let pool = [...index.getAll()];

    if (rating) {
        pool = pool.filter((image) => image.rating === rating);
    }
    if (keyword) {
        pool = pool.filter((image) => {
            const haystack = [image.id, image.title, image.source, ...(image.tags || [])].join(' ');
            return haystack.toLowerCase().includes(keyword);
        });
    }

    pool.reverse();

    const total = pool.length;
    const start = (page - 1) * pageSize;

    return c.json({
        total,
        page,
        pageSize,
        pages: Math.ceil(total / pageSize) || 1,
        stats: index.stats(),
        images: pool.slice(start, start + pageSize).map((image) => decorate(c, image))
    });
});

// POST /admin/api/upload —— multipart/form-data，可一次传多张，字段名都叫 file
adminRoutes.post('/api/upload', async (c) => {
    const config = getConfig();
    const limit = config.maxUploadMB * 1024 * 1024;

    let body;

    try {
        body = await c.req.parseBody({ all: true });
    } catch {
        return c.json({ error: true, message: '上传内容解析失败，请使用 multipart/form-data' }, 400);
    }

    const files = [body.file ?? []].flat().filter((item) => item instanceof File);

    if (!files.length) {
        return c.json({ error: true, message: '没有收到文件（字段名应为 file）' }, 400);
    }

    const meta = {
        tags: [body.tags ?? ''].flat().join(','),
        rating: [body.rating ?? ''].flat()[0] || 'sfw',
        title: [body.title ?? ''].flat()[0] || '',
        source: [body.source ?? ''].flat()[0] || ''
    };

    const results = [];
    const errors = [];

    for (const file of files) {
        if (file.size > limit) {
            errors.push({ name: file.name, message: `超过 ${config.maxUploadMB}MB 限制` });
            continue;
        }

        try {
            const buffer = Buffer.from(await file.arrayBuffer());
            const result = await store.addFromBuffer(buffer, meta);
            results.push({
                name: file.name,
                duplicate: result.duplicate,
                image: decorate(c, result.image)
            });
        } catch (error) {
            errors.push({ name: file.name, message: error.message });
        }
    }

    return c.json({ results, errors }, results.length ? 200 : 400);
});

adminRoutes.patch('/api/images/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) {
        return c.json({ error: true, message: 'ID 格式不正确' }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const image = await index.updateImage(id, body);

    if (!image) {
        return c.json({ error: true, message: '图片不存在' }, 404);
    }

    return c.json(decorate(c, image));
});

adminRoutes.delete('/api/images/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) {
        return c.json({ error: true, message: 'ID 格式不正确' }, 400);
    }

    const image = await store.removeImage(id);
    if (!image) {
        return c.json({ error: true, message: '图片不存在' }, 404);
    }

    return c.json({ deleted: image.id });
});

// 扫描 data/images/，把手动丢进去的图片补进索引
adminRoutes.post('/api/scan', async (c) => {
    const { added, skipped } = await store.scanDirectory();
    return c.json({
        added: added.length,
        skipped,
        images: added.map((image) => decorate(c, image))
    });
});

adminRoutes.get('/api/stats', (c) => c.json(index.stats()));
