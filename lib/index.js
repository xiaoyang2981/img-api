import { getDb } from './db.js';

// 图片元数据以 SQLite 为准；启动时读入内存，查询/随机取图仍然走内存。
let images = [];
let byId = new Map();
let byHash = new Map();

const parseTags = (value) => {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const rowToImage = (row) => ({
    id: row.id,
    hash: row.hash,
    file: row.file,
    webp: row.webp || null,
    mime: row.mime,
    size: Number(row.size) || 0,
    webpSize: Number(row.webp_size) || 0,
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    animated: Boolean(row.animated),
    tags: parseTags(row.tags),
    rating: row.rating || 'sfw',
    title: row.title || '',
    source: row.source || '',
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : Number(row.owner_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at || null
});

export const loadIndex = async () => {
    const rows = getDb()
        .prepare('SELECT * FROM images ORDER BY created_at ASC, id ASC')
        .all();

    images = rows.map(rowToImage);
    byId = new Map(images.map((image) => [image.id, image]));
    byHash = new Map(images.map((image) => [image.hash, image]));
    return images;
};

export const getAll = () => images;

export const getById = (id) => byId.get(id) || null;

export const findByHash = (hash) => byHash.get(hash) || null;

export const addImage = async (image) => {
    getDb().prepare(`
        INSERT INTO images (
            id, hash, file, webp, mime, size, webp_size, width, height, animated,
            tags, rating, title, source, owner_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        image.id,
        image.hash,
        image.file,
        image.webp || null,
        image.mime || '',
        Number(image.size) || 0,
        Number(image.webpSize) || 0,
        Number(image.width) || 0,
        Number(image.height) || 0,
        image.animated ? 1 : 0,
        JSON.stringify(Array.isArray(image.tags) ? image.tags : []),
        image.rating || 'sfw',
        image.title || '',
        image.source || '',
        image.ownerId ?? null,
        image.createdAt || new Date().toISOString(),
        image.updatedAt || null
    );

    images.push(image);
    byId.set(image.id, image);
    byHash.set(image.hash, image);
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

    getDb().prepare(`
        UPDATE images
        SET tags = ?, rating = ?, title = ?, source = ?, updated_at = ?
        WHERE id = ?
    `).run(
        JSON.stringify(image.tags),
        image.rating,
        image.title,
        image.source,
        image.updatedAt,
        image.id
    );

    return image;
};

export const removeImage = async (id) => {
    const image = byId.get(id);
    if (!image) return null;

    getDb().prepare('DELETE FROM images WHERE id = ?').run(id);

    images = images.filter((item) => item.id !== id);
    byId.delete(id);
    byHash.delete(image.hash);
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
