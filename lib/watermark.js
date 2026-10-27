import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { IMAGE_DIR, WATERMARK_DIR } from '../config.js';
import { extOf } from './image.js';

const CACHE_VERSION = 2;

const escapeXml = (value) => String(value ?? '').replace(/[<>&"']/g, (ch) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;'
}[ch]));

const starPath = (cx, cy, radius) => {
    const inner = radius * 0.26;
    return [
        `M ${cx} ${cy - radius}`,
        `L ${cx + inner} ${cy - inner}`,
        `L ${cx + radius} ${cy}`,
        `L ${cx + inner} ${cy + inner}`,
        `L ${cx} ${cy + radius}`,
        `L ${cx - inner} ${cy + inner}`,
        `L ${cx - radius} ${cy}`,
        `L ${cx - inner} ${cy - inner}`,
        'Z'
    ].join(' ');
};

const sparkle = (size, color, opacity) => {
    const big = starPath(size * 0.38, size * 0.64, size * 0.3);
    const small = starPath(size * 0.74, size * 0.25, size * 0.17);
    return `<g fill="${color}" fill-opacity="${opacity}"><path d="${big}"/><path d="${small}"/></g>`;
};

const overlaySvg = (image, config) => {
    const width = Number(image.width) || 1;
    const height = Number(image.height) || 1;
    const box = Math.max(16, Math.round(Math.min(width, height) * Number(config.watermarkSize || 7) / 100));
    const margin = Math.max(8, Math.round(box * 0.35));
    const text = String(config.watermarkText || '✨');
    const opacity = Math.min(1, Math.max(0, Number(config.watermarkOpacity ?? 0.35)));
    const color = /^#[0-9a-f]{6}$/i.test(String(config.watermarkColor || ''))
        ? String(config.watermarkColor)
        : '#ffffff';
    const position = config.watermarkPosition || 'bottom-right';

    let x = width - margin - box;
    let y = height - margin - box;

    if (position === 'top-left') {
        x = margin;
        y = margin;
    } else if (position === 'top-right') {
        x = width - margin - box;
        y = margin;
    } else if (position === 'bottom-left') {
        x = margin;
        y = height - margin - box;
    } else if (position === 'center') {
        x = Math.round((width - box) / 2);
        y = Math.round((height - box) / 2);
    }

    let content;

    if (text === '✨') {
        content = `<g transform="translate(${x} ${y})">${sparkle(box, color, opacity)}</g>`;
    } else {
        const fontSize = Math.max(12, box);
        const textY = position.startsWith('top')
            ? y + fontSize
            : (position === 'center' ? y + Math.round(box / 2) : y + fontSize);
        const anchor = position.endsWith('right') ? 'end' : (position === 'center' ? 'middle' : 'start');

        content = `<text x="${x}" y="${textY}" text-anchor="${anchor}" ` +
            `dominant-baseline="${position === 'center' ? 'middle' : 'auto'}" ` +
            `font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="${fontSize}" ` +
            `font-weight="600" fill="${color}" fill-opacity="${opacity}">${escapeXml(text)}</text>`;
    }

    return Buffer.from(
        `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
        `xmlns="http://www.w3.org/2000/svg">${content}</svg>`
    );
};

const invisiblePayload = (image, siteName) => [
    'img-api',
    `image=${image.id}`,
    `hash=${String(image.hash || '').slice(0, 16)}`,
    `owner=${image.ownerId ?? 'unknown'}`,
    `site=${encodeURIComponent(siteName || '')}`
].join('|');

const outputPipeline = (pipeline, output) => {
    const format = String(output || '').toLowerCase();

    if (format === 'webp') return pipeline.webp({ quality: 82, effort: 4 });
    if (format === 'png') return pipeline.png({ compressionLevel: 9 });
    if (format === 'jpg' || format === 'jpeg') return pipeline.jpeg({ quality: 88, mozjpeg: true });
    if (format === 'avif') return pipeline.avif({ quality: 60, effort: 4 });
    if (format === 'gif') return pipeline.gif();

    return pipeline.toFormat(format);
};

const outputExtension = (image, output) => {
    const format = String(output || '').toLowerCase();
    if (format === 'origin') return extOf(String(image.mime || '').split('/').pop()) || 'bin';
    if (format === 'jpg' || format === 'jpeg') return 'jpg';
    return format || extOf(String(image.mime || '').split('/').pop()) || 'bin';
};

const watermarkConfig = (config) => ({
    text: config.watermarkText,
    opacity: config.watermarkOpacity,
    position: config.watermarkPosition,
    size: config.watermarkSize,
    color: config.watermarkColor
});

export const renderWatermarked = async (source, image, output, config) => {
    const payload = invisiblePayload(image, config.siteName);
    const actualOutput = output === 'origin' ? outputExtension(image, output) : output;
    const prepared = sharp(source, {
        animated: Boolean(image.animated && (actualOutput === 'webp' || actualOutput === 'gif'))
    }).rotate();
    let pipeline = prepared;

    // 动图的逐帧合成在 sharp 里不可靠，动图只写入不可见元数据，保留动画。
    if (!image.animated && Number(config.watermarkOpacity) > 0) {
        try {
            const overlay = await sharp(overlaySvg(image, config)).png().toBuffer();
            pipeline = pipeline.composite([{ input: overlay, top: 0, left: 0 }]);
        } catch (error) {
            console.error('⚠️  可见水印生成失败，将仅写入不可见水印:', error.message);
        }
    }

    try {
        pipeline = pipeline.withMetadata({
            exif: {
                IFD0: {
                    ImageDescription: payload,
                    Software: 'img-api',
                    Copyright: String(config.siteName || 'img-api')
                },
                ExifIFD: {
                    UserComment: payload
                }
            }
        });
    } catch {
        // 某些格式/平台不支持 EXIF 时仍继续输出，不让水印影响图片可用性。
    }

    return outputPipeline(pipeline, actualOutput).toBuffer();
};

export const getWatermarkedBuffer = async (image, output, config, {
    sourceBuffer = null,
    sourceKind = 'original'
} = {}) => {
    const ext = outputExtension(image, output);
    const key = createHash('sha256').update(JSON.stringify({
        version: CACHE_VERSION,
        hash: image.hash,
        output,
        sourceKind,
        siteName: config.siteName,
        watermark: watermarkConfig(config),
        payload: invisiblePayload(image, config.siteName)
    })).digest('hex').slice(0, 24);
    const filename = `${image.id}-${key}.${ext}`;
    const cachePath = join(WATERMARK_DIR, filename);

    try {
        return { buffer: await readFile(cachePath), cached: true, ext };
    } catch {
        // 未命中缓存
    }

    try {
        const source = sourceBuffer || await readFile(join(IMAGE_DIR, image.file));
        const buffer = await renderWatermarked(source, image, output, config);
        await mkdir(WATERMARK_DIR, { recursive: true });
        await writeFile(cachePath, buffer);
        return { buffer, cached: false, ext };
    } catch (error) {
        throw new Error(`水印生成失败: ${error.message}`);
    }
};

export const clearWatermarkCache = async (imageId) => {
    try {
        const entries = await readdir(WATERMARK_DIR);
        const prefix = `${imageId}-`;

        await Promise.all(entries
            .filter((name) => name.startsWith(prefix))
            .map((name) => unlink(join(WATERMARK_DIR, name)).catch(() => {})));
    } catch {
        // 缓存目录不存在时忽略
    }
};
