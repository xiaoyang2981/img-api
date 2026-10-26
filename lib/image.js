import sharp from 'sharp';

// 只接受这几种位图格式。SVG 故意不放行：直接以 image/svg+xml 输出存在脚本执行风险
export const FORMAT_EXT = {
    png: 'png',
    jpeg: 'jpg',
    webp: 'webp',
    gif: 'gif',
    avif: 'avif'
};

export const MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif'
};

export const extOf = (format) => FORMAT_EXT[format] || null;

// 读取尺寸等信息；sharp 解析失败会抛错，用它来判断是不是合法图片
export const probe = async (buffer) => {
    const meta = await sharp(buffer, { animated: true }).metadata();
    const rotated = [5, 6, 7, 8].includes(meta.orientation);

    return {
        format: meta.format,
        width: rotated ? meta.height : meta.width,
        height: rotated ? meta.width : meta.height,
        animated: (meta.pages || 1) > 1
    };
};

// 生成 webp 副本（动图保持动图）
export const toWebp = async (buffer, animated = false) => {
    return sharp(buffer, { animated })
        .rotate()
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
};
