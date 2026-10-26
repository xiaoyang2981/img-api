import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// 所有路径都基于项目根目录，整个文件夹可以直接搬走
export const ROOT_DIR = import.meta.dirname;
export const DATA_DIR = join(ROOT_DIR, 'data');
export const IMAGE_DIR = join(DATA_DIR, 'images');
export const WEBP_DIR = join(DATA_DIR, 'webp');
export const INDEX_FILE = join(DATA_DIR, 'index.json');
export const CONFIG_FILE = join(DATA_DIR, 'config.json');
export const PUBLIC_DIR = join(ROOT_DIR, 'public');

export const DEFAULT_PORT = 2618;

const DEFAULT_CONFIG = {
    port: DEFAULT_PORT,           // 端口，环境变量 PORT 优先级更高
    enableTags: false,            // 默认不启用标签：/random 纯随机
    randomPreferWebp: true,       // /random 默认返回 webp
    allowPublicList: false,       // /list 是否需要令牌
    maxUploadMB: 20,              // 单张图片大小上限
    adminToken: ''                // 首次启动自动生成
};

let config = { ...DEFAULT_CONFIG };

export const getConfig = () => config;

export const getPort = () => Number(process.env.PORT) || Number(config.port) || DEFAULT_PORT;

const exists = async (path) => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

export const saveConfig = async () => {
    const tmp = `${CONFIG_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await rename(tmp, CONFIG_FILE);
};

const coerce = {
    port: (value) => Math.min(65535, Math.max(1, Number(value) || DEFAULT_PORT)),
    enableTags: (value) => value === true || value === 'true',
    randomPreferWebp: (value) => value === true || value === 'true',
    allowPublicList: (value) => value === true || value === 'true',
    maxUploadMB: (value) => Math.min(500, Math.max(1, Number(value) || 20))
};

// 只允许修改白名单里的字段，令牌由 regenerateToken 单独处理
export const updateConfig = async (patch = {}) => {
    for (const key of Object.keys(coerce)) {
        if (key in patch) {
            config[key] = coerce[key](patch[key]);
        }
    }
    await saveConfig();
    return config;
};

export const regenerateToken = async () => {
    config.adminToken = randomBytes(24).toString('base64url');
    await saveConfig();
    return config.adminToken;
};

export const initConfig = async () => {
    await mkdir(IMAGE_DIR, { recursive: true });
    await mkdir(WEBP_DIR, { recursive: true });

    try {
        const parsed = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
        config = { ...DEFAULT_CONFIG, ...parsed };
    } catch {
        config = { ...DEFAULT_CONFIG };
    }

    let needSave = false;

    if (!config.adminToken) {
        config.adminToken = randomBytes(24).toString('base64url');
        needSave = true;
    }

    if (needSave || !(await exists(CONFIG_FILE))) {
        await saveConfig();
    }

    return config;
};
