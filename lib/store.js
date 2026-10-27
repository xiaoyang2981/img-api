import { createHash } from 'node:crypto';
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IMAGE_DIR, WEBP_DIR } from '../config.js';
import { extOf, MIME, probe, toWebp } from './image.js';
import * as db from './db.js';
import * as index from './index.js';
import { clearWatermarkCache } from './watermark.js';

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const safeUnlink = async (path) => {
    try {
        await unlink(path);
    } catch {
        // 文件本来就不存在，忽略
    }
};

// 保存一张图：内容寻址命名（sha256），天然去重
export const addFromBuffer = async (buffer, meta = {}, ownerId = null) => {
    const hash = sha256(buffer);
    const existing = index.findByHash(hash);
    if (existing) {
        return { image: existing, duplicate: true };
    }

    const info = await probe(buffer);
    const ext = extOf(info.format);
    if (!ext) {
        throw new Error('不支持的图片格式，仅支持 png / jpg / webp / gif / avif');
    }

    const id = hash.slice(0, 24);
    const file = `${id}.${ext}`;
    const imagePath = join(IMAGE_DIR, file);

    await writeFile(imagePath, buffer);

    let webp = null;
    let webpSize = 0;

    try {
        const bufferWebp = await toWebp(buffer, info.animated);
        webp = `${id}.webp`;
        await writeFile(join(WEBP_DIR, webp), bufferWebp);
        webpSize = bufferWebp.length;
    } catch (error) {
        console.error(`⚠️  ${id} 生成 webp 失败:`, error.message);
        webp = null;
    }

    const image = {
        id,
        hash,
        file,
        webp,
        mime: MIME[ext],
        size: buffer.length,
        webpSize,
        width: info.width,
        height: info.height,
        animated: info.animated,
        tags: index.normalizeTags(meta.tags),
        title: String(meta.title || '').trim().slice(0, 120),
        source: String(meta.source || '').trim().slice(0, 300),
        ownerId: ownerId ? Number(ownerId) : null,
        status: 'pending',
        visible: true,
        watermarked: meta.watermarked === true || meta.watermarked === 'true' || meta.watermarked === '1',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: '',
        createdAt: new Date().toISOString()
    };

    await index.addImage(image);
    return { image, duplicate: false };
};

export const removeImage = async (id) => {
    const image = index.getById(id);
    if (!image) return null;

    await safeUnlink(join(IMAGE_DIR, image.file));
    if (image.webp) {
        await safeUnlink(join(WEBP_DIR, image.webp));
    }

    db.clearAvatarForImage(id);
    await clearWatermarkCache(id);
    return index.removeImage(id);
};

// 扫描 data/images/：手动丢进去的图片也能自动入库
export const scanDirectory = async (ownerId = null) => {
    let entries = [];

    try {
        entries = await readdir(IMAGE_DIR);
    } catch {
        return { added: [], skipped: 0 };
    }

    const known = new Set(index.getAll().map((image) => image.file));
    const added = [];
    let skipped = 0;

    for (const name of entries) {
        if (known.has(name) || name.startsWith('.')) {
            skipped += 1;
            continue;
        }

        const sourcePath = join(IMAGE_DIR, name);

        try {
            const info = await stat(sourcePath);
            if (!info.isFile()) {
                skipped += 1;
                continue;
            }

            const buffer = await readFile(sourcePath);
            const result = await addFromBuffer(buffer, {}, ownerId);

            // 原始文件名和新文件名不同时，删掉旧文件，避免磁盘上留双份
            if (result.image.file !== name) {
                await safeUnlink(sourcePath);
            }

            if (!result.duplicate) {
                added.push(result.image);
            } else {
                skipped += 1;
            }
        } catch (error) {
            console.error(`⚠️  跳过 ${name}:`, error.message);
            skipped += 1;
        }
    }

    return { added, skipped };
};
