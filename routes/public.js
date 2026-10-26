import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { IMAGE_DIR, WEBP_DIR, getConfig } from '../config.js';
import { getAuthUser } from '../lib/auth.js';
import { MIME, toPng } from '../lib/image.js';
import * as index from '../lib/index.js';
import { canViewImage } from '../lib/roles.js';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const tagFilter = (c) => {
    const tags = (c.req.query('tag') || '')
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);

    return {
        tags,
        mode: (c.req.query('tagMode') || 'any').toLowerCase() === 'all' ? 'all' : 'any'
    };
};

const matchesTags = (image, tags, mode) => {
    if (!tags.length) return true;

    const imageTags = image.tags || [];
    return mode === 'all'
        ? tags.every((tag) => imageTags.includes(tag))
        : tags.some((tag) => imageTags.includes(tag));
};

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

// 生成对外地址时优先使用反向代理/Cloudflare 转发的协议和主机，
// 避免后台复制出来的图片链接变成内部 http:// 地址。
export const publicOrigin = (c) => {
    let proto = '';

    // Cloudflare 的 CF-Visitor 更接近访客实际使用的协议。
    const visitor = c.req.header('cf-visitor');
    if (visitor) {
        try {
            const scheme = String(JSON.parse(visitor).scheme || '').toLowerCase();
            if (scheme === 'http' || scheme === 'https') proto = scheme;
        } catch {
            // 忽略非 JSON 的 cf-visitor
        }
    }

    if (!proto) {
        proto = (c.req.header('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
    }

    if (proto !== 'https' && proto !== 'http') {
        try {
            proto = new URL(c.req.url).protocol.replace(':', '').toLowerCase();
        } catch {
            proto = 'http';
        }
    }

    let host = (c.req.header('x-forwarded-host') || '').split(',')[0].trim()
        || c.req.header('host')
        || '';

    if (!host) {
        try {
            host = new URL(c.req.url).host;
        } catch {
            host = 'localhost';
        }
    }

    const forwardedPort = (c.req.header('x-forwarded-port') || '').split(',')[0].trim();
    if (forwardedPort && !host.includes(':') &&
        !((proto === 'https' && forwardedPort === '443') || (proto === 'http' && forwardedPort === '80'))) {
        host += ':' + forwardedPort;
    }

    return `${proto === 'https' ? 'https' : 'http'}://${host}`;
};

const noStore = (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('CDN-Cache-Control', 'no-store');
    c.header('Cloudflare-CDN-Cache-Control', 'no-store');
};

const imageCacheHeaders = (cacheControl) => ({
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': cacheControl,
    'Cloudflare-CDN-Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff'
});

export const decorate = (c, image) => {
    const origin = publicOrigin(c);
    const prefix = basePath(c);
    const { ownerId, reviewedBy, reviewedAt, reviewNote, ...rest } = image;

    return {
        ...rest,
        url: `${origin}${prefix}/i/${image.file}`,
        webpUrl: image.webp ? `${origin}${prefix}/w/${image.webp}` : null
    };
};

const serve = async (c, dir, name, mime, cacheOverride = null) => {
    // 文件名只能是「十六进制 id.扩展名」，同时挡掉路径穿越
    if (!/^[a-z0-9]+\.[a-z0-9]+$/i.test(name)) {
        return c.text('Not Found', 404);
    }

    const image = index.findByFile(name);
    if (!image) {
        return c.text('Not Found', 404);
    }

    let cacheControl = cacheOverride || CACHE_CONTROL;

    // 未通过审核或前台隐藏的图片只允许审核员/管理员/站长或上传者本人查看
    if (image.status !== 'approved' || image.visible === false) {
        const user = getAuthUser(c);
        if (!canViewImage(user, image)) {
            return c.text('Not Found', 404);
        }
        cacheControl = 'private, no-store';
    }

    const filePath = join(dir, name);

    try {
        const info = await stat(filePath);
        if (!info.isFile()) {
            return c.text('Not Found', 404);
        }

        const etag = `"${image.hash}"`;
        const headers = {
            ...imageCacheHeaders(cacheControl),
            ETag: etag,
            'Last-Modified': info.mtime.toUTCString()
        };

        if (c.req.header('if-none-match') === etag) {
            return new Response(null, { status: 304, headers });
        }

        // 直接读成 Buffer：图片不大，且避免 Node 里把文件流塞进 Response 时
        // 客户端提前断开导致的 ReadableStream 已关闭错误（会直接崩进程）
        const body = await readFile(filePath);

        return new Response(body, {
            headers: {
                ...headers,
                'Content-Type': mime,
                'Content-Length': String(body.length)
            }
        });
    } catch {
        return c.text('Not Found', 404);
    }
};

const selectRandom = (c) => {
    const tags = tagFilter(c);
    let pool = index.getPublicApproved();

    if (tags.tags.length) {
        pool = pool.filter((image) => matchesTags(image, tags.tags, tags.mode));
    }

    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
};

const targetFor = (c, image) => {
    const config = getConfig();
    const type = (c.req.query('type') || '').toLowerCase();
    const wantOrigin = type === 'origin' || type === 'original' || type === 'source';
    const useWebp = !wantOrigin && config.randomPreferWebp && image.webp;
    const file = useWebp ? image.webp : image.file;
    const ext = file.split('.').pop().toLowerCase();

    return {
        useWebp,
        file,
        dir: useWebp ? WEBP_DIR : IMAGE_DIR,
        mime: useWebp ? 'image/webp' : (image.mime || MIME[ext] || 'application/octet-stream'),
        target: useWebp ? `/w/${image.webp}` : `/i/${image.file}`
    };
};

const randomJson = (c, image, target) => {
    const origin = publicOrigin(c);
    const prefix = basePath(c);

    return {
        id: image.id,
        url: `${origin}${prefix}${target}`,
        origin: `${origin}${prefix}/i/${image.file}`,
        webp: image.webp ? `${origin}${prefix}/w/${image.webp}` : null,
        width: image.width,
        height: image.height,
        tags: image.tags
    };
};

// GET /random?tag=&tagMode=any|all&type=origin|webp&format=json
export const randomHandler = async (c) => {
    const image = selectRandom(c);

    if (!image) {
        return c.json({ error: true, message: '图库为空，或没有符合筛选条件的图片' }, 404);
    }

    const { target } = targetFor(c, image);
    const prefix = basePath(c);

    if (c.req.query('format') === 'json') {
        noStore(c);
        return c.json(randomJson(c, image, target));
    }

    noStore(c);
    return c.redirect(`${prefix}${target}`, 302);
};

// GET /api/v1?tag=&tagMode=any|all&type=origin|webp|png&format=json
// 直接返回图片字节，不做 302，适合无法跟随跳转的客户端
const apiV1 = async (c, forcePng = false) => {
    const image = selectRandom(c);

    if (!image) {
        return c.json({ error: true, message: '图库为空，或没有符合筛选条件的图片' }, 404);
    }

    if (c.req.query('format') === 'json') {
        const { target } = targetFor(c, image);
        noStore(c);
        return c.json(randomJson(c, image, target));
    }

    const type = forcePng ? 'png' : (c.req.query('type') || '').toLowerCase();

    // 兼容只支持 PNG 的客户端
    if (type === 'png') {
        try {
            const source = await readFile(join(IMAGE_DIR, image.file));
            const body = await toPng(source);

            return new Response(body, {
                headers: {
                    'Content-Type': 'image/png',
                    'Content-Length': String(body.length),
                    'Cache-Control': 'no-store',
                    'CDN-Cache-Control': 'no-store',
                    'Cloudflare-CDN-Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                    'X-Image-Id': image.id
                }
            });
        } catch {
            return c.text('Not Found', 404);
        }
    }

    const { file, dir, mime } = targetFor(c, image);

    c.header('Cache-Control', 'no-store');
    c.header('X-Image-Id', image.id);

    return serve(c, dir, file, mime, 'no-store');
};

export const apiV1Handler = (c) => apiV1(c, false);
export const apiV1PngHandler = (c) => apiV1(c, true);

// GET /i/:name —— 原图
export const imageHandler = (c) => {
    const name = c.req.param('name');
    const ext = name.split('.').pop().toLowerCase();
    return serve(c, IMAGE_DIR, name, MIME[ext] || 'application/octet-stream');
};

// GET /w/:name —— webp 版本
export const webpHandler = (c) => serve(c, WEBP_DIR, c.req.param('name'), 'image/webp');

// GET /list?page=&pageSize=&q=&tag=&tagMode=any|all
export const listHandler = async (c) => {
    const config = getConfig();
    const rateUser = c.get('rateUser');
    if (!config.allowPublicList && !getAuthUser(c) && !rateUser) {
        return c.json({ error: true, message: '图片列表未公开，请先登录或填写 Token' }, 401);
    }

    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize')) || 40));
    const keyword = (c.req.query('q') || '').trim().toLowerCase();
    const tags = tagFilter(c);

    let pool = [...index.getPublicApproved()];

    if (tags.tags.length) {
        pool = pool.filter((image) => matchesTags(image, tags.tags, tags.mode));
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

    noStore(c);

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

    if (image.status !== 'approved' || image.visible === false) {
        const user = getAuthUser(c);
        if (!canViewImage(user, image)) {
            return c.json({ error: true, message: '图片不存在' }, 404);
        }
    }

    noStore(c);
    return c.json(decorate(c, image));
};

// GET /stats
export const statsHandler = (c) => {
    const data = index.publicStats();
    noStore(c);
    return c.json({
        ...data,
        totalSizeMB: Number((data.totalSize / 1024 / 1024).toFixed(2)),
        webpSizeMB: Number((data.webpSize / 1024 / 1024).toFixed(2)),
        siteName: getConfig().siteName
    });
};

// GET /health
export const healthHandler = (c) => c.json({ ok: true, count: index.getAll().length });
