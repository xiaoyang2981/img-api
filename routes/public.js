import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { IMAGE_DIR, WEBP_DIR, getConfig } from '../config.js';
import { getRequestUser } from '../lib/auth.js';
import { MIME, toPng, toWebp } from '../lib/image.js';
import * as index from '../lib/index.js';
import { canViewImage } from '../lib/roles.js';
import { getWatermarkedBuffer } from '../lib/watermark.js';

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

// 对外 API 使用 /api/v1?id=... 返回图片；/api/getimg 仅作前台内部图片出口。
export const apiImageUrl = (c, image, type = 'webp') => {
    const origin = publicOrigin(c);
    const prefix = basePath(c);
    return `${origin}${prefix}/api/v1?id=${encodeURIComponent(image.id)}&type=${encodeURIComponent(type)}`;
};

export const v2ImageUrl = (c, image, type = 'webp') => {
    const origin = publicOrigin(c);
    const prefix = basePath(c);
    return `${origin}${prefix}/api/v2?id=${encodeURIComponent(image.id)}&type=${encodeURIComponent(type)}`;
};

const frontImageUrl = (c, image, type = 'webp') => {
    const origin = publicOrigin(c);
    const prefix = basePath(c);
    return `${origin}${prefix}/api/getimg?id=${encodeURIComponent(image.id)}&type=${encodeURIComponent(type)}&front=1`;
};

export const decorate = (c, image) => {
    const origin = publicOrigin(c);
    const prefix = basePath(c);
    const { ownerId, reviewedBy, reviewedAt, reviewNote, ...rest } = image;

    return {
        ...rest,
        url: `${origin}${prefix}/i/${image.file}`,
        webpUrl: image.webp ? `${origin}${prefix}/w/${image.webp}` : null,
        apiUrl: apiImageUrl(c, image, 'webp')
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

    // 「隐藏前台」只影响前台内部图片出口，不影响 /i 和 /w 直链。
    if (image.status !== 'approved') {
        const user = getRequestUser(c);
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

const requestUser = (c) => c.get('rateUser') || getRequestUser(c);

// 未携带有效 Token / 登录会话时，接口只能得到 WebP。
const preferredType = (c, user, { forcePng = false } = {}) => {
    if (forcePng) return 'png';

    const config = getConfig();
    const type = String(c.req.query('type') || '').toLowerCase();

    if (type === 'origin' || type === 'original' || type === 'source') {
        return user ? 'origin' : 'webp';
    }
    if (type === 'png') return 'png';
    if (type === 'webp') return 'webp';

    return user && !config.randomPreferWebp ? 'origin' : 'webp';
};

const contentMime = (image, variant, ext) => {
    if (variant === 'webp') return 'image/webp';
    if (variant === 'png') return 'image/png';
    return image.mime || MIME[ext] || 'application/octet-stream';
};

const readWebpSource = async (image) => {
    if (image.webp) {
        try {
            return await readFile(join(WEBP_DIR, image.webp));
        } catch {
            // 缓存文件被手动删掉时回退到原图重新生成
        }
    }

    const source = await readFile(join(IMAGE_DIR, image.file));
    return toWebp(source, image.animated);
};

const unwatermarkedBuffer = async (image, variant, user, publicSource = null) => {
    if (variant === 'webp') {
        return {
            buffer: publicSource || await readWebpSource(image),
            ext: 'webp'
        };
    }

    if (variant === 'png') {
        // 未登录请求从 WebP 转 PNG，绝不把原图直接交给客户端。
        const source = user
            ? await readFile(join(IMAGE_DIR, image.file))
            : (publicSource || await readWebpSource(image));
        return { buffer: await toPng(source), ext: 'png' };
    }

    const buffer = await readFile(join(IMAGE_DIR, image.file));
    const ext = String(image.mime || '').split('/').pop() || 'bin';
    return { buffer, ext };
};

const respondImage = async (c, image, variant, user) => {
    const config = getConfig();
    // 防御性兜底：即使调用方传错类型，未认证请求也绝不返回原图。
    if (!user && variant === 'origin') variant = 'webp';
    let publicSource = null;

    if (!user) {
        try {
            publicSource = await readWebpSource(image);
        } catch {
            return c.text('Not Found', 404);
        }
    }

    let result;
    let watermarked = false;

    try {
        if (image.watermarked) {
            result = await getWatermarkedBuffer(image, variant, config, {
                sourceBuffer: publicSource,
                sourceKind: user ? 'original' : 'webp'
            });
            watermarked = true;
        } else {
            result = await unwatermarkedBuffer(image, variant, user, publicSource);
        }
    } catch (error) {
        console.error(`⚠️  ${image.id} 水印/图片输出失败，回退到未加水印版本:`, error.message);
        try {
            result = await unwatermarkedBuffer(image, variant, user, publicSource);
            watermarked = false;
        } catch {
            return c.text('Not Found', 404);
        }
    }

    const mime = contentMime(image, variant, result.ext);
    const body = result.buffer;

    return new Response(body, {
        headers: {
            'Content-Type': mime,
            'Content-Length': String(body.length),
            'Cache-Control': 'no-store',
            'CDN-Cache-Control': 'no-store',
            'Cloudflare-CDN-Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Image-Id': image.id,
            'X-Image-Variant': variant,
            'X-Watermarked': watermarked ? '1' : '0',
            'X-Origin-Restricted': user ? '0' : '1'
        }
    });
};

const selectRandom = (c, pool) => {
    const tags = tagFilter(c);
    let selected = pool;

    if (tags.tags.length) {
        selected = selected.filter((image) => matchesTags(image, tags.tags, tags.mode));
    }

    if (!selected.length) return null;
    return selected[Math.floor(Math.random() * selected.length)];
};

const randomJson = (c, image, variant, user, urlFor = apiImageUrl) => ({
    id: image.id,
    url: urlFor(c, image, variant),
    origin: user ? urlFor(c, image, 'origin') : null,
    webp: urlFor(c, image, 'webp'),
    width: image.width,
    height: image.height,
    tags: image.tags,
    watermarked: Boolean(image.watermarked),
    variant,
    originRequiresToken: !user
});

// GET /api/v1rd?tag=&tagMode=any|all&type=webp|origin|png&format=json
// GET /api/v2rd?...：V2 图库随机图，使用 302 跳转。
const randomRedirect = async (c, { pool, status = 302, urlFor = apiImageUrl }) => {
    const user = requestUser(c);
    const image = selectRandom(c, pool);

    if (!image) {
        return c.json({ error: true, message: '图库为空，或没有符合筛选条件的图片' }, 404);
    }

    const variant = preferredType(c, user);

    if (c.req.query('format') === 'json') {
        noStore(c);
        return c.json(randomJson(c, image, variant, user, urlFor));
    }

    // 查询参数里的 Token 会随跳转丢失，显式带回目标地址；
    // Header/Bearer Token 会在同源跳转时继续由客户端携带。
    let target = urlFor(c, image, variant);
    const queryToken = String(c.req.query('token') || '').trim();
    if (queryToken) target += `&token=${encodeURIComponent(queryToken)}`;

    noStore(c);
    return c.redirect(target, status);
};

const requestedImage = (c, pool) => {
    const id = String(c.req.query('id') || '').trim();
    const file = String(c.req.query('file') || '').trim();
    if (!id && !file) return selectRandom(c, pool);

    const image = id ? index.getById(id) : index.findByFile(file);
    if (!image || !pool.includes(image)) return null;
    return image;
};

const apiRandom = async (c, pool, forcePng = false, urlFor = apiImageUrl) => {
    const user = requestUser(c);
    const image = requestedImage(c, pool);

    if (!image) {
        return c.json({ error: true, message: '图库为空，或没有符合筛选条件的图片' }, 404);
    }

    const variant = preferredType(c, user, { forcePng });

    if (c.req.query('format') === 'json') {
        noStore(c);
        return c.json(randomJson(c, image, variant, user, urlFor));
    }

    return respondImage(c, image, variant, user);
};

export const apiV1RdHandler = (c) => randomRedirect(c, {
    pool: index.getApproved(),
    status: 302,
    urlFor: apiImageUrl
});

export const apiV2RdHandler = (c) => randomRedirect(c, {
    pool: index.getV2Approved(),
    status: 302,
    urlFor: v2ImageUrl
});

export const apiV1Handler = (c) => apiRandom(c, index.getApproved());
export const apiV1PngHandler = (c) => apiRandom(c, index.getApproved(), true);
export const apiV2Handler = (c) => apiRandom(c, index.getV2Approved(), false, v2ImageUrl);
export const apiV2PngHandler = (c) => apiRandom(c, index.getV2Approved(), true, v2ImageUrl);

const frontJson = (c, image) => {
    const url = frontImageUrl(c, image, 'webp');
    return {
        id: image.id,
        url,
        origin: null,
        webp: url,
        width: image.width,
        height: image.height,
        tags: image.tags,
        watermarked: Boolean(image.watermarked),
        variant: 'webp',
        originRequiresToken: false
    };
};

// GET /api/getimg —— 前台展示页内部图片出口，不对外提供。
// 只接受 front=1、只输出已通过且允许前台展示的 WebP；隐藏只影响这里。
// 公共 API 使用 /api/v1rd、/api/v2rd、/api/v1、/api/v2。
export const getimgHandler = async (c) => {
    if (c.req.query('front') !== '1') {
        return c.json({ error: true, message: '图片不存在' }, 404);
    }

    const id = String(c.req.query('id') || '').trim();
    const file = String(c.req.query('file') || c.req.query('name') || '').trim();

    if (!id && !file) {
        const image = selectRandom(c, index.getPublicApproved());
        if (!image) {
            return c.json({ error: true, message: '图库为空，或没有允许前台展示的图片' }, 404);
        }

        if (c.req.query('format') === 'json') {
            noStore(c);
            return c.json(frontJson(c, image));
        }

        noStore(c);
        return c.redirect(frontImageUrl(c, image, 'webp'), 302);
    }

    const image = id ? index.getById(id) : index.findByFile(file);

    if (!image || image.status !== 'approved' || image.visible === false) {
        return c.json({ error: true, message: '图片不存在' }, 404);
    }

    if (c.req.query('format') === 'json') {
        noStore(c);
        return c.json(frontJson(c, image));
    }

    return respondImage(c, image, 'webp', null);
};

// GET /i/:name —— 原图；未认证访问会转到 WebP 出口
export const imageHandler = async (c) => {
    const name = c.req.param('name');
    const image = index.findByFile(name);

    if (!image || name !== image.file) {
        return c.text('Not Found', 404);
    }

    const user = getRequestUser(c);
    if (image.status !== 'approved' && !canViewImage(user, image)) {
        return c.text('Not Found', 404);
    }

    if (!user) {
        c.header('Cache-Control', 'private, no-store');
        c.header('CDN-Cache-Control', 'no-store');
        c.header('Cloudflare-CDN-Cache-Control', 'no-store');
        return c.redirect(apiImageUrl(c, image, 'webp'), 302);
    }

    // 原图可能带有 Token 查询参数，禁止公共 CDN 缓存，避免把原图缓存给其他访客。
    return serve(c, IMAGE_DIR, name, image.mime || 'application/octet-stream', 'private, max-age=3600');
};

// GET /w/:name —— webp 版本
export const webpHandler = (c) => serve(c, WEBP_DIR, c.req.param('name'), 'image/webp');

// GET /list?page=&pageSize=&q=&tag=&tagMode=any|all
export const listHandler = async (c) => {
    const config = getConfig();
    const rateUser = c.get('rateUser');
    if (!config.allowPublicList && !getRequestUser(c) && !rateUser) {
        return c.json({ error: true, message: '图片列表未公开，请先登录或填写 Token' }, 401);
    }

    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize')) || 40));
    const keyword = (c.req.query('q') || '').trim().toLowerCase();
    const tags = tagFilter(c);

    let pool = [...index.getApproved()];

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

    if (image.status !== 'approved') {
        const user = getRequestUser(c);
        if (!canViewImage(user, image)) {
            return c.json({ error: true, message: '图片不存在' }, 404);
        }
    }

    noStore(c);
    return c.json(decorate(c, image));
};

// GET /stats
export const statsHandler = (c) => {
    const data = index.stats();
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
