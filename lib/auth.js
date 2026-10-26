import { createHash, randomBytes } from 'node:crypto';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
    createSessionRow,
    deleteSession,
    getSessionUser
} from './db.js';

const COOKIE_NAME = 'imgapi_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map();

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

const bearerToken = (c) => {
    const header = c.req.header('Authorization') || '';
    if (header.toLowerCase().startsWith('bearer ')) {
        return header.slice(7).trim();
    }
    return '';
};

export const getSessionToken = (c) => bearerToken(c) || getCookie(c, COOKIE_NAME) || '';

export const getAuthUser = (c) => {
    const token = getSessionToken(c);
    if (!token) return null;

    const user = getSessionUser(hashToken(token));
    if (!user) return null;

    c.set('user', user);
    c.set('sessionToken', token);
    return user;
};

export const requireAuth = async (c, next) => {
    if (!getAuthUser(c)) {
        return c.json({ error: true, message: '未登录或登录已过期' }, 401);
    }

    await next();
};

export const requireAdmin = async (c, next) => {
    const user = getAuthUser(c);

    if (!user) {
        return c.json({ error: true, message: '未登录或登录已过期' }, 401);
    }
    if (user.role !== 'admin') {
        return c.json({ error: true, message: '需要管理员权限' }, 403);
    }

    await next();
};

export const requireRoles = (...roles) => async (c, next) => {
    const user = getAuthUser(c);

    if (!user) {
        return c.json({ error: true, message: '未登录或登录已过期' }, 401);
    }
    if (!roles.includes(user.role)) {
        return c.json({ error: true, message: '没有权限执行此操作' }, 403);
    }

    await next();
};

const isSecureRequest = (c) => {
    const proto = (c.req.header('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
    if (proto) return proto === 'https';

    try {
        return new URL(c.req.url).protocol === 'https:';
    } catch {
        return false;
    }
};

export const createSession = (c, userId) => {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    createSessionRow({
        tokenHash: hashToken(token),
        userId,
        expiresAt,
        userAgent: c.req.header('user-agent') || ''
    });

    return { token, expiresAt };
};

export const setSessionCookie = (c, token) => {
    setCookie(c, COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        secure: isSecureRequest(c)
    });
};

export const clearSession = (c) => {
    const token = getSessionToken(c);
    if (token) deleteSession(hashToken(token));

    deleteCookie(c, COOKIE_NAME, { path: '/' });
};

export const publicUser = (user) => user && ({
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName
});

// —— 登录失败限流（内存级，重启后清零）——

const clientKey = (c) => {
    const forwarded = (c.req.header('x-forwarded-for') || '').split(',')[0].trim();
    return forwarded || c.req.header('x-real-ip') || 'local';
};

export const loginKey = (c, username) => `${clientKey(c)}|${String(username || '').toLowerCase()}`;

export const loginAllowed = (key) => {
    const record = loginFailures.get(key);
    if (!record) return true;

    if (Date.now() > record.resetAt) {
        loginFailures.delete(key);
        return true;
    }

    return record.count < LOGIN_MAX_FAILURES;
};

export const recordLoginFailure = (key) => {
    const record = loginFailures.get(key);

    if (!record || Date.now() > record.resetAt) {
        loginFailures.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
        return;
    }

    record.count += 1;
};

export const clearLoginFailures = (key) => {
    loginFailures.delete(key);
};

export { SESSION_TTL_MS };
