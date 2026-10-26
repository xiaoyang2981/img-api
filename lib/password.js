import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// 格式：scrypt$N$r$p$salt(base64url)$key(base64url)
export const hashPassword = async (password) => {
    const salt = randomBytes(SALT_LENGTH);
    const key = await scrypt(String(password), salt, KEY_LENGTH, SCRYPT);

    return [
        'scrypt',
        SCRYPT.N,
        SCRYPT.r,
        SCRYPT.p,
        salt.toString('base64url'),
        key.toString('base64url')
    ].join('$');
};

export const verifyPassword = async (password, stored) => {
    try {
        const [algorithm, n, r, p, saltText, keyText] = String(stored || '').split('$');
        if (algorithm !== 'scrypt' || !saltText || !keyText) return false;

        const salt = Buffer.from(saltText, 'base64url');
        const expected = Buffer.from(keyText, 'base64url');
        const actual = await scrypt(String(password), salt, expected.length, {
            N: Number(n),
            r: Number(r),
            p: Number(p)
        });

        return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
};

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export const validatePassword = (password) =>
    typeof password === 'string'
    && password.length >= MIN_PASSWORD_LENGTH
    && password.length <= MAX_PASSWORD_LENGTH;
