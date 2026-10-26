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
    requireAuth,
    requireRoles,
    setSessionCookie
} from '../lib/auth.js';
import { hashPassword, validatePassword, verifyPassword } from '../lib/password.js';
import { ROLES, assignableRoles, canAssignRole, canEditImage, canManageUser, canReview, roleLabel } from '../lib/roles.js';
import * as db from '../lib/db.js';
import * as index from '../lib/index.js';
import * as store from '../lib/store.js';
import { decorate } from './public.js';

export const adminRoutes = new Hono();

const ID_PATTERN = /^[a-f0-9]{24}$/;
const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{3,32}$/u;
const IMAGE_STATUSES = ['pending', 'approved', 'rejected'];

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

const adminBase = (c) => {
    const pathname = new URL(c.req.url).pathname;
    return pathname.replace(/\/admin(\/.*)?$/, '');
};

const redirectToLogin = (c) => c.redirect(`${adminBase(c)}/login`);

const homeForRole = (c, user) => user.role === 'moderator'
    ? c.redirect(`${adminBase(c)}/admin/review`)
    : c.redirect(`${adminBase(c)}/admin`);

const settingPayload = (user) => {
    const config = getConfig();

    return {
        siteName: config.siteName,
        port: config.port,
        enableTags: config.enableTags,
        randomPreferWebp: config.randomPreferWebp,
        allowPublicList: config.allowPublicList,
        allowRegistration: config.allowRegistration,
        maxUploadMB: config.maxUploadMB,
        canEditPort: user?.role === 'owner'
    };
};

const imagePayload = (c, image, user) => ({
    ...decorate(c, image),
    ownerId: image.ownerId,
    owner: image.ownerId ? (db.getUserById(image.ownerId)?.username || null) : null,
    reviewer: image.reviewedBy ? (db.getUserById(image.reviewedBy)?.username || null) : null,
    status: image.status,
    reviewedAt: image.reviewedAt || null,
    reviewNote: image.reviewNote || '',
    canEdit: canEditImage(user, image)
});

const userPayload = (user, currentUser, imageCounts) => ({
    ...publicUser(user),
    roleLabel: roleLabel(user.role),
    disabled: user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    imageCount: imageCounts.get(user.id) || 0,
    isSelf: user.id === currentUser.id,
    canManage: canManageUser(currentUser, user)
});

// —— 页面 ——

adminRoutes.get('/', (c) => {
    if (db.countUsers() === 0) return servePage(c, 'login.html');

    const user = getAuthUser(c);
    if (!user) return servePage(c, 'login.html');
    if (user.role === 'moderator') return homeForRole(c, user);

    return servePage(c, 'admin.html');
});

adminRoutes.get('/login', (c) => {
    const user = getAuthUser(c);
    if (user) return homeForRole(c, user);
    return servePage(c, 'login.html');
});

adminRoutes.get('/setting', (c) => {
    const user = getAuthUser(c);
    if (!user) return redirectToLogin(c);
    if (!['owner', 'admin'].includes(user.role)) return c.text('需要站长或管理员权限', 403);
    return servePage(c, 'setting.html');
});

adminRoutes.get('/users', (c) => {
    const user = getAuthUser(c);
    if (!user) return redirectToLogin(c);
    if (!['owner', 'admin'].includes(user.role)) return c.text('需要站长或管理员权限', 403);
    return servePage(c, 'users.html');
});

adminRoutes.get('/review', (c) => {
    const user = getAuthUser(c);
    if (!user) return redirectToLogin(c);
    if (!canReview(user.role)) return c.text('需要审核权限', 403);
    return servePage(c, 'review.html');
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
        return c.json({ error: true, message: '站长账户已经初始化过了' }, 409);
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
            role: 'owner',
            displayName: normalizeDisplayName(body.displayName) || username
        });
    } catch (error) {
        if (isUniqueError(error)) {
            return c.json({ error: true, message: '用户名已存在' }, 409);
        }
        throw error;
    }

    // 旧版 index.json 迁移过来的图片没有归属，第一任站长接管
    db.adoptOwnerlessImages(user.id);
    await index.loadIndex();

    const session = createSession(c, user.id);
    setSessionCookie(c, session.token);

    return c.json({ user: publicUser(user), token: session.token, expiresAt: session.expiresAt });
});

adminRoutes.post('/api/auth/login', async (c) => {
    if (db.countUsers() === 0) {
        return c.json({ error: true, message: '请先在 /admin 初始化站长账号' }, 409);
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
        return c.json({ error: true, message: '系统尚未初始化，请先创建站长账户' }, 409);
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
            role: 'member',
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

adminRoutes.get('/api/settings', requireAuth, (c) => c.json(settingPayload(c.get('user'))));

adminRoutes.put('/api/settings', requireRoles('owner', 'admin'), async (c) => {
    const user = c.get('user');
    const body = await readJson(c);

    // 端口属于危险项，只有站长可以修改；管理员提交时直接忽略
    if (user.role !== 'owner') {
        delete body.port;
    }

    await updateConfig(body);
    return c.json(settingPayload(user));
});

// —— 图片 ——

adminRoutes.get('/api/images', requireRoles('owner', 'admin', 'member'), (c) => {
    const user = c.get('user');
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize')) || 40));
    const keyword = (c.req.query('q') || '').trim().toLowerCase();
    const rating = (c.req.query('rating') || '').trim().toLowerCase();
    const status = (c.req.query('status') || '').trim().toLowerCase();

    let pool = [...index.getAll()];

    // 成员只能看到自己上传的图片；站长/管理员看全部
    if (user.role === 'member') {
        pool = pool.filter((image) => image.ownerId === user.id);
    }

    const visible = [...pool];

    if (IMAGE_STATUSES.includes(status)) {
        pool = pool.filter((image) => image.status === status);
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

    pool.reverse();

    const total = pool.length;
    const start = (page - 1) * pageSize;

    return c.json({
        total,
        page,
        pageSize,
        pages: Math.ceil(total / pageSize) || 1,
        stats: index.stats(),
        reviewStats: index.reviewStats(visible),
        images: pool.slice(start, start + pageSize).map((image) => imagePayload(c, image, user))
    });
});

// POST /admin/api/upload —— multipart/form-data，可一次传多张，字段名都叫 file
adminRoutes.post('/api/upload', requireRoles('owner', 'admin', 'member'), async (c) => {
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

adminRoutes.patch('/api/images/:id', requireRoles('owner', 'admin', 'member'), async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    if (!ID_PATTERN.test(id)) {
        return c.json({ error: true, message: 'ID 格式不正确' }, 400);
    }

    const existing = index.getById(id);
    if (!existing) {
        return c.json({ error: true, message: '图片不存在' }, 404);
    }
    if (!canEditImage(user, existing)) {
        return c.json({ error: true, message: '只能修改自己上传的图片' }, 403);
    }

    const body = await readJson(c);
    const image = await index.updateImage(id, body);
    return c.json(imagePayload(c, image, user));
});

adminRoutes.delete('/api/images/:id', requireRoles('owner', 'admin', 'member'), async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    if (!ID_PATTERN.test(id)) {
        return c.json({ error: true, message: 'ID 格式不正确' }, 400);
    }

    const existing = index.getById(id);
    if (!existing) {
        return c.json({ error: true, message: '图片不存在' }, 404);
    }
    if (!canEditImage(user, existing)) {
        return c.json({ error: true, message: '只能删除自己上传的图片' }, 403);
    }

    const image = await store.removeImage(id);
    return c.json({ deleted: image.id });
});

// 扫描 data/images/，把手动丢进去的图片补进索引（会进入待审核）
adminRoutes.post('/api/scan', requireRoles('owner', 'admin'), async (c) => {
    const user = c.get('user');
    const { added, skipped } = await store.scanDirectory(user.id);

    return c.json({
        added: added.length,
        skipped,
        images: added.map((image) => imagePayload(c, image, user))
    });
});

adminRoutes.get('/api/stats', requireRoles('owner', 'admin', 'member'), (c) => {
    const user = c.get('user');
    const visible = user.role === 'member'
        ? index.getAll().filter((image) => image.ownerId === user.id)
        : index.getAll();

    return c.json({
        ...index.stats(),
        review: index.reviewStats(visible)
    });
});

// —— 审核 ——

adminRoutes.get('/api/review', requireRoles('owner', 'admin', 'moderator'), (c) => {
    const user = c.get('user');
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const pageSize = Math.min(120, Math.max(1, Number(c.req.query('pageSize')) || 24));
    const status = (c.req.query('status') || 'pending').toLowerCase();
    const filter = IMAGE_STATUSES.includes(status) ? status : 'pending';

    const pool = [...index.getByStatus(filter)].reverse();
    const total = pool.length;
    const start = (page - 1) * pageSize;

    return c.json({
        total,
        page,
        pageSize,
        pages: Math.ceil(total / pageSize) || 1,
        status: filter,
        stats: index.reviewStats(),
        images: pool.slice(start, start + pageSize).map((image) => imagePayload(c, image, user))
    });
});

adminRoutes.patch('/api/review/:id', requireRoles('owner', 'admin', 'moderator'), async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    if (!ID_PATTERN.test(id)) {
        return c.json({ error: true, message: 'ID 格式不正确' }, 400);
    }

    const body = await readJson(c);
    const status = String(body.status || '').toLowerCase();

    if (!IMAGE_STATUSES.includes(status)) {
        return c.json({ error: true, message: '审核状态不正确' }, 400);
    }

    const image = await index.setImageStatus(id, status, user.id, body.note);
    if (!image) {
        return c.json({ error: true, message: '图片不存在' }, 404);
    }

    return c.json(imagePayload(c, image, user));
});

// —— 账户管理（站长 / 管理员）——

adminRoutes.get('/api/users', requireRoles('owner', 'admin'), (c) => {
    const current = c.get('user');
    const counts = db.countImagesByOwner();

    return c.json({
        assignableRoles: assignableRoles(current.role),
        users: db.listUsers().map((user) => userPayload(user, current, counts))
    });
});

adminRoutes.post('/api/users', requireRoles('owner', 'admin'), async (c) => {
    const current = c.get('user');
    const body = await readJson(c);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    const role = String(body.role || 'member');

    if (!ROLES.includes(role) || !canAssignRole(current.role, role)) {
        return c.json({ error: true, message: '不能创建这个身份组的账户' }, 403);
    }

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

    return c.json(userPayload(user, current, db.countImagesByOwner()), 201);
});

adminRoutes.patch('/api/users/:id', requireRoles('owner', 'admin'), async (c) => {
    const current = c.get('user');
    const id = Number(c.req.param('id'));
    const target = Number.isInteger(id) ? db.getUserById(id) : null;

    if (!target) {
        return c.json({ error: true, message: '账户不存在' }, 404);
    }

    const body = await readJson(c);
    const isSelf = target.id === current.id;

    if (!isSelf && !canManageUser(current, target)) {
        return c.json({ error: true, message: '不能管理这个账户' }, 403);
    }
    if (body.role !== undefined && !canAssignRole(current.role, body.role)) {
        return c.json({ error: true, message: '不能把账户改成这个身份组' }, 403);
    }
    if (isSelf && body.role && body.role !== target.role) {
        return c.json({ error: true, message: '不能修改自己的身份组' }, 400);
    }
    if (isSelf && body.disabled === true) {
        return c.json({ error: true, message: '不能禁用当前登录的账户' }, 400);
    }
    if (target.role === 'owner' && (body.role && body.role !== 'owner' || body.disabled === true)) {
        if (db.countOwners() <= 1) {
            return c.json({ error: true, message: '至少需要保留一个可用的站长' }, 400);
        }
    }

    const patch = {};

    if (typeof body.displayName === 'string') {
        patch.displayName = normalizeDisplayName(body.displayName);
    }
    if (body.role !== undefined) {
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
            isSelf ? hashToken(getSessionToken(c)) : null
        );
    }

    const user = await db.updateUser(target.id, patch);

    if (body.disabled === true) {
        db.deleteUserSessions(target.id);
    }

    return c.json(userPayload(user, current, db.countImagesByOwner()));
});

adminRoutes.delete('/api/users/:id', requireRoles('owner', 'admin'), async (c) => {
    const current = c.get('user');
    const id = Number(c.req.param('id'));
    const target = Number.isInteger(id) ? db.getUserById(id) : null;

    if (!target) {
        return c.json({ error: true, message: '账户不存在' }, 404);
    }
    if (target.id === current.id) {
        return c.json({ error: true, message: '不能删除当前登录的账户' }, 400);
    }
    if (!canManageUser(current, target)) {
        return c.json({ error: true, message: '不能删除这个账户' }, 403);
    }
    if (target.role === 'owner' && db.countOwners() <= 1) {
        return c.json({ error: true, message: '至少需要保留一个可用的站长' }, 400);
    }

    db.deleteUser(target.id);
    await index.loadIndex();
    return c.json({ deleted: target.id });
});
