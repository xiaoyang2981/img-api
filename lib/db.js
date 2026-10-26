import { mkdir, readFile, rename } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_FILE, IMAGE_DIR, INDEX_FILE, WEBP_DIR } from './paths.js';

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    display_name TEXT NOT NULL DEFAULT '',
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    file TEXT NOT NULL,
    webp TEXT,
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    webp_size INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    animated INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    rating TEXT NOT NULL DEFAULT 'sfw',
    title TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_images_owner ON images(owner_id);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

const nowIso = () => new Date().toISOString();

const mapUser = (row) => {
    if (!row) return null;

    return {
        id: Number(row.id),
        username: row.username,
        passwordHash: row.password_hash,
        role: row.role,
        displayName: row.display_name,
        disabled: Boolean(row.disabled),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
};

// 把旧版 data/index.json 导入 SQLite，成功后改名，避免下次重复导入
const migrateIndexJson = async () => {
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM images').get().count);
    if (count > 0) return;

    let parsed;

    try {
        parsed = JSON.parse(await readFile(INDEX_FILE, 'utf8'));
    } catch {
        return;
    }

    const images = Array.isArray(parsed.images) ? parsed.images : [];
    const insert = db.prepare(`
        INSERT OR IGNORE INTO images (
            id, hash, file, webp, mime, size, webp_size, width, height, animated,
            tags, rating, title, source, owner_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `);

    db.exec('BEGIN');

    try {
        for (const image of images) {
            if (!image?.id || !image?.hash || !image?.file) continue;

            insert.run(
                String(image.id),
                String(image.hash),
                String(image.file),
                image.webp ? String(image.webp) : null,
                String(image.mime || ''),
                Number(image.size) || 0,
                Number(image.webpSize) || 0,
                Number(image.width) || 0,
                Number(image.height) || 0,
                image.animated ? 1 : 0,
                JSON.stringify(Array.isArray(image.tags) ? image.tags : []),
                String(image.rating || 'sfw'),
                String(image.title || ''),
                String(image.source || ''),
                String(image.createdAt || nowIso()),
                image.updatedAt ? String(image.updatedAt) : null
            );
        }

        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }

    try {
        await rename(INDEX_FILE, `${INDEX_FILE}.migrated`);
        console.log(`📦 已把 ${images.length} 条旧索引迁移到 SQLite（${INDEX_FILE}.migrated）`);
    } catch {
        // 改名失败不影响数据，下次启动会因 images 非空而跳过
    }
};

export const initDb = async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(IMAGE_DIR, { recursive: true });
    await mkdir(WEBP_DIR, { recursive: true });

    db = new DatabaseSync(DB_FILE);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);

    await migrateIndexJson();
    cleanupSessions();

    return db;
};

export const getDb = () => {
    if (!db) throw new Error('数据库尚未初始化');
    return db;
};

export const closeDb = () => {
    if (db?.isOpen) db.close();
    db = null;
};

// —— 用户 ——

export const countUsers = () => Number(getDb().prepare('SELECT COUNT(*) AS count FROM users').get().count);

export const countAdmins = () => Number(
    getDb().prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0").get().count
);

export const listUsers = () => getDb()
    .prepare('SELECT * FROM users ORDER BY id ASC')
    .all()
    .map(mapUser);

export const getUserById = (id) => mapUser(
    getDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id))
);

export const getUserByUsername = (username) => mapUser(
    getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || ''))
);

export const createUser = ({ username, passwordHash, role = 'user', displayName = '' }) => {
    const now = nowIso();
    const result = getDb().prepare(`
        INSERT INTO users (username, password_hash, role, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        String(username),
        String(passwordHash),
        role === 'admin' ? 'admin' : 'user',
        String(displayName || ''),
        now,
        now
    );

    return getUserById(Number(result.lastInsertRowid));
};

export const updateUser = (id, patch = {}) => {
    const user = getUserById(id);
    if (!user) return null;

    const passwordHash = patch.passwordHash ?? user.passwordHash;
    const role = patch.role ?? user.role;
    const displayName = patch.displayName ?? user.displayName;
    const disabled = patch.disabled === undefined ? (user.disabled ? 1 : 0) : (patch.disabled ? 1 : 0);

    getDb().prepare(`
        UPDATE users
        SET password_hash = ?, role = ?, display_name = ?, disabled = ?, updated_at = ?
        WHERE id = ?
    `).run(passwordHash, role === 'admin' ? 'admin' : 'user', String(displayName), disabled, nowIso(), user.id);

    return getUserById(user.id);
};

export const deleteUser = (id) => getDb()
    .prepare('DELETE FROM users WHERE id = ?')
    .run(Number(id))
    .changes > 0;

// —— 会话 ——

export const createSessionRow = ({ tokenHash, userId, expiresAt, userAgent = '' }) => {
    getDb().prepare(`
        INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent)
        VALUES (?, ?, ?, ?, ?)
    `).run(String(tokenHash), Number(userId), nowIso(), String(expiresAt), String(userAgent || ''));
};

export const getSessionUser = (tokenHash) => {
    const db = getDb();
    const row = db.prepare(`
        SELECT u.*, s.expires_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(String(tokenHash), nowIso());

    if (!row) return null;

    if (row.disabled) {
        deleteSession(tokenHash);
        return null;
    }

    return mapUser(row);
};

export const deleteSession = (tokenHash) => {
    getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(String(tokenHash));
};

export const deleteUserSessions = (userId, exceptTokenHash = null) => {
    if (exceptTokenHash) {
        getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(Number(userId), String(exceptTokenHash));
        return;
    }

    getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId));
};

export const cleanupSessions = () => {
    getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
};

// —— 设置 ——

export const getAllSettings = () => {
    const rows = getDb().prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
};

export const setSetting = (key, value) => {
    getDb().prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key), String(value));
};

// —— 图片辅助 ——

export const adoptOwnerlessImages = (userId) => {
    getDb().prepare('UPDATE images SET owner_id = ? WHERE owner_id IS NULL').run(Number(userId));
};

export const countImagesByOwner = () => {
    const rows = getDb().prepare(`
        SELECT owner_id, COUNT(*) AS count
        FROM images
        GROUP BY owner_id
    `).all();

    return new Map(rows.map((row) => [row.owner_id === null ? null : Number(row.owner_id), Number(row.count)]));
};
