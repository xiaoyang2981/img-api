import { readFile } from 'node:fs/promises';
import { CONFIG_FILE, DEFAULT_PORT } from './lib/paths.js';
import { getAllSettings, initDb, setSetting } from './lib/db.js';

export * from './lib/paths.js';

const DEFAULT_CONFIG = {
    port: DEFAULT_PORT,           // 端口，环境变量 PORT 优先级更高
    enableTags: false,            // 默认不启用标签：/random 纯随机
    randomPreferWebp: true,       // /random 默认返回 webp
    allowPublicList: false,       // /list 是否需要登录
    maxUploadMB: 20               // 单张图片大小上限
};

const coerce = {
    port: (value) => Math.min(65535, Math.max(1, Number(value) || DEFAULT_PORT)),
    enableTags: (value) => value === true || value === 'true',
    randomPreferWebp: (value) => value === true || value === 'true',
    allowPublicList: (value) => value === true || value === 'true',
    maxUploadMB: (value) => Math.min(500, Math.max(1, Number(value) || 20))
};

let config = { ...DEFAULT_CONFIG };

export const getConfig = () => config;

export const getPort = () => Number(process.env.PORT) || Number(config.port) || DEFAULT_PORT;

// 旧版 data/config.json 里的设置（包括 adminToken）只迁移一次；
// adminToken 不再使用，账户改由 SQLite 的 users 表管理。
const migrateLegacyConfig = async () => {
    const existing = getAllSettings();
    if (Object.keys(existing).length) return existing;

    let legacy;

    try {
        legacy = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    } catch {
        return existing;
    }

    const migrated = {};

    for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (!(key in legacy)) continue;

        const value = coerce[key](legacy[key]);
        setSetting(key, String(value));
        migrated[key] = String(value);
    }

    if (migrated.port) {
        console.log(`📦 已从旧版 config.json 迁移设置（端口 ${migrated.port}）`);
    }

    return getAllSettings();
};

export const initConfig = async () => {
    await initDb();

    const stored = await migrateLegacyConfig();
    config = { ...DEFAULT_CONFIG };
    let needSave = false;

    for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (key in stored) {
            config[key] = coerce[key](stored[key]);
        } else {
            needSave = true;
        }
    }

    if (needSave) {
        for (const key of Object.keys(DEFAULT_CONFIG)) {
            setSetting(key, String(config[key]));
        }
    }

    return config;
};

// 只允许修改白名单里的字段
export const updateConfig = async (patch = {}) => {
    for (const key of Object.keys(coerce)) {
        if (key in patch) {
            config[key] = coerce[key](patch[key]);
            setSetting(key, String(config[key]));
        }
    }

    return config;
};
