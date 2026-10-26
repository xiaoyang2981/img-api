import { readFile } from 'node:fs/promises';
import { CONFIG_FILE, DEFAULT_PORT } from './lib/paths.js';
import { getAllSettings, initDb, deleteSetting, setSetting } from './lib/db.js';

export * from './lib/paths.js';

const DEFAULT_CONFIG = {
    siteName: '梦星的小图床',       // 前台左上角显示的名称
    port: DEFAULT_PORT,           // 端口，环境变量 PORT 优先级更高
    randomPreferWebp: true,       // /random 默认返回 webp
    allowPublicList: false,       // /list 是否需要登录
    allowRegistration: true,      // 是否允许公开注册（注册的账户固定为成员）
    enableEmailVerification: false, // 开启后注册必须邮箱验证码，忘记密码通过邮箱重置
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpPass: '',
    smtpFrom: '',
    maxUploadMB: 20,              // 单张图片大小上限
    rateLimitGuest: 200,          // 游客 GET 接口每分钟次数
    rateLimitUser: 2000,          // 注册用户 GET 接口每分钟次数
    tokenBanHours: 12             // Token 触发滥用限制后的默认封禁小时数
};

const coerce = {
    siteName: (value) => String(value ?? '').trim().slice(0, 60) || '梦星的小图床',
    port: (value) => Math.min(65535, Math.max(1, Number(value) || DEFAULT_PORT)),
    randomPreferWebp: (value) => value === true || value === 'true',
    allowPublicList: (value) => value === true || value === 'true',
    allowRegistration: (value) => value === true || value === 'true',
    enableEmailVerification: (value) => value === true || value === 'true',
    smtpHost: (value) => String(value ?? '').trim(),
    smtpPort: (value) => Math.min(65535, Math.max(1, Number(value) || 587)),
    smtpSecure: (value) => value === true || value === 'true',
    smtpUser: (value) => String(value ?? '').trim(),
    smtpPass: (value) => String(value ?? ''),
    smtpFrom: (value) => String(value ?? '').trim(),
    maxUploadMB: (value) => Math.min(500, Math.max(1, Number(value) || 20)),
    rateLimitGuest: (value) => Math.min(1000000, Math.max(1, Number(value) || 200)),
    rateLimitUser: (value) => Math.min(1000000, Math.max(1, Number(value) || 2000)),
    tokenBanHours: (value) => Math.min(8760, Math.max(1, Number(value) || 12))
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

    // 标签现在始终启用，清掉旧版遗留的开关
    if ('enableTags' in stored) {
        deleteSetting('enableTags');
        delete stored.enableTags;
    }

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
            // SMTP 密码留空表示保持原值，避免设置页每次保存都清空
            if (key === 'smtpPass' && !String(patch[key] || '').trim()) {
                continue;
            }
            config[key] = coerce[key](patch[key]);
            setSetting(key, String(config[key]));
        }
    }

    return config;
};
