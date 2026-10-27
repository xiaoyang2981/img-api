import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_FILE, IMAGE_DIR, INDEX_FILE, WATERMARK_DIR, WEBP_DIR } from './paths.js';
import { normalizeEmail } from './email.js';
import { normalizeRole } from './roles.js';

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'moderator', 'member')),
    email TEXT,
    api_token_hash TEXT,
    api_token_hint TEXT,
    api_token_created_at TEXT,
    token_rate_limit_hits INTEGER NOT NULL DEFAULT 0,
    token_last_hit_at TEXT,
    token_banned_until TEXT,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_image_id TEXT,
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
    title TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    visible INTEGER NOT NULL DEFAULT 1,
    watermarked INTEGER NOT NULL DEFAULT 0,
    v2_status TEXT NOT NULL DEFAULT 'none',
    v2_requested_at TEXT,
    v2_reviewed_by INTEGER,
    v2_reviewed_at TEXT,
    v2_review_note TEXT NOT NULL DEFAULT '',
    reviewed_by INTEGER,
    reviewed_at TEXT,
    review_note TEXT NOT NULL DEFAULT '',
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

const generateApiToken = () => `img_${createHash('sha256').update(randomBytes(32)).digest('hex').slice(0, 48)}`;
const hashApiToken = (token) => createHash('sha256').update(String(token || '')).digest('hex');

const normalizeTags = (tags) => {
    const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
    const result = [];

    for (const raw of list) {
        const tag = String(raw).trim().toLowerCase().replace(/\s+/g, '-');
        if (tag && tag.length <= 40 && !result.includes(tag)) result.push(tag);
    }

    return result.slice(0, 20);
};

const mapUser = (row) => {
    if (!row) return null;

    return {
        id: Number(row.id),
        username: row.username,
        passwordHash: row.password_hash,
        role: row.role,
        email: row.email || null,
        hasApiToken: Boolean(row.api_token_hash),
        apiTokenHint: row.api_token_hint || null,
        apiTokenCreatedAt: row.api_token_created_at || null,
        tokenRateLimitHits: Number(row.token_rate_limit_hits) || 0,
        tokenLastHitAt: row.token_last_hit_at || null,
        tokenBannedUntil: row.token_banned_until || null,
        displayName: row.display_name,
        avatarImageId: row.avatar_image_id || null,
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
            tags, title, source, owner_id, status, reviewed_by, reviewed_at, review_note,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'approved', NULL, NULL, '', ?, ?)
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
                JSON.stringify(normalizeTags(image.tags)),
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

const ensureOwner = () => {
    const owners = Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner'").get().count);
    if (owners > 0) return;

    const first = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get()
        || db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();

    if (first) {
        db.prepare("UPDATE users SET role = 'owner', updated_at = ? WHERE id = ?").run(nowIso(), first.id);
        console.log(`👑 已把首个账户设为站长（用户 ID ${first.id}）`);
    }
};

const migrateUserEmailColumn = () => {
    const columns = new Set(
        db.prepare('PRAGMA table_info(users)').all().map((column) => column.name)
    );

    if (!columns.has('email')) {
        db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    }
    if (!columns.has('avatar_image_id')) {
        db.exec('ALTER TABLE users ADD COLUMN avatar_image_id TEXT');
    }
};

const createEmailIndex = () => {
    try {
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL AND email <> ''");
    } catch (error) {
        console.warn('⚠️ 邮箱唯一索引创建失败（可能已存在重复邮箱）:', error.message);
    }
};

const createUniqueApiToken = () => {
    let token;
    let hash;
    let hint;

    do {
        token = generateApiToken();
        hash = hashApiToken(token);
        hint = token.slice(-6);
    } while (db.prepare('SELECT 1 FROM users WHERE api_token_hash = ?').get(hash));

    return { token, hash, hint };
};

const migrateUserApiToken = () => {
    const columns = new Set(
        db.prepare('PRAGMA table_info(users)').all().map((column) => column.name)
    );

    const additions = {
        api_token_hash: 'TEXT',
        api_token_hint: 'TEXT',
        api_token_created_at: 'TEXT',
        token_rate_limit_hits: 'INTEGER NOT NULL DEFAULT 0',
        token_last_hit_at: 'TEXT',
        token_banned_until: 'TEXT'
    };

    for (const [name, type] of Object.entries(additions)) {
        if (!columns.has(name)) {
            db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
        }
    }

    // 旧版本把 Token 明文存在 api_token 中；升级后只保留哈希，Token 不再能再次显示。
    if (columns.has('api_token')) {
        const rows = db.prepare(`
            SELECT id, api_token, updated_at
            FROM users
            WHERE api_token IS NOT NULL AND api_token <> ''
              AND (api_token_hash IS NULL OR api_token_hash = '')
        `).all();
        const update = db.prepare(`
            UPDATE users
            SET api_token_hash = ?, api_token_hint = ?, api_token_created_at = ?, api_token = NULL
            WHERE id = ?
        `);

        for (const row of rows) {
            update.run(
                hashApiToken(row.api_token),
                String(row.api_token).slice(-6),
                row.updated_at || nowIso(),
                row.id
            );
        }

        if (rows.length) {
            console.log(`🔑 已将 ${rows.length} 个旧 API Token 迁移为哈希存储`);
        }
    }

    try {
        db.exec('DROP INDEX IF EXISTS idx_users_api_token');
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_token_hash ON users(api_token_hash) WHERE api_token_hash IS NOT NULL AND api_token_hash <> ''");
    } catch (error) {
        console.warn('⚠️ API Token 哈希唯一索引创建失败（可能已存在重复 Token）:', error.message);
    }
};

// 旧库的 users.role 只有 admin/user，需要重建表才能放开新的身份组
const migrateUserRoles = () => {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    if (!table) return;

    if (table.sql.includes("'owner'") && table.sql.includes("'moderator'")) {
        ensureOwner();
        return;
    }

    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN');

    try {
        db.exec(`
            CREATE TABLE users_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'moderator', 'member')),
                email TEXT,
                display_name TEXT NOT NULL DEFAULT '',
                disabled INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);

        db.exec(`
            INSERT INTO users_new (id, username, password_hash, role, email, display_name, disabled, created_at, updated_at)
            SELECT
                id,
                username,
                password_hash,
                CASE role WHEN 'user' THEN 'member' ELSE role END,
                email,
                display_name,
                disabled,
                created_at,
                updated_at
            FROM users
        `);

        db.exec('DROP TABLE users;');
        db.exec('ALTER TABLE users_new RENAME TO users;');
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        db.exec('PRAGMA foreign_keys = ON;');
        throw error;
    }

    db.exec('PRAGMA foreign_keys = ON;');

    try {
        db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users', 'users_new')");
        const max = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS max FROM users').get().max);
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('users', ?)").run(max);
    } catch {
        // 没有 sqlite_sequence 时忽略
    }

    console.log('👥 已迁移用户身份组（user → member）');
    ensureOwner();
};

const migrateImageSchema = () => {
    const columns = new Set(
        db.prepare('PRAGMA table_info(images)').all().map((column) => column.name)
    );

    if (!columns.has('status')) {
        // 旧图片默认直接视为已通过，避免升级后图库突然清空
        db.exec("ALTER TABLE images ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
    }
    if (!columns.has('visible')) {
        db.exec('ALTER TABLE images ADD COLUMN visible INTEGER NOT NULL DEFAULT 1');
    }
    if (!columns.has('watermarked')) {
        db.exec('ALTER TABLE images ADD COLUMN watermarked INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.has('v2_status')) {
        db.exec("ALTER TABLE images ADD COLUMN v2_status TEXT NOT NULL DEFAULT 'none'");
    }
    if (!columns.has('v2_requested_at')) {
        db.exec('ALTER TABLE images ADD COLUMN v2_requested_at TEXT');
    }
    if (!columns.has('v2_reviewed_by')) {
        db.exec('ALTER TABLE images ADD COLUMN v2_reviewed_by INTEGER');
    }
    if (!columns.has('v2_reviewed_at')) {
        db.exec('ALTER TABLE images ADD COLUMN v2_reviewed_at TEXT');
    }
    if (!columns.has('v2_review_note')) {
        db.exec("ALTER TABLE images ADD COLUMN v2_review_note TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.has('reviewed_by')) {
        db.exec('ALTER TABLE images ADD COLUMN reviewed_by INTEGER');
    }
    if (!columns.has('reviewed_at')) {
        db.exec('ALTER TABLE images ADD COLUMN reviewed_at TEXT');
    }
    if (!columns.has('review_note')) {
        db.exec("ALTER TABLE images ADD COLUMN review_note TEXT NOT NULL DEFAULT ''");
    }

    // 评级系统已移除；旧库直接删除 rating 列，失败时保留但代码不再使用
    if (columns.has('rating')) {
        try {
            db.exec('ALTER TABLE images DROP COLUMN rating');
        } catch (error) {
            console.warn('⚠️ 旧 rating 列删除失败，已忽略:', error.message);
        }
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_images_status ON images(status)');
};

export const initDb = async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(IMAGE_DIR, { recursive: true });
    await mkdir(WEBP_DIR, { recursive: true });
    await mkdir(WATERMARK_DIR, { recursive: true });

    db = new DatabaseSync(DB_FILE);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);

    migrateUserEmailColumn();
    migrateUserRoles();
    createEmailIndex();
    migrateUserApiToken();
    migrateImageSchema();

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

export const countOwners = () => Number(
    getDb().prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner' AND disabled = 0").get().count
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

export const getUserByEmail = (email) => mapUser(
    getDb().prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(normalizeEmail(email))
);

export const getUserByApiToken = (token) => {
    const value = String(token || '').trim();
    if (!value) return null;

    return mapUser(
        getDb().prepare('SELECT * FROM users WHERE api_token_hash = ?').get(hashApiToken(value))
    );
};

export const createUser = ({ username, passwordHash, role = 'member', displayName = '', email = null }) => {
    const now = nowIso();
    const result = getDb().prepare(`
        INSERT INTO users (username, password_hash, role, email, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        String(username),
        String(passwordHash),
        normalizeRole(role),
        normalizeEmail(email) || null,
        String(displayName || ''),
        now,
        now
    );

    return getUserById(Number(result.lastInsertRowid));
};

export const issueApiToken = (userId) => {
    const user = getUserById(userId);
    if (!user) return null;

    const { token, hash, hint } = createUniqueApiToken();
    const now = nowIso();

    getDb().prepare(`
        UPDATE users
        SET api_token_hash = ?, api_token_hint = ?, api_token_created_at = ?, updated_at = ?
        WHERE id = ?
    `).run(hash, hint, now, now, user.id);

    return { token, hint, createdAt: now };
};

export const revokeApiToken = (userId) => {
    const user = getUserById(userId);
    if (!user) return null;

    const now = nowIso();

    getDb().prepare(`
        UPDATE users
        SET api_token_hash = NULL, api_token_hint = NULL,
            api_token_created_at = NULL, updated_at = ?
        WHERE id = ?
    `).run(now, user.id);

    return getUserById(user.id);
};

export const setTokenBan = (userId, until = null) => {
    const user = getUserById(userId);
    if (!user) return null;

    const now = nowIso();

    if (until) {
        getDb().prepare(`
            UPDATE users SET token_banned_until = ?, updated_at = ? WHERE id = ?
        `).run(String(until), now, user.id);
    } else {
        getDb().prepare(`
            UPDATE users
            SET token_banned_until = NULL, token_rate_limit_hits = 0,
                token_last_hit_at = NULL, updated_at = ?
            WHERE id = ?
        `).run(now, user.id);
    }

    return getUserById(user.id);
};

export const recordTokenRateLimitHit = (userId, { threshold = 5, windowMs = 10 * 60 * 1000, banHours = 12 } = {}) => {
    const user = getUserById(userId);
    if (!user) return null;

    const now = Date.now();
    const lastHit = user.tokenLastHitAt ? Date.parse(user.tokenLastHitAt) : 0;
    let hits = Number(user.tokenRateLimitHits) || 0;
    let bannedUntil = user.tokenBannedUntil;

    if (!lastHit || !Number.isFinite(lastHit) || now - lastHit > windowMs) {
        hits = 0;
    }

    if (bannedUntil && Date.parse(bannedUntil) <= now) {
        bannedUntil = null;
    }

    hits += 1;
    let newlyBanned = false;

    if (!bannedUntil && hits >= threshold) {
        const hours = Math.max(1, Number(banHours) || 12);
        bannedUntil = new Date(now + hours * 60 * 60 * 1000).toISOString();
        newlyBanned = true;
    }

    const timestamp = new Date(now).toISOString();

    getDb().prepare(`
        UPDATE users
        SET token_rate_limit_hits = ?, token_last_hit_at = ?,
            token_banned_until = ?, updated_at = ?
        WHERE id = ?
    `).run(hits, timestamp, bannedUntil || null, timestamp, user.id);

    return { hits, bannedUntil: bannedUntil || null, newlyBanned };
};

export const updateUser = (id, patch = {}) => {
    const user = getUserById(id);
    if (!user) return null;

    const passwordHash = patch.passwordHash ?? user.passwordHash;
    const role = patch.role ?? user.role;
    const displayName = patch.displayName ?? user.displayName;
    const disabled = patch.disabled === undefined ? (user.disabled ? 1 : 0) : (patch.disabled ? 1 : 0);
    const email = patch.email !== undefined ? (normalizeEmail(patch.email) || null) : user.email;
    const avatarImageId = patch.avatarImageId !== undefined
        ? (patch.avatarImageId ? String(patch.avatarImageId) : null)
        : user.avatarImageId;

    getDb().prepare(`
        UPDATE users
        SET password_hash = ?, role = ?, email = ?, display_name = ?, avatar_image_id = ?, disabled = ?, updated_at = ?
        WHERE id = ?
    `).run(
        passwordHash,
        normalizeRole(role),
        email,
        String(displayName),
        avatarImageId || null,
        disabled,
        nowIso(),
        user.id
    );

    return getUserById(user.id);
};

export const setUserAvatar = (userId, imageId) => updateUser(userId, { avatarImageId: imageId });

export const clearAvatarForImage = (imageId) => {
    getDb().prepare('UPDATE users SET avatar_image_id = NULL WHERE avatar_image_id = ?').run(String(imageId));
};

export const getPrimaryOwner = () => mapUser(
    getDb().prepare("SELECT * FROM users WHERE role = 'owner' AND disabled = 0 ORDER BY id ASC LIMIT 1").get()
);

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

export const deleteSetting = (key) => {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(String(key));
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
