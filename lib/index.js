import { readFile, writeFile, rename } from 'node:fs/promises';
import { INDEX_FILE } from '../config.js';

// 元数据索引：全部放在 data/index.json，量级不大的场景足够用
let images = [];
let byId = new Map();
let byHash = new Map();
let writeChain = Promise.resolve();

const persist = () => {
    writeChain = writeChain
        .then(async () => {
            const tmp = `${INDEX_FILE}.tmp`;
            const payload = JSON.stringify({ version: 1, images }, null, 2);
            await writeFile(tmp, payload, 'utf8');
            await rename(tmp, INDEX_FILE);
        })
        .catch((error) => {
            console.error('❌ 索引写入失败:', error.message);
        });

    return writeChain;
};

export const loadIndex = async () => {
    try {
        const data = JSON.parse(await readFile(INDEX_FILE, 'utf8'));
        images = Array.isArray(data.images) ? data.images : [];
    } catch {
        images = [];
    }

    byId = new Map(images.map((image) => [image.id, image]));
    byHash = new Map(images.map((image) => [image.hash, image]));
    return images;
};

export const getAll = () => images;

export const getById = (id) => byId.get(id) || null;

export const findByHash = (hash) => byHash.get(hash) || null;

export const addImage = async (image) => {
    images.push(image);
    byId.set(image.id, image);
    byHash.set(image.hash, image);
    await persist();
    return image;
};

export const updateImage = async (id, patch = {}) => {
    const image = byId.get(id);
    if (!image) return null;

    if (patch.tags !== undefined && patch.tags !== null) {
        image.tags = normalizeTags(patch.tags);
    }
    if (typeof patch.rating === 'string') {
        image.rating = normalizeRating(patch.rating);
    }
    if (typeof patch.title === 'string') {
        image.title = patch.title.trim().slice(0, 120);
    }
    if (typeof patch.source === 'string') {
        image.source = patch.source.trim().slice(0, 300);
    }

    image.updatedAt = new Date().toISOString();
    await persist();
    return image;
};

export const removeImage = async (id) => {
    const image = byId.get(id);
    if (!image) return null;

    images = images.filter((item) => item.id !== id);
    byId.delete(id);
    byHash.delete(image.hash);
    await persist();
    return image;
};

export const normalizeTags = (tags) => {
    const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
    const result = [];

    for (const raw of list) {
        const tag = String(raw).trim().toLowerCase().replace(/\s+/g, '-');
        if (tag && tag.length <= 40 && !result.includes(tag)) {
            result.push(tag);
        }
    }

    return result.slice(0, 20);
};

export const normalizeRating = (rating) => {
    const value = String(rating || '').trim().toLowerCase();
    return ['sfw', 'questionable', 'nsfw'].includes(value) ? value : 'sfw';
};

export const stats = () => {
    const totalSize = images.reduce((sum, image) => sum + (image.size || 0), 0);
    const webpSize = images.reduce((sum, image) => sum + (image.webpSize || 0), 0);

    return {
        count: images.length,
        totalSize,
        webpSize,
        tags: [...new Set(images.flatMap((image) => image.tags || []))].sort(),
        newest: images.length ? images[images.length - 1].createdAt : null
    };
};
