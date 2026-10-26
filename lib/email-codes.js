import { createHash, randomInt } from 'node:crypto';
import { normalizeEmail } from './email.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const store = new Map();

const hashCode = (purpose, email, code) =>
    createHash('sha256').update(`${purpose}:${email}:${code}`).digest('hex');

const keyOf = (purpose, email) => `${purpose}:${normalizeEmail(email)}`;

export const issueCode = (purpose, email) => {
    const normalized = normalizeEmail(email);
    const key = keyOf(purpose, normalized);
    const now = Date.now();
    const existing = store.get(key);

    if (existing && now < existing.sentAt + RESEND_COOLDOWN_MS) {
        const wait = Math.ceil((existing.sentAt + RESEND_COOLDOWN_MS - now) / 1000);
        throw new Error(`发送过于频繁，请 ${wait} 秒后再试`);
    }

    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    store.set(key, {
        hash: hashCode(purpose, normalized, code),
        expiresAt: now + CODE_TTL_MS,
        sentAt: now,
        attempts: 0
    });

    return code;
};

export const verifyCode = (purpose, email, code) => {
    const normalized = normalizeEmail(email);
    const key = keyOf(purpose, normalized);
    const record = store.get(key);

    if (!record || Date.now() > record.expiresAt) {
        store.delete(key);
        return false;
    }

    record.attempts += 1;
    if (record.attempts > MAX_ATTEMPTS) {
        store.delete(key);
        return false;
    }

    const input = String(code || '').trim();
    if (!/^\d{6}$/.test(input)) return false;

    if (record.hash !== hashCode(purpose, normalized, input)) {
        return false;
    }

    store.delete(key);
    return true;
};

export const clearCode = (purpose, email) => {
    store.delete(keyOf(purpose, email));
};

export const CODE_TTL_SECONDS = CODE_TTL_MS / 1000;
