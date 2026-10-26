import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config.js';

export const getToken = (c) => {
    const header = c.req.header('Authorization') || '';
    if (header.toLowerCase().startsWith('bearer ')) {
        return header.slice(7).trim();
    }
    return c.req.header('X-Token') || c.req.query('token') || '';
};

export const checkToken = (token) => {
    const expected = getConfig().adminToken;
    if (!token || !expected) return false;

    const given = Buffer.from(String(token));
    const expect = Buffer.from(expected);
    if (given.length !== expect.length) return false;

    return timingSafeEqual(given, expect);
};

export const requireAuth = async (c, next) => {
    if (!checkToken(getToken(c))) {
        return c.json({ error: true, message: '未授权：请在页面右上角填入管理令牌' }, 401);
    }
    await next();
};
