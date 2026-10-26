import { getConfig } from '../config.js';
import { getAuthUser } from './auth.js';
import { getUserByApiToken, recordTokenRateLimitHit } from './db.js';

export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const OWNER_RATE_LIMIT = 2000000;
export const TOKEN_ABUSE_HIT_THRESHOLD = 5;
export const TOKEN_ABUSE_WINDOW_MS = 10 * 60 * 1000;

const buckets = new Map();
let lastCleanup = 0;

const clientIp = (c) => {
    const forwarded = (c.req.header('x-forwarded-for') || '').split(',')[0].trim();
    return forwarded || c.req.header('x-real-ip') || 'local';
};

const bearerToken = (c) => {
    const header = c.req.header('authorization') || '';
    return header.toLowerCase().startsWith('bearer ')
        ? header.slice(7).trim()
        : '';
};

const invalidToken = (c) => {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: true, message: 'Token 无效' }, 401);
};

const bannedToken = (c, bannedUntil) => {
    const now = Date.now();
    const until = Date.parse(bannedUntil);

    if (!Number.isFinite(until)) return invalidToken(c);

    const retryAfter = Math.max(1, Math.ceil((until - now) / 1000));

    c.header('WWW-Authenticate', 'Bearer');
    c.header('Retry-After', String(retryAfter));
    c.header('Cache-Control', 'no-store');
    c.header('X-Token-Banned-Until', new Date(until).toISOString());

    return c.json({
        error: true,
        message: 'Token 已被临时封禁',
        bannedUntil: new Date(until).toISOString(),
        retryAfter
    }, 403);
};

const resolveUser = (c) => {
    const queryToken = String(c.req.query('token') || '').trim();
    const headerToken = String(c.req.header('x-api-token') || '').trim();

    // 显式 Token 优先；填了错误 Token 不再回退成游客
    const explicitToken = queryToken || headerToken;
    if (explicitToken) {
        const user = getUserByApiToken(explicitToken);
        return user && !user.disabled ? { user, source: 'token' } : { error: true };
    }

    const bearer = bearerToken(c);
    if (bearer) {
        const apiUser = getUserByApiToken(bearer);
        if (apiUser) {
            return apiUser.disabled ? { error: true } : { user: apiUser, source: 'token' };
        }

        // 兼容原来用登录会话 Bearer 访问 /list 的客户端
        const sessionUser = getAuthUser(c);
        return sessionUser ? { user: sessionUser, source: 'session' } : { error: true };
    }

    const sessionUser = getAuthUser(c);
    return { user: sessionUser || null, source: sessionUser ? 'session' : 'guest' };
};

const cleanup = (now) => {
    if (now - lastCleanup < RATE_LIMIT_WINDOW_MS) return;

    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }

    lastCleanup = now;
};

export const rateLimit = async (c, next) => {
    const identity = resolveUser(c);

    if (identity.error) return invalidToken(c);

    const config = getConfig();
    const user = identity.user;
    const now = Date.now();

    if (user && identity.source === 'token' && user.tokenBannedUntil) {
        const until = Date.parse(user.tokenBannedUntil);
        if (Number.isFinite(until) && until > now) {
            return bannedToken(c, user.tokenBannedUntil);
        }
    }

    const limit = user
        ? (user.role === 'owner' ? OWNER_RATE_LIMIT : Number(config.rateLimitUser) || 2000)
        : Number(config.rateLimitGuest) || 200;
    const key = user ? `user:${user.id}` : `ip:${clientIp(c)}`;

    cleanup(now);

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
        buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, limit - bucket.count);
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    c.header('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After');

    if (user) c.set('rateUser', user);

    if (bucket.count > limit) {
        if (user && identity.source === 'token') {
            const abuse = recordTokenRateLimitHit(user.id, {
                threshold: TOKEN_ABUSE_HIT_THRESHOLD,
                windowMs: TOKEN_ABUSE_WINDOW_MS,
                banHours: config.tokenBanHours
            });

            if (abuse?.newlyBanned && abuse.bannedUntil) {
                return bannedToken(c, abuse.bannedUntil);
            }
        }

        const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        c.header('Retry-After', String(retryAfter));
        c.header('Cache-Control', 'no-store');
        return c.json({
            error: true,
            message: '请求过于频繁，请稍后再试',
            limit,
            window: '1m',
            retryAfter
        }, 429);
    }

    await next();
};
