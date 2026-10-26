import { Hono } from 'hono';
import { getConfig, updateConfig } from '../config.js';
import { servePage } from '../lib/pages.js';
import {
    clearLoginFailures,
    clearSession,
    createSession,
    getAuthUser,
    getSessionToken,
    hashToken,
    loginAllowed,
    loginKey,
    publicUser,
    recordLoginFailure,
    requireAdmin,
    requireAuth,
    setSessionCookie
} from '../lib/auth.js';
import { hashPassword, validatePassword, verifyPassword } from '../lib/password.js';
import * as db from '../lib/db.js';
import * as index from '../lib/index.js';
import * as store from '../lib/store.js';
import { decorate } from './public.js';

export const adminRoutes = new Hono();

const ID_PATTERN = /^[a-f0-9]{24}$/;
const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{3,32}$/u;

const readJson = async (c) => c.req.json().catch(() => ({}));

const normalizeUsername = (value) => String(value || '').trim();
const normalizeDisplayName = (value) => String(value || '').trim().slice(0, 60);

const usernameError = (username) => {
    if (!USERNAME_PATTERN.test(username)) {
        return '用户名需为 3–32 位，可用中文、字母、数字、下划线、点和短横线';
    }
    return '';
};

const isUniqueError = (error) => /UNIQUE constraint failed/i.test(error?.message || '');

const settingPayload = () => {
    const config = getConfig();
    return {
        siteName: config.siteName,
        port: config.port,
        enableTags: config.enableTags,
        randomPreferWebp: config.randomPreferWebp,
        allowPublicList: config.allowPublicList,
        allowRegistration: config.allowRegistration,
        maxUploadMB: config.maxUploadMB
    };
};

const adminBase = (c) => {
    const pathname = new URL(c.req.url).pathname;
    return pathname.replace(/\/admin(\/.*)?$/, '');
};

const redirectToLogin = (c) => c.redirect(`${adminBase(c)}/login`);

const serveHtml = servePage;

const canManageImage = (user, image) => user.role === 'admin' || image.ownerId === user.id;

const imagePayload = (c, image, user) => ({
    ...decorate(c, image),
    ownerId: image.ownerId,
    owner: image.ownerId ? (db.getUserById(image.ownerId)?.username || null) : null,
    canEdit: canManageImage(user, image)
});

const userPayload = (user, currentUser, imageCounts) => ({
    ...publicUser(user),
    disabled: user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    imageCount: imageCounts.get(user.id) || 0,
    isSelf: user.id === currentUser.id
});

// —— 页面 ——

adminRoutes.get('/', (c) => {
    if (db.countUsers() === 0) return serveHtml(c, 'login.html');

    const user = getAuthUser(c);
    return user ? serveHtml(c, 'admin.html') : serveHtml(c, 'login.html');
});

adminRoutes.get('/login', (c) => {
    const user = getAuthUser(c);
    if (user) return c.redirect(`${adminBase(c)}/admin`);
    return serveHtml(c, 'login.html');
});

adminRoutes.get('/setting', (c) => {
    const user = getAuthUser(c);
    if (!user) return redirectToLogin(c);
    if (user.role !== 'admin') return c.text('需要管理员权限', 403);
    return serveHtml(c, 'setting.html');
});

adminRoutes.get('/users', (c) => {
    const user = getAuthUser(c);
    if (!user) return redirectToLogin(c);
    if (user.role !== 'admin') return c.text('需要管理员权限', 403);
    return serveHtml(c, 'users.html');
});

// —— 认证（公开）——

adminRoutes.get('/api/auth/status', (c) => {
    const user = getAuthUser(c);
    return c.json({
        setup: db.countUsers() === 0,
        authenticated: Boolean(user),
        allowRegistration: getConfig().allowRegistration,
        siteName: getConfig().siteName,
        user: publicUser(user)
    });
});

adminRoutes.post('/api/auth/setup', async (c) => {
    if (db.countUsers() > 0) {
        return c.json({ error: true, message: '管理员已经初始化过了' }, 409);
    }

    const body = await readJson(c);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');

    const invalidUsername = usernameError(username);
    if (invalidUsername) return c.json({ error: true, message: invalidUsername }, 400);
    if (!validatePassword(password)) {
        return c.json({ error: true, message: '密码至少 8 位' }, 400);
    }

    let user;

    try {
        user = db.createUser({
            username,
            passwordHash: await hashPassword(password),
            role: 'admin',
            displayName: normalizeDisplayName(body.displayName) || username
        });
    } catch (error) {
        if (isUniqueError(error)) {
            return c.json({ error: true, message: '用户名已存在' }, 409);
        }
        throw error;
    }

    // 旧版 index.json 迁移过来的图片没有归属，第一任管理员接管
    db.adoptOwnerlessImages(user.id);
    await index.loadIndex();

    const session = createSession(c, user.id);
    setSessionCookie(c, session.token);

    return c.json({ user: publicUser(user), token: session.token, expiresAt: session.expiresAt });
});

adminRoutes.post('/api/auth/login', async (c) => {
    if (db.countUsers() === 0) {
        return c.json({ error: true, message: '请先在 /admin 初始化管理员账号' }, 409);
    }

    const body = await readJson(c);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    const key = loginKey(c, username);

    if (!loginAllowed(key)) {
        return c.json({ error: true, message: '登录失败次数过多，请 15 分钟后再试' }, 429);
    }

    const user = db.getUserByUsername(username);
    const ok = user && !user.disabled && await verifyPassword(password, user.passwordHash);

    if (!ok) {
        recordLoginFailure(key);
        return c.json({ error: true, message: '用户名或密码不正确' }, 401);
    }

    clearLoginFailures(key);
    db.cleanupSessions();

    const session = createSession(c, user.id);
    setSessionCookie(c, session.token);

    return c.json({ user: publicUser(user), token: session.token, expiresAt: session.expiresAt });
});

adminRoutes.post('/api/auth/register', async (c) => {
    if (!getConfig().allowRegistration) {
        return c.json({ error: true, message: '注册暂未开放' }, 403);
    }
    if (db.countUsers() === 0) {
        return c.json({ error: true, message: '系统尚未初始化，请先创建管理员账户' }, 409);
    }

    const body = await readJson(c);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');

    const invalidUsername = usernameError(username);
    if (invalidUsername) return c.json({ error: true, message: invalidUsername }, 400);
    if (!validatePassword(password)) {
        return c.json({ error: true, message: '密码至少 8 位' }, 400);
    }

    let user;

    try {
        user = db.createUser({
            username,
            passwordHash: await hashPassword(password),
            role: 'user',
            displayName: normalizeDisplayName(body.displayName) || username
        });
    } catch (error) {
        if (isUniqueError(error)) {
            return c.json({ error: true, message: '用户名已存在' }, 409);
        }
        throw error;
    }

    const session = createSession(c, user.id);
    setSessionCookie(c, session.token);

    return c.json({ user: publicUser(user), token: session.token, expiresAt: session.expiresAt }, 201);
});

adminRoutes.post('/api/auth/logout', (c) => {
    clearSession(c);
    return c.json({ ok: true });
});

// —— 认证（需要登录）——

adminRoutes.get('/api/auth/me', requireAuth, (c) =>
    c.json({ user: publicUser(c.get('user')) })
);

adminRoutes.post('/api/auth/password', requireAuth, async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');

    if (!await verifyPassword(currentPassword, user.passwordHash)) {
        return c.json({ error: true, message: '当前密码不正确' }, 400);
    }
    if (!validatePassword(newPassword)) {
        return c.json({ error: true, message: '新密码至少 8 位' }, 400);
    }

    await db.updateUser(user.id, { passwordHash: await hashPassword(newPassword) });
    db.deleteUserSessions(user.id, hashToken(getSessionToken(c)));

    return c.json({ ok: true });
});

// —— 设置 ——

adminRoutes.get('/api/settings', requireAuth, (c) => c.json(settingPayload()));

adminRoutes.put('/api/settings', requireAdmin, async (c) => {
    const body = await readJson(c);
    await updateConfig(body);
    return c.json(settingPayload());
});

// —— 图片 ——

adminRoutes.get('/api/images', requireAuth, (c) => {
    const user = c.get('user');
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
        images: pool.slice(start, start + pageSize).map((image) => imagePayload(c, image, user))
    });
});

// POST /admin/api/upload —— multipart/form-data，可一次传多张，字段名都叫 file
adminRoutes.post('/api/upload', requireAuth, async (c) => {
    const user = c.get('user');
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
            const result = await store.addFromBuffer(buffer, meta, user.id);
            const image = result.image;

            results.push({
                name: file.name,
                duplicate: result.duplicate,
                image: imagePayload(c, image, user)
            });
        } catch (error) {
            errors.push({ name: file.name, message: error.message });
        }
    }

    return c.json({ results, errors }, results.length ? 200 : 400);
});

adminRoutes.patch('/api/images/:id', requireAuth, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    if (!ID_PATTERN.test(id)) {
        return c.json({ error: true, message: 'ID 格式不正确' }, 400);
    }

    const existing = index.getById(id);
    if (!existing) {
        return c.json({ error: true, message: '图片不存在' }, 404);
    }
    if (!canManageImage(user, existing)) {
        return c.json({ error: true, message: '只能修改自己上传的图片' }, 403);
    }

    const body = await readJson(c);
    const image = await index.updateImage(id, body);
    return c.json(imagePayload(c, image, user));
});

adminRoutes.delete('/api/images/:id', requireAuth, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    if (!ID_PATTERN.test(id)) {
        return c.json({ error: true, message: 'ID 格式不正确' }, 400);
    }

    const existing = index.getById(id);
    if (!existing) {
        return c.json({ error: true, message: '图片不存在' }, 404);
    }
    if (!canManageImage(user, existing)) {
        return c.json({ error: true, message: '只能删除自己上传的图片' }, 403);
    }

    const image = await store.removeImage(id);
    return c.json({ deleted: image.id });
});

// 扫描 data/images/，把手动丢进去的图片补进索引
adminRoutes.post('/api/scan', requireAdmin, async (c) => {
    const user = c.get('user');
    const { added, skipped } = await store.scanDirectory(user.id);

    return c.json({
        added: added.length,
        skipped,
        images: added.map((image) => imagePayload(c, image, user))
    });
});

adminRoutes.get('/api/stats', requireAuth, (c) => c.json(index.stats()));

// —— 账户管理（仅管理员）——

adminRoutes.get('/api/users', requireAdmin, (c) => {
    const current = c.get('user');
    const counts = db.countImagesByOwner();

    return c.json({
        users: db.listUsers().map((user) => userPayload(user, current, counts))
    });
});

adminRoutes.post('/api/users', requireAdmin, async (c) => {
    const body = await readJson(c);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'user';

    const invalidUsername = usernameError(username);
    if (invalidUsername) return c.json({ error: true, message: invalidUsername }, 400);
    if (!validatePassword(password)) {
        return c.json({ error: true, message: '密码至少 8 位' }, 400);
    }

    let user;

    try {
        user = db.createUser({
            username,
            passwordHash: await hashPassword(password),
            role,
            displayName: normalizeDisplayName(body.displayName) || username
        });
    } catch (error) {
        if (isUniqueError(error)) {
            return c.json({ error: true, message: '用户名已存在' }, 409);
        }
        throw error;
    }

    return c.json(userPayload(user, c.get('user'), db.countImagesByOwner()), 201);
});

adminRoutes.patch('/api/users/:id', requireAdmin, async (c) => {
    const current = c.get('user');
    const id = Number(c.req.param('id'));
    const target = Number.isInteger(id) ? db.getUserById(id) : null;

    if (!target) {
        return c.json({ error: true, message: '账户不存在' }, 404);
    }

    const body = await readJson(c);

    if (target.id === current.id && body.disabled === true) {
        return c.json({ error: true, message: '不能禁用当前登录的账户' }, 400);
    }
    if (target.id === current.id && body.role && body.role !== 'admin') {
        return c.json({ error: true, message: '不能取消自己的管理员权限' }, 400);
    }

    const demoting = target.role === 'admin' && (body.role === 'user' || body.disabled === true);
    if (demoting && db.countAdmins() <= 1) {
        return c.json({ error: true, message: '至少需要保留一个可用的管理员' }, 400);
    }

    const patch = {};

    if (typeof body.displayName === 'string') {
        patch.displayName = normalizeDisplayName(body.displayName);
    }
    if (body.role === 'admin' || body.role === 'user') {
        patch.role = body.role;
    }
    if (typeof body.disabled === 'boolean') {
        patch.disabled = body.disabled;
    }
    if (typeof body.password === 'string' && body.password) {
        if (!validatePassword(body.password)) {
            return c.json({ error: true, message: '密码至少 8 位' }, 400);
        }
        patch.passwordHash = await hashPassword(body.password);
        db.deleteUserSessions(
            target.id,
            target.id === current.id ? hashToken(getSessionToken(c)) : null
        );
    }

    const user = await db.updateUser(target.id, patch);

    if (body.disabled === true) {
        db.deleteUserSessions(target.id);
    }

    return c.json(userPayload(user, current, db.countImagesByOwner()));
});

adminRoutes.delete('/api/users/:id', requireAdmin, async (c) => {
    const current = c.get('user');
    const id = Number(c.req.param('id'));
    const target = Number.isInteger(id) ? db.getUserById(id) : null;

    if (!target) {
        return c.json({ error: true, message: '账户不存在' }, 404);
    }
    if (target.id === current.id) {
        return c.json({ error: true, message: '不能删除当前登录的账户' }, 400);
    }
    if (target.role === 'admin' && db.countAdmins() <= 1) {
        return c.json({ error: true, message: '至少需要保留一个可用的管理员' }, 400);
    }

    db.deleteUser(target.id);
    await index.loadIndex();
    return c.json({ deleted: target.id });
});
