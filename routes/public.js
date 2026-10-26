import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { IMAGE_DIR, WEBP_DIR, getConfig } from '../config.js';
import { getAuthUser } from '../lib/auth.js';
import { MIME } from '../lib/image.js';
import * as index from '../lib/index.js';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// 处理反向代理子路径：用实际命中的路由段数反推前缀
// /i/abc.png -> ""，/img/i/abc.png -> "/img"，/admin/api/upload -> ""
export const basePath = (c) => {
    const pathname = new URL(c.req.url).pathname;
    const routePath = c.req.routePath || '';
    const routeSegments = routePath.split('/').filter(Boolean).length;
    if (!routeSegments) return '';

    const segments = pathname.split('/').filter(Boolean);
    const base = segments.slice(0, Math.max(0, segments.length - routeSegments));

    return base.length ? '/' + base.join('/') : '';
};

export const decorate = (c, image) => {
    const origin = new URL(c.req.url).origin;
    const prefix = basePath(c);
    const { ownerId, ...rest } = image;

    return {
        ...rest,
        url: `${origin}${prefix}/i/${image.file}`,
        webpUrl: image.webp ? `${origin}${prefix}/w/${image.webp}` : null
    };
};

const serve = async (c, dir, name, mime) => {
    // 文件名只能是「十六进制 id.扩展名」，同时挡掉路径穿越
    if (!/^[a-z0-9]+\.[a-z0-9]+$/i.test(name)) {
        return c.text('Not Found', 404);
    }

    const filePath = join(dir, name);

    try {
        const info = await stat(filePath);
        if (!info.isFile()) {
            return c.text('Not Found', 404);
        }

        // 直接读成 Buffer：图片不大，且避免 Node 里把文件流塞进 Response 时
        // 客户端提前断开导致的 ReadableStream 已关闭错误（会直接崩进程）
        const body = await readFile(filePath);

        return new Response(body, {
            headers: {
                'Content-Type': mime,
                'Content-Length': String(body.length),
                'Cache-Control': CACHE_CONTROL
            }
        });
    } catch {
        return c.text('Not Found', 404);
    }
};

// GET /random?tag=&rating=&type=origin|webp&format=json
export const randomHandler = async (c) => {
    const config = getConfig();
    let pool = index.getAll();

    // 默认不启用标签，这时 tag 参数会被忽略，纯随机
    if (config.enableTags) {
        const tags = (c.req.query('tag') || '')
            .split(',')
            .map((tag) => tag.trim().toLowerCase())
            .filter(Boolean);

        if (tags.length) {
            pool = pool.filter((image) => tags.every((tag) => (image.tags || []).includes(tag)));
        }
    }

    const rating = (c.req.query('rating') || '').trim().toLowerCase();
    if (rating) {
        pool = pool.filter((image) => image.rating === rating);
    }

    if (!pool.length) {
        return c.json({ error: true, message: '图库为空，或没有符合筛选条件的图片' }, 404);
    }

    const image = pool[Math.floor(Math.random() * pool.length)];
    const type = (c.req.query('type') || '').toLowerCase();
    const wantOrigin = type === 'origin' || type === 'original' || type === 'source';
    const useWebp = !wantOrigin && config.randomPreferWebp && image.webp;

    const target = useWebp ? `/w/${image.webp}` : `/i/${image.file}`;
    const prefix = basePath(c);

    if (c.req.query('format') === 'json') {
        const origin = new URL(c.req.url).origin;
        return c.json({
            id: image.id,
            url: `${origin}${prefix}${target}`,
            origin: `${origin}${prefix}/i/${image.file}`,
            webp: image.webp ? `${origin}${prefix}/w/${image.webp}` : null,
            width: image.width,
            height: image.height,
            tags: image.tags,
            rating: image.rating
        });
    }

    c.header('Cache-Control', 'no-store');
    return c.redirect(`${prefix}${target}`, 302);
};

// GET /i/:name —— 原图
export const imageHandler = (c) => {
    const name = c.req.param('name');
    const ext = name.split('.').pop().toLowerCase();
    return serve(c, IMAGE_DIR, name, MIME[ext] || 'application/octet-stream');
};

// GET /w/:name —— webp 版本
export const webpHandler = (c) => serve(c, WEBP_DIR, c.req.param('name'), 'image/webp');

// GET /list?page=&pageSize=&q=&tag=&rating=
export const listHandler = async (c) => {
    const config = getConfig();
    if (!config.allowPublicList && !getAuthUser(c)) {
        return c.json({ error: true, message: '图片列表未公开，请先登录' }, 401);
    }

    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize')) || 40));
    const keyword = (c.req.query('q') || '').trim().toLowerCase();
    const tag = (c.req.query('tag') || '').trim().toLowerCase();
    const rating = (c.req.query('rating') || '').trim().toLowerCase();

    let pool = [...index.getAll()];

    if (tag) {
        pool = pool.filter((image) => (image.tags || []).includes(tag));
    }
    if (rating) {
        pool = pool.filter((image) => image.rating === rating);
    }
    if (keyword) {
        pool = pool.filter((image) => {
            const haystack = [image.id, image.title, image.source, ...(image.tags || [])].join(' ');
            return haystack.toLowerCase().includes(keyword);
        });
    }

    // 新上传的排前面
    pool.reverse();

    const total = pool.length;
    const start = (page - 1) * pageSize;

    return c.json({
        total,
        page,
        pageSize,
        pages: Math.ceil(total / pageSize) || 1,
        images: pool.slice(start, start + pageSize).map((image) => decorate(c, image))
    });
};

// GET /info/:id
export const infoHandler = (c) => {
    const image = index.getById(c.req.param('id'));
    if (!image) {
        return c.json({ error: true, message: '图片不存在' }, 404);
    }
    return c.json(decorate(c, image));
};

// GET /stats
export const statsHandler = (c) => {
    const data = index.stats();
    return c.json({
        ...data,
        totalSizeMB: Number((data.totalSize / 1024 / 1024).toFixed(2)),
        webpSizeMB: Number((data.webpSize / 1024 / 1024).toFixed(2)),
        enableTags: getConfig().enableTags
    });
};

// GET /health
export const healthHandler = (c) => c.json({ ok: true, count: index.getAll().length });
