import { getDb } from './db.js';

// 图片元数据以 SQLite 为准；启动时读入内存，查询/随机取图仍然走内存。
let images = [];
let byId = new Map();
let byHash = new Map();
let byFile = new Map();

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
    title: row.title || '',
    source: row.source || '',
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : Number(row.owner_id),
    status: row.status || 'approved',
    reviewedBy: row.reviewed_by === null || row.reviewed_by === undefined ? null : Number(row.reviewed_by),
    reviewedAt: row.reviewed_at || null,
    reviewNote: row.review_note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at || null
});

const rebuildMaps = () => {
    byId = new Map(images.map((image) => [image.id, image]));
    byHash = new Map(images.map((image) => [image.hash, image]));
    byFile = new Map();

    for (const image of images) {
        byFile.set(image.file, image);
        if (image.webp) byFile.set(image.webp, image);
    }
};

export const loadIndex = async () => {
    const rows = getDb()
        .prepare('SELECT * FROM images ORDER BY created_at ASC, id ASC')
        .all();

    images = rows.map(rowToImage);
    rebuildMaps();
    return images;
};

export const getAll = () => images;

export const getById = (id) => byId.get(id) || null;

export const findByHash = (hash) => byHash.get(hash) || null;

export const findByFile = (name) => byFile.get(name) || null;

export const getApproved = () => images.filter((image) => image.status === 'approved');

export const getPending = () => images.filter((image) => image.status === 'pending');

export const getByStatus = (status) => {
    if (status === 'approved') return getApproved();
    if (status === 'pending') return getPending();
    if (status === 'rejected') return images.filter((image) => image.status === 'rejected');
    return images;
};

export const addImage = async (image) => {
    const status = ['pending', 'approved', 'rejected'].includes(image.status) ? image.status : 'pending';
    image.status = status;
    image.reviewedBy = image.reviewedBy ?? null;
    image.reviewedAt = image.reviewedAt ?? null;
    image.reviewNote = image.reviewNote ?? '';

    getDb().prepare(`
        INSERT INTO images (
            id, hash, file, webp, mime, size, webp_size, width, height, animated,
            tags, title, source, owner_id, status, reviewed_by, reviewed_at, review_note,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        image.title || '',
        image.source || '',
        image.ownerId ?? null,
        image.status,
        image.reviewedBy ?? null,
        image.reviewedAt ?? null,
        image.reviewNote || '',
        image.createdAt || new Date().toISOString(),
        image.updatedAt || null
    );

    images.push(image);
    byId.set(image.id, image);
    byHash.set(image.hash, image);
    byFile.set(image.file, image);
    if (image.webp) byFile.set(image.webp, image);
    return image;
};

export const updateImage = async (id, patch = {}) => {
    const image = byId.get(id);
    if (!image) return null;

    if (patch.tags !== undefined && patch.tags !== null) {
        image.tags = normalizeTags(patch.tags);
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
        SET tags = ?, title = ?, source = ?, updated_at = ?
        WHERE id = ?
    `).run(
        JSON.stringify(image.tags),
        image.title,
        image.source,
        image.updatedAt,
        image.id
    );

    return image;
};

export const setImageStatus = async (id, status, reviewerId = null, note = '') => {
    const image = byId.get(id);
    if (!image) return null;
    if (!['pending', 'approved', 'rejected'].includes(status)) return null;

    image.status = status;
    image.reviewedBy = status === 'pending' ? null : (reviewerId ?? null);
    image.reviewedAt = status === 'pending' ? null : new Date().toISOString();
    image.reviewNote = String(note || '').slice(0, 300);
    image.updatedAt = new Date().toISOString();

    getDb().prepare(`
        UPDATE images
        SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?
        WHERE id = ?
    `).run(
        image.status,
        image.reviewedBy,
        image.reviewedAt,
        image.reviewNote,
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
    byFile.delete(image.file);
    if (image.webp) byFile.delete(image.webp);
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

export const stats = () => {
    const approved = images.filter((image) => image.status === 'approved');
    const totalSize = approved.reduce((sum, image) => sum + (image.size || 0), 0);
    const webpSize = approved.reduce((sum, image) => sum + (image.webpSize || 0), 0);

    return {
        count: approved.length,
        totalSize,
        webpSize,
        tags: [...new Set(approved.flatMap((image) => image.tags || []))].sort(),
        newest: approved.length ? approved[approved.length - 1].createdAt : null
    };
};

export const reviewStats = (list = images) => ({
    pending: list.filter((image) => image.status === 'pending').length,
    approved: list.filter((image) => image.status === 'approved').length,
    rejected: list.filter((image) => image.status === 'rejected').length,
    total: list.length
});
