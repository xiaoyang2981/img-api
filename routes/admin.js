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
import { isEmail, normalizeEmail } from '../lib/email.js';
import { clearCode, issueCode, verifyCode } from '../lib/email-codes.js';
import { isMailConfigured, sendMail } from '../lib/mailer.js';
import { passwordResetCodeEmail, profileSecurityCodeEmail, registrationCodeEmail, smtpTestEmail } from '../lib/mail-templates.js';
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
const uniqueUserMessage = (error) => /users\.email/i.test(error?.message || '')
    ? '邮箱已被使用'
    : '用户名已存在';

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
        randomPreferWebp: config.randomPreferWebp,
        allowPublicList: config.allowPublicList,
        allowRegistration: config.allowRegistration,
        enableEmailVerification: config.enableEmailVerification,
        smtpHost: config.smtpHost,
        smtpPort: config.smtpPort,
        smtpSecure: config.smtpSecure,
        smtpUser: config.smtpUser,
        smtpFrom: config.smtpFrom,
        smtpPassSet: Boolean(config.smtpPass),
        emailConfigured: isMailConfigured(config),
        canEditEmail: user?.role === 'owner',
        maxUploadMB: config.maxUploadMB,
        rateLimitGuest: config.rateLimitGuest,
        rateLimitUser: config.rateLimitUser,
        tokenBanHours: config.tokenBanHours,
        watermarkText: config.watermarkText,
        watermarkOpacity: config.watermarkOpacity,
        watermarkPosition: config.watermarkPosition,
        watermarkSize: config.watermarkSize,
        watermarkColor: config.watermarkColor,
        canEditPort: user?.role === 'owner'
    };
};

const imagePayload = (c, image, user) => ({
    ...decorate(c, image),
    ownerId: image.ownerId,
    owner: image.ownerId ? (db.getUserById(image.ownerId)?.username || null) : null,
    reviewer: image.reviewedBy ? (db.getUserById(image.reviewedBy)?.username || null) : null,
    status: image.status,
    visible: image.visible !== false,
    v2Status: image.v2Status || 'none',
    v2RequestedAt: image.v2RequestedAt || null,
    v2Reviewer: image.v2ReviewedBy ? (db.getUserById(image.v2ReviewedBy)?.username || null) : null,
    v2ReviewedAt: image.v2ReviewedAt || null,
    v2ReviewNote: image.v2ReviewNote || '',
    reviewedAt: image.reviewedAt || null,
    reviewNote: image.reviewNote || '',
    canEdit: canEditImage(user, image)
});

const tokenBanActive = (user) => Boolean(
    user?.tokenBannedUntil && Date.parse(user.tokenBannedUntil) > Date.now()
);

const userPayload = (user, currentUser, imageCounts) => ({
    ...publicUser(user),
    roleLabel: roleLabel(user.role),
    disabled: user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    imageCount: imageCounts.get(user.id) || 0,
    isSelf: user.id === currentUser.id,
    canManage: canManageUser(currentUser, user),
    hasApiToken: Boolean(user.hasApiToken),
    apiTokenHint: user.apiTokenHint || null,
    apiTokenCreatedAt: user.apiTokenCreatedAt || null,
    tokenRateLimitHits: Number(user.tokenRateLimitHits) || 0,
    tokenLastHitAt: user.tokenLastHitAt || null,
    tokenBannedUntil: user.tokenBannedUntil || null,
    tokenBanned: tokenBanActive(user)
});

// —— 个人信息 ——

const PROFILE_EMAIL_CODE = 'profile-email';
const PROFILE_EMAIL_BIND_CODE = 'profile-email-bind';
const PROFILE_PASSWORD_CODE = 'profile-password';

const profilePayload = (user) => {
    const config = getConfig();

    return {
        user: {
            ...publicUser(user),
            avatarImageId: user.avatarImageId || null,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            hasApiToken: Boolean(user.hasApiToken),
            apiTokenHint: user.apiTokenHint || null,
            apiTokenCreatedAt: user.apiTokenCreatedAt || null,
            tokenRateLimitHits: Number(user.tokenRateLimitHits) || 0,
            tokenLastHitAt: user.tokenLastHitAt || null,
            tokenBannedUntil: user.tokenBannedUntil || null,
            tokenBanned: tokenBanActive(user)
        },
        siteName: config.siteName,
        mailConfigured: isMailConfigured(config)
    };
};

const profileEmailTarget = (user, value) => {
    const email = normalizeEmail(value);

    if (!isEmail(email)) {
        return { error: '邮箱格式不正确', status: 400 };
    }
    if (email === normalizeEmail(user.email)) {
        return { error: '新邮箱与当前邮箱相同', status: 400 };
    }

    const existing = db.getUserByEmail(email);
    if (existing && existing.id !== user.id) {
        return { error: '邮箱已被使用', status: 409 };
    }

    return { email };
};

const sendProfileEmailCode = async (c) => {
    const user = c.get('user');
    const config = getConfig();
    const body = await readJson(c);
    const target = profileEmailTarget(user, body.newEmail);

    if (target.error) {
        return c.json({ error: true, message: target.error }, target.status);
    }
    if (!isMailConfigured(config)) {
        return c.json({ error: true, message: '邮件服务尚未配置，无法发送验证码' }, 503);
    }

    const purpose = user.email ? PROFILE_EMAIL_CODE : PROFILE_EMAIL_BIND_CODE;
    const to = user.email || target.email;
    let code;

    try {
        code = issueCode(purpose, to);
    } catch (error) {
        return c.json({ error: true, message: error.message }, 429);
    }

    try {
        await sendMail({
            to,
            ...profileSecurityCodeEmail({
                siteName: config.siteName,
                username: user.username,
                action: user.email ? 'email-change' : 'email-bind',
                newEmail: target.email,
                code
            })
        });
    } catch (error) {
        clearCode(purpose, to);
        console.error('个人信息邮箱验证码发送失败:', error.message);
        return c.json({ error: true, message: '验证码邮件发送失败，请稍后再试' }, 502);
    }

    return c.json({ ok: true, to, mode: user.email ? 'change' : 'bind' });
};

const updateProfileEmail = async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const target = profileEmailTarget(user, body.newEmail);

    if (target.error) {
        return c.json({ error: true, message: target.error }, target.status);
    }

    const purpose = user.email ? PROFILE_EMAIL_CODE : PROFILE_EMAIL_BIND_CODE;
    const codeTarget = user.email || target.email;

    if (!verifyCode(purpose, codeTarget, body.code)) {
        return c.json({ error: true, message: '验证码无效或已过期' }, 400);
    }

    let updated;

    try {
        updated = await db.updateUser(user.id, { email: target.email });
    } catch (error) {
        if (isUniqueError(error)) {
            return c.json({ error: true, message: '邮箱已被使用' }, 409);
        }
        throw error;
    }

    db.deleteUserSessions(user.id, hashToken(getSessionToken(c)));

    return c.json(profilePayload(updated));
};

const sendProfilePasswordCode = async (c) => {
    const user = c.get('user');
    const config = getConfig();
    const body = await readJson(c);

    if (!user.email) {
        return c.json({ error: true, message: '请先绑定邮箱后再修改密码' }, 400);
    }
    if (!isMailConfigured(config)) {
        return c.json({ error: true, message: '邮件服务尚未配置，无法发送验证码' }, 503);
    }
    if (!await verifyPassword(String(body.currentPassword || ''), user.passwordHash)) {
        return c.json({ error: true, message: '当前密码不正确' }, 400);
    }

    let code;

    try {
        code = issueCode(PROFILE_PASSWORD_CODE, user.email);
    } catch (error) {
        return c.json({ error: true, message: error.message }, 429);
    }

    try {
        await sendMail({
            to: user.email,
            ...profileSecurityCodeEmail({
                siteName: config.siteName,
                username: user.username,
                action: 'password-change',
                code
            })
        });
    } catch (error) {
        clearCode(PROFILE_PASSWORD_CODE, user.email);
        console.error('个人信息密码验证码发送失败:', error.message);
        return c.json({ error: true, message: '验证码邮件发送失败，请稍后再试' }, 502);
    }

    return c.json({ ok: true, to: user.email });
};

const updateProfilePassword = async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');

    if (!user.email) {
        return c.json({ error: true, message: '请先绑定邮箱后再修改密码' }, 400);
    }
    if (!await verifyPassword(currentPassword, user.passwordHash)) {
        return c.json({ error: true, message: '当前密码不正确' }, 400);
    }
    if (!validatePassword(newPassword)) {
        return c.json({ error: true, message: '新密码至少 8 位' }, 400);
    }
    if (!verifyCode(PROFILE_PASSWORD_CODE, user.email, body.code)) {
        return c.json({ error: true, message: '验证码无效或已过期' }, 400);
    }

    await db.updateUser(user.id, { passwordHash: await hashPassword(newPassword) });
    db.deleteUserSessions(user.id, hashToken(getSessionToken(c)));

    return c.json({ ok: true });
};

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

adminRoutes.get('/profile', (c) => {
    const user = getAuthUser(c);
    if (!user) return redirectToLogin(c);
    return servePage(c, 'profile.html');
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

adminRoutes.get('/v2', (c) => {
    const user = getAuthUser(c);
    if (!user) return redirectToLogin(c);
    if (user.role === 'moderator') return c.redirect(`${adminBase(c)}/admin/review`);
    if (!['owner', 'admin', 'member'].includes(user.role)) return c.text('没有权限', 403);
    return servePage(c, 'v2.html');
});

// —— 认证（公开）——

adminRoutes.get('/api/auth/status', (c) => {
    const user = getAuthUser(c);
    const config = getConfig();

    return c.json({
        setup: db.countUsers() === 0,
        authenticated: Boolean(user),
        allowRegistration: config.allowRegistration,
        enableEmailVerification: config.enableEmailVerification,
        emailConfigured: isMailConfigured(config),
        siteName: config.siteName,
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

adminRoutes.post('/api/auth/register-code', async (c) => {
    const config = getConfig();

    if (!config.allowRegistration) {
        return c.json({ error: true, message: '注册暂未开放' }, 403);
    }
    if (!config.enableEmailVerification) {
        return c.json({ error: true, message: '邮箱验证未开启' }, 403);
    }
    if (!isMailConfigured(config)) {
        return c.json({ error: true, message: '邮件服务尚未配置，请联系站长' }, 503);
    }

    const body = await readJson(c);
    const email = normalizeEmail(body.email);

    if (!isEmail(email)) {
        return c.json({ error: true, message: '邮箱格式不正确' }, 400);
    }
    if (db.getUserByEmail(email)) {
        return c.json({ error: true, message: '这个邮箱已经被使用' }, 409);
    }

    let code;

    try {
        code = issueCode('register', email);
    } catch (error) {
        return c.json({ error: true, message: error.message }, 429);
    }

    try {
        await sendMail({
            to: email,
            ...registrationCodeEmail({ siteName: config.siteName, code })
        });
    } catch (error) {
        clearCode('register', email);
        console.error('注册验证码发送失败:', error.message);
        return c.json({ error: true, message: '验证码邮件发送失败，请稍后再试' }, 502);
    }

    return c.json({ ok: true });
});

adminRoutes.post('/api/auth/forgot-password', async (c) => {
    const config = getConfig();

    if (!config.enableEmailVerification) {
        return c.json({ error: true, message: '邮箱验证未开启' }, 403);
    }
    if (!isMailConfigured(config)) {
        return c.json({ error: true, message: '邮件服务尚未配置，请联系站长' }, 503);
    }

    const body = await readJson(c);
    const identifier = String(body.identifier || '').trim();
    const user = db.getUserByUsername(identifier) || db.getUserByEmail(identifier);

    if (user?.email) {
        let code;

        try {
            code = issueCode('reset', user.email);
        } catch (error) {
            return c.json({ error: true, message: error.message }, 429);
        }

        try {
            await sendMail({
                to: user.email,
                ...passwordResetCodeEmail({ siteName: config.siteName, username: user.username, code })
            });
        } catch (error) {
            clearCode('reset', user.email);
            console.error('重置密码邮件发送失败:', error.message);
            return c.json({ error: true, message: '邮件发送失败，请稍后再试' }, 502);
        }
    }

    // 不暴露账户是否存在
    return c.json({ ok: true });
});

adminRoutes.post('/api/auth/reset-password', async (c) => {
    const config = getConfig();

    if (!config.enableEmailVerification) {
        return c.json({ error: true, message: '邮箱验证未开启' }, 403);
    }
    if (!isMailConfigured(config)) {
        return c.json({ error: true, message: '邮件服务尚未配置，请联系站长' }, 503);
    }

    const body = await readJson(c);
    const identifier = String(body.identifier || '').trim();
    const newPassword = String(body.newPassword || '');
    const user = db.getUserByUsername(identifier) || db.getUserByEmail(identifier);

    if (!user || !user.email) {
        return c.json({ error: true, message: '验证码无效或已过期' }, 400);
    }
    if (!validatePassword(newPassword)) {
        return c.json({ error: true, message: '新密码至少 8 位' }, 400);
    }
    if (!verifyCode('reset', user.email, body.code)) {
        return c.json({ error: true, message: '验证码无效或已过期' }, 400);
    }

    await db.updateUser(user.id, { passwordHash: await hashPassword(newPassword) });
    db.deleteUserSessions(user.id);

    return c.json({ ok: true });
});

adminRoutes.post('/api/auth/register', async (c) => {
    const config = getConfig();

    if (!config.allowRegistration) {
        return c.json({ error: true, message: '注册暂未开放' }, 403);
    }
    if (db.countUsers() === 0) {
        return c.json({ error: true, message: '系统尚未初始化，请先创建站长账户' }, 409);
    }

    const body = await readJson(c);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    let email = null;

    const invalidUsername = usernameError(username);
    if (invalidUsername) return c.json({ error: true, message: invalidUsername }, 400);
    if (!validatePassword(password)) {
        return c.json({ error: true, message: '密码至少 8 位' }, 400);
    }

    if (config.enableEmailVerification) {
        if (!isMailConfigured(config)) {
            return c.json({ error: true, message: '邮件服务尚未配置，请联系站长' }, 503);
        }

        email = normalizeEmail(body.email);
        if (!isEmail(email)) {
            return c.json({ error: true, message: '邮箱格式不正确' }, 400);
        }
        if (db.getUserByEmail(email)) {
            return c.json({ error: true, message: '这个邮箱已经被使用' }, 409);
        }
        if (!verifyCode('register', email, body.code)) {
            return c.json({ error: true, message: '邮箱验证码无效或已过期' }, 400);
        }
    }

    let user;

    try {
        user = db.createUser({
            username,
            passwordHash: await hashPassword(password),
            role: 'member',
            email,
            displayName: normalizeDisplayName(body.displayName) || username
        });
    } catch (error) {
        if (isUniqueError(error)) {
            return c.json({ error: true, message: uniqueUserMessage(error) }, 409);
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

adminRoutes.get('/api/profile', requireAuth, (c) =>
    c.json(profilePayload(c.get('user')))
);

adminRoutes.put('/api/profile', requireAuth, async (c) => {
    const body = await readJson(c);

    if (typeof body.displayName !== 'string') {
        return c.json({ error: true, message: '显示名格式不正确' }, 400);
    }

    const user = await db.updateUser(c.get('user').id, {
        displayName: normalizeDisplayName(body.displayName)
    });

    return c.json(profilePayload(user));
});

adminRoutes.post('/api/profile/email-code', requireAuth, sendProfileEmailCode);
adminRoutes.put('/api/profile/email', requireAuth, updateProfileEmail);
adminRoutes.post('/api/profile/password-code', requireAuth, sendProfilePasswordCode);
adminRoutes.put('/api/profile/password', requireAuth, updateProfilePassword);

adminRoutes.post('/api/profile/token', requireAuth, async (c) => {
    const user = c.get('user');

    if (user.hasApiToken) {
        return c.json({ error: true, message: 'Token 已存在，请先吊销并重新生成' }, 409);
    }
    if (tokenBanActive(user)) {
        return c.json({ error: true, message: 'Token 已被临时封禁，暂时不能创建' }, 403);
    }

    const issued = db.issueApiToken(user.id);
    if (!issued) return c.json({ error: true, message: '账户不存在' }, 404);

    return c.json({
        token: issued.token,
        hint: issued.hint,
        createdAt: issued.createdAt,
        profile: profilePayload(db.getUserById(user.id))
    });
});

adminRoutes.post('/api/profile/token/revoke', requireAuth, async (c) => {
    const user = c.get('user');

    if (!user.hasApiToken) {
        return c.json({ error: true, message: '当前账户还没有 Token' }, 400);
    }

    const updated = db.revokeApiToken(user.id);
    if (!updated) return c.json({ error: true, message: '账户不存在' }, 404);

    return c.json({ profile: profilePayload(updated) });
});

adminRoutes.post('/api/profile/token/verify', requireAuth, async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const token = String(body.token || '').trim();

    if (!token) {
        return c.json({ error: true, message: 'Token 为空' }, 400);
    }

    const owner = db.getUserByApiToken(token);
    if (!owner || owner.id !== user.id || owner.disabled || tokenBanActive(owner)) {
        return c.json({ error: true, message: 'Token 已失效' }, 401);
    }

    return c.json({ ok: true });
});

// 浏览器没有保存完整 Token 时，允许用户重新生成一个并立即用于复制。
// 旧 Token 会失效，前端会先做确认提示。
adminRoutes.post('/api/profile/token/reissue', requireAuth, async (c) => {
    const user = c.get('user');

    if (tokenBanActive(user)) {
        return c.json({ error: true, message: 'Token 已被临时封禁，暂时不能创建' }, 403);
    }

    if (user.hasApiToken) {
        const revoked = db.revokeApiToken(user.id);
        if (!revoked) return c.json({ error: true, message: '账户不存在' }, 404);
    }

    const issued = db.issueApiToken(user.id);
    if (!issued) return c.json({ error: true, message: '账户不存在' }, 404);

    return c.json({
        token: issued.token,
        hint: issued.hint,
        createdAt: issued.createdAt,
        profile: profilePayload(db.getUserById(user.id))
    });
});

// —— 头像 ——

adminRoutes.get('/api/profile/avatar-images', requireAuth, (c) => {
    const user = c.get('user');
    const images = index.getAll()
        .filter((image) => image.ownerId === user.id && image.status !== 'rejected')
        .reverse()
        .slice(0, 200)
        .map((image) => ({
            ...decorate(c, image),
            status: image.status,
            visible: image.visible !== false,
            watermarked: Boolean(image.watermarked),
            selected: image.id === user.avatarImageId
        }));

    return c.json({
        avatarImageId: user.avatarImageId || null,
        images
    });
});

adminRoutes.put('/api/profile/avatar', requireAuth, async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const imageId = String(body.imageId || '').trim();

    if (!ID_PATTERN.test(imageId)) {
        return c.json({ error: true, message: '图片 ID 格式不正确' }, 400);
    }

    const image = index.getById(imageId);
    if (!image) {
        return c.json({ error: true, message: '图片不存在' }, 404);
    }
    if (image.ownerId !== user.id && !['owner', 'admin'].includes(user.role)) {
        return c.json({ error: true, message: '只能使用自己上传的图片作为头像' }, 403);
    }
    if (image.status === 'rejected') {
        return c.json({ error: true, message: '已拒绝的图片不能作为头像' }, 400);
    }

    const updated = db.setUserAvatar(user.id, image.id);
    return c.json({
        profile: profilePayload(updated),
        image: imagePayload(c, image, user)
    });
});

adminRoutes.delete('/api/profile/avatar', requireAuth, async (c) => {
    const user = c.get('user');
    const updated = db.setUserAvatar(user.id, null);
    return c.json({ profile: profilePayload(updated) });
});

adminRoutes.post('/api/profile/avatar/upload', requireAuth, async (c) => {
    const user = c.get('user');
    const config = getConfig();
    const limit = config.maxUploadMB * 1024 * 1024;

    let body;

    try {
        body = await c.req.parseBody({ all: true });
    } catch {
        return c.json({ error: true, message: '上传内容解析失败，请使用 multipart/form-data' }, 400);
    }

    const file = [body.file ?? []].flat().find((item) => item instanceof File);
    if (!file) {
        return c.json({ error: true, message: '没有收到头像文件（字段名应为 file）' }, 400);
    }
    if (file.size > limit) {
        return c.json({ error: true, message: `超过 ${config.maxUploadMB}MB 限制` }, 400);
    }

    try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const result = await store.addFromBuffer(buffer, {
            tags: 'avatar',
            title: '头像',
            watermarked: false
        }, user.id);

        if (result.image.ownerId !== user.id && !['owner', 'admin'].includes(user.role)) {
            return c.json({ error: true, message: '这张图片已经存在，不能设置为头像' }, 409);
        }
        if (result.image.status === 'rejected') {
            return c.json({ error: true, message: '已拒绝的图片不能作为头像' }, 400);
        }

        const updated = db.setUserAvatar(user.id, result.image.id);
        return c.json({
            duplicate: result.duplicate,
            profile: profilePayload(updated),
            image: imagePayload(c, result.image, user)
        });
    } catch (error) {
        return c.json({ error: true, message: error.message || '头像上传失败' }, 400);
    }
});

// 兼容旧接口：现在同样需要当前邮箱验证码
adminRoutes.post('/api/auth/password', requireAuth, updateProfilePassword);

// —— 设置 ——

adminRoutes.post('/api/settings/test-email', requireRoles('owner'), async (c) => {
    const config = getConfig();

    if (!isMailConfigured(config)) {
        return c.json({ error: true, message: 'SMTP 尚未配置，请先保存 SMTP 设置' }, 400);
    }

    const body = await readJson(c);
    const current = c.get('user');
    const to = normalizeEmail(body.to)
        || normalizeEmail(config.smtpUser)
        || normalizeEmail(current.email);

    if (!isEmail(to)) {
        return c.json({ error: true, message: '请填写正确的测试收件邮箱' }, 400);
    }

    try {
        await sendMail({
            to,
            ...smtpTestEmail({
                siteName: config.siteName,
                smtpHost: config.smtpHost,
                smtpPort: config.smtpPort,
                smtpSecure: config.smtpSecure
            })
        });
    } catch (error) {
        console.error('测试邮件发送失败:', error.message);
        return c.json({ error: true, message: '测试邮件发送失败，请检查 SMTP 配置' }, 502);
    }

    return c.json({ ok: true, to });
});

adminRoutes.get('/api/settings', requireAuth, (c) => c.json(settingPayload(c.get('user'))));

adminRoutes.put('/api/settings', requireRoles('owner', 'admin'), async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const config = getConfig();

    // 端口和邮件配置属于危险项，只有站长可以修改；管理员提交时直接忽略
    if (user.role !== 'owner') {
        delete body.port;
        delete body.enableEmailVerification;
        delete body.smtpHost;
        delete body.smtpPort;
        delete body.smtpSecure;
        delete body.smtpUser;
        delete body.smtpPass;
        delete body.smtpFrom;
    } else if (body.enableEmailVerification === true || body.enableEmailVerification === 'true') {
        const host = body.smtpHost !== undefined ? String(body.smtpHost || '').trim() : config.smtpHost;
        const from = (body.smtpFrom !== undefined || body.smtpUser !== undefined)
            ? String(body.smtpFrom || body.smtpUser || '').trim()
            : (config.smtpFrom || config.smtpUser);

        if (!host || !from) {
            return c.json({
                error: true,
                message: '开启邮箱验证前，请先填写 SMTP 主机和发件地址'
            }, 400);
        }
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

    const watermarked = [body.watermarked ?? ''].flat()[0] || '';
    const meta = {
        tags: [body.tags ?? ''].flat().join(','),
        title: [body.title ?? ''].flat()[0] || '',
        source: [body.source ?? ''].flat()[0] || '',
        watermarked: watermarked === '1' || watermarked === 'true'
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

    if (body.visible !== undefined && typeof body.visible !== 'boolean') {
        return c.json({ error: true, message: '前台展示状态格式不正确' }, 400);
    }
    if (body.watermarked !== undefined && typeof body.watermarked !== 'boolean') {
        return c.json({ error: true, message: '水印状态格式不正确' }, 400);
    }

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

// —— V2 接口图库 ——

adminRoutes.get('/api/v2/images', requireRoles('owner', 'admin', 'member'), (c) => {
    const user = c.get('user');
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const pageSize = Math.min(120, Math.max(1, Number(c.req.query('pageSize')) || 24));
    const keyword = (c.req.query('q') || '').trim().toLowerCase();
    const filter = String(c.req.query('status') || 'all').toLowerCase();
    const allowed = ['all', 'none', 'pending', 'approved', 'rejected'];

    let eligible = index.getApproved();
    if (user.role === 'member') {
        eligible = eligible.filter((image) => image.ownerId === user.id);
    }

    const stats = index.v2Stats(eligible);
    let pool = [...eligible];

    if (allowed.includes(filter) && filter !== 'all') {
        pool = pool.filter((image) => (image.v2Status || 'none') === filter);
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
        stats,
        canDirect: user.role === 'owner' || user.role === 'admin',
        images: pool.slice(start, start + pageSize).map((image) => imagePayload(c, image, user))
    });
});

adminRoutes.post('/api/v2/request/:id', requireRoles('owner', 'admin', 'member'), async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) return c.json({ error: true, message: 'ID 格式不正确' }, 400);

    const image = index.getById(id);
    if (!image) return c.json({ error: true, message: '图片不存在' }, 404);
    if (image.ownerId !== user.id) {
        return c.json({ error: true, message: '只能提交自己上传的图片' }, 403);
    }
    if (image.status !== 'approved') {
        return c.json({ error: true, message: '图片通过审核后才能提交 V2' }, 400);
    }
    if (image.v2Status === 'approved') {
        return c.json({ error: true, message: '图片已经在 V2 接口中' }, 409);
    }
    if (image.v2Status === 'pending') {
        return c.json({ error: true, message: '图片已经提交过 V2 申请' }, 409);
    }

    const updated = await index.setV2Status(id, 'pending');
    return c.json(imagePayload(c, updated, user));
});

adminRoutes.delete('/api/v2/request/:id', requireRoles('owner', 'admin', 'member'), async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) return c.json({ error: true, message: 'ID 格式不正确' }, 400);

    const image = index.getById(id);
    if (!image) return c.json({ error: true, message: '图片不存在' }, 404);
    if (image.ownerId !== user.id) {
        return c.json({ error: true, message: '只能取消自己的 V2 申请' }, 403);
    }
    if (image.v2Status !== 'pending') {
        return c.json({ error: true, message: '当前图片没有待审核的 V2 申请' }, 400);
    }

    const updated = await index.setV2Status(id, 'none');
    return c.json(imagePayload(c, updated, user));
});

adminRoutes.post('/api/v2/images/:id', requireRoles('owner', 'admin'), async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) return c.json({ error: true, message: 'ID 格式不正确' }, 400);

    const image = index.getById(id);
    if (!image) return c.json({ error: true, message: '图片不存在' }, 404);
    if (image.status !== 'approved') {
        return c.json({ error: true, message: '只有已通过审核的图片才能加入 V2' }, 400);
    }
    if (image.v2Status === 'approved') {
        return c.json({ error: true, message: '图片已经在 V2 接口中' }, 409);
    }

    const updated = await index.setV2Status(id, 'approved', user.id, '管理员直接加入');
    return c.json(imagePayload(c, updated, user));
});

adminRoutes.delete('/api/v2/images/:id', requireRoles('owner', 'admin'), async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) return c.json({ error: true, message: 'ID 格式不正确' }, 400);

    const image = index.getById(id);
    if (!image) return c.json({ error: true, message: '图片不存在' }, 404);
    if (image.v2Status !== 'approved') {
        return c.json({ error: true, message: '图片不在 V2 接口中' }, 400);
    }

    const updated = await index.setV2Status(id, 'none');
    return c.json(imagePayload(c, updated, user));
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
        v2Stats: index.v2Stats(index.getApproved()),
        images: pool.slice(start, start + pageSize).map((image) => imagePayload(c, image, user))
    });
});

adminRoutes.get('/api/review/v2', requireRoles('owner', 'admin', 'moderator'), (c) => {
    const user = c.get('user');
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const pageSize = Math.min(120, Math.max(1, Number(c.req.query('pageSize')) || 24));
    const status = String(c.req.query('status') || 'pending').toLowerCase();
    const filter = ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';

    const pool = index.getAll()
        .filter((image) => image.status === 'approved' && image.v2Status === filter)
        .reverse();
    const total = pool.length;
    const start = (page - 1) * pageSize;

    return c.json({
        total,
        page,
        pageSize,
        pages: Math.ceil(total / pageSize) || 1,
        status: filter,
        stats: index.reviewStats(),
        v2Stats: index.v2Stats(index.getApproved()),
        images: pool.slice(start, start + pageSize).map((image) => imagePayload(c, image, user))
    });
});

adminRoutes.patch('/api/review/v2/:id', requireRoles('owner', 'admin', 'moderator'), async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) return c.json({ error: true, message: 'ID 格式不正确' }, 400);

    const body = await readJson(c);
    const status = String(body.status || '').toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
        return c.json({ error: true, message: 'V2 审核状态不正确' }, 400);
    }

    const image = index.getById(id);
    if (!image) return c.json({ error: true, message: '图片不存在' }, 404);
    if (image.status !== 'approved') {
        return c.json({ error: true, message: '图片未通过审核，不能加入 V2' }, 400);
    }
    if (image.v2Status !== 'pending') {
        return c.json({ error: true, message: '当前图片没有待审核的 V2 申请' }, 400);
    }

    const updated = await index.setV2Status(id, status, user.id, body.note);
    return c.json(imagePayload(c, updated, user));
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
        tokenBanHours: getConfig().tokenBanHours,
        users: db.listUsers().map((user) => userPayload(user, current, counts))
    });
});

adminRoutes.post('/api/users', requireRoles('owner', 'admin'), async (c) => {
    const current = c.get('user');
    const body = await readJson(c);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    const role = String(body.role || 'member');
    const email = normalizeEmail(body.email);

    if (!ROLES.includes(role) || !canAssignRole(current.role, role)) {
        return c.json({ error: true, message: '不能创建这个身份组的账户' }, 403);
    }

    const invalidUsername = usernameError(username);
    if (invalidUsername) return c.json({ error: true, message: invalidUsername }, 400);
    if (!validatePassword(password)) {
        return c.json({ error: true, message: '密码至少 8 位' }, 400);
    }
    if (email && !isEmail(email)) {
        return c.json({ error: true, message: '邮箱格式不正确' }, 400);
    }
    if (email && db.getUserByEmail(email)) {
        return c.json({ error: true, message: '邮箱已被使用' }, 409);
    }

    let user;

    try {
        user = db.createUser({
            username,
            passwordHash: await hashPassword(password),
            role,
            email: email || null,
            displayName: normalizeDisplayName(body.displayName) || username
        });
    } catch (error) {
        if (isUniqueError(error)) {
            return c.json({ error: true, message: uniqueUserMessage(error) }, 409);
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
    if (isSelf && (body.email !== undefined || body.password !== undefined)) {
        return c.json({ error: true, message: '请在个人信息页修改邮箱或密码' }, 400);
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
    const config = getConfig();
    let tokenBanUntil;
    let updateTokenBan = false;

    if (body.tokenBanned !== undefined) {
        if (typeof body.tokenBanned !== 'boolean') {
            return c.json({ error: true, message: 'Token 封禁状态格式不正确' }, 400);
        }

        updateTokenBan = true;

        if (body.tokenBanned) {
            const hours = Number(body.tokenBanHours ?? config.tokenBanHours);
            if (!Number.isFinite(hours) || hours < 1 || hours > 8760) {
                return c.json({ error: true, message: '封禁时长需为 1–8760 小时' }, 400);
            }
            tokenBanUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
        } else {
            tokenBanUntil = null;
        }
    } else if (body.tokenBanHours !== undefined) {
        if (!tokenBanActive(target)) {
            return c.json({ error: true, message: '当前账户没有生效的 Token 封禁' }, 400);
        }

        const hours = Number(body.tokenBanHours);
        if (!Number.isFinite(hours) || hours < 1 || hours > 8760) {
            return c.json({ error: true, message: '封禁时长需为 1–8760 小时' }, 400);
        }

        updateTokenBan = true;
        tokenBanUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    }

    if (typeof body.displayName === 'string') {
        patch.displayName = normalizeDisplayName(body.displayName);
    }
    if (typeof body.email === 'string') {
        const email = normalizeEmail(body.email);
        if (email && !isEmail(email)) {
            return c.json({ error: true, message: '邮箱格式不正确' }, 400);
        }
        const existingEmailUser = email ? db.getUserByEmail(email) : null;
        if (existingEmailUser && existingEmailUser.id !== target.id) {
            return c.json({ error: true, message: '邮箱已被使用' }, 409);
        }
        patch.email = email || null;
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

    let user = await db.updateUser(target.id, patch);

    if (updateTokenBan) {
        user = db.setTokenBan(target.id, tokenBanUntil);
    }

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
