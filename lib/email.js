export const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
