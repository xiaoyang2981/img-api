import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 所有路径都基于项目根目录，整个文件夹可以直接搬走。
// IMG_API_DATA_DIR 可把运行时数据放到别处（测试 / 独立数据盘）。
export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DATA_DIR = process.env.IMG_API_DATA_DIR
    ? resolve(process.env.IMG_API_DATA_DIR)
    : join(ROOT_DIR, 'data');

export const IMAGE_DIR = join(DATA_DIR, 'images');
export const WEBP_DIR = join(DATA_DIR, 'webp');
export const DB_FILE = join(DATA_DIR, 'img-api.db');
export const INDEX_FILE = join(DATA_DIR, 'index.json');
export const CONFIG_FILE = join(DATA_DIR, 'config.json');
export const PUBLIC_DIR = join(ROOT_DIR, 'public');

export const DEFAULT_PORT = 2618;
