import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { IMAGE_DIR, getConfig } from '../config.js';
import { getRequestUser } from '../lib/auth.js';
import * as db from '../lib/db.js';
import * as index from '../lib/index.js';
import { canViewImage } from '../lib/roles.js';
import { renderWatermarked } from '../lib/watermark.js';

const AVATAR_SIZE = 512;
const COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2', '#4f46e5'];

const clampSize = (value) => Math.min(1024, Math.max(32, Number(value) || AVATAR_SIZE));

const colorFor = (value) => {
    const hash = createHash('sha256').update(String(value || 'img-api')).digest();
    return COLORS[hash[0] % COLORS.length];
};

const defaultAvatarSvg = (user, size) => {
    const label = String(user?.username || user?.displayName || 'img-api');
    const color = colorFor(label);
    const head = Math.round(size * 0.19);
    const cy = Math.round(size * 0.36);

    return Buffer.from(`<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" rx="${Math.round(size * 0.2)}" fill="${color}"/>
        <circle cx="${Math.round(size / 2)}" cy="${cy}" r="${head}" fill="#ffffff" fill-opacity=".92"/>
        <path d="M ${Math.round(size * 0.2)} ${Math.round(size * 0.86)}
            C ${Math.round(size * 0.23)} ${Math.round(size * 0.63)}, ${Math.round(size * 0.38)} ${Math.round(size * 0.56)}, ${Math.round(size / 2)} ${Math.round(size * 0.56)}
            C ${Math.round(size * 0.62)} ${Math.round(size * 0.56)}, ${Math.round(size * 0.77)} ${Math.round(size * 0.63)}, ${Math.round(size * 0.8)} ${Math.round(size * 0.86)}
            Z" fill="#ffffff" fill-opacity=".92"/>
    </svg>`);
};

const renderDefault = async (user, size, type) => {
    const pipeline = sharp(defaultAvatarSvg(user, size)).resize(size, size);
    return type === 'png'
        ? pipeline.png({ compressionLevel: 9 }).toBuffer()
        : pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
};

const encodeAvatar = (source, type) => {
    const pipeline = sharp(source);
    return type === 'png'
        ? pipeline.png({ compressionLevel: 9 }).toBuffer()
        : pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
};

const resolveTarget = (c) => {
    const username = String(c.req.query('user') || c.req.query('username') || '').trim();
    const rawUid = String(c.req.query('uid') || '').trim();
    const explicit = Boolean(username || rawUid);

    if (explicit) {
        if (rawUid) {
            const id = Number(rawUid);
            return Number.isInteger(id) ? db.getUserById(id) : null;
        }
        return db.getUserByUsername(username);
    }

    return getRequestUser(c) || db.getPrimaryOwner();
};

// GET /api/avatar?user=username&uid=1&token=...&type=png&size=512
// 默认返回 JPG；type=png 返回 PNG。未指定用户时优先当前 Token/会话用户，
// 再回退到站长头像，方便直接把 /api/avatar 当作站点默认头像地址。
export const avatarHandler = async (c) => {
    const target = resolveTarget(c);
    const type = String(c.req.query('type') || 'jpg').toLowerCase() === 'png' ? 'png' : 'jpg';
    const size = clampSize(c.req.query('size'));
    const requester = getRequestUser(c);

    if (!target || target.disabled) {
        return c.json({ error: true, message: '头像用户不存在' }, 404);
    }

    const image = target.avatarImageId ? index.getById(target.avatarImageId) : null;
    const visibleImage = image && (
        image.status === 'approved' ||
        (requester && canViewImage(requester, image))
    ) ? image : null;

    const config = getConfig();
    const watermarkKey = visibleImage?.watermarked
        ? `${config.watermarkText}|${config.watermarkOpacity}|${config.watermarkPosition}|${config.watermarkSize}|${config.watermarkColor}|${config.siteName}`
        : '';
    const cacheKey = visibleImage
        ? `${visibleImage.hash}|${visibleImage.status}|${visibleImage.updatedAt || ''}|${type}|${size}|${watermarkKey}`
        : `default|${target.id}|${target.username}|${type}|${size}`;
    const etag = `"avatar-${createHash('sha256').update(cacheKey).digest('hex').slice(0, 20)}"`;
    const cacheControl = visibleImage && visibleImage.status !== 'approved'
        ? 'private, no-store'
        : 'public, max-age=3600';

    if (c.req.header('if-none-match') === etag) {
        return new Response(null, {
            status: 304,
            headers: {
                ETag: etag,
                'Cache-Control': cacheControl
            }
        });
    }

    let buffer;

    try {
        if (visibleImage) {
            const source = await readFile(join(IMAGE_DIR, visibleImage.file));
            const resized = await sharp(source, { animated: false })
                .rotate()
                .resize(size, size, { fit: 'cover', position: 'centre' })
                .toBuffer();

            if (visibleImage.watermarked) {
                try {
                    buffer = await renderWatermarked(resized, {
                        ...visibleImage,
                        width: size,
                        height: size
                    }, type, config);
                } catch {
                    buffer = await encodeAvatar(resized, type);
                }
            } else {
                buffer = await encodeAvatar(resized, type);
            }
        } else {
            buffer = await renderDefault(target, size, type);
        }
    } catch {
        buffer = await renderDefault(target, size, type);
    }

    return new Response(buffer, {
        headers: {
            'Content-Type': type === 'png' ? 'image/png' : 'image/jpeg',
            'Content-Length': String(buffer.length),
            'Cache-Control': cacheControl,
            'CDN-Cache-Control': cacheControl,
            'Cloudflare-CDN-Cache-Control': cacheControl,
            'X-Content-Type-Options': 'nosniff',
            ETag: etag,
            'X-Avatar-User': String(target.id)
        }
    });
};
