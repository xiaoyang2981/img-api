import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PUBLIC_DIR } from './paths.js';

export const servePage = async (c, fileName) => {
    try {
        const html = await readFile(join(PUBLIC_DIR, fileName), 'utf8');
        c.header('Cache-Control', 'no-store');
        return c.html(html);
    } catch {
        return c.text('页面文件缺失: ' + fileName, 500);
    }
};

export const serveAsset = async (c, fileName, contentType) => {
    try {
        const content = await readFile(join(PUBLIC_DIR, fileName));
        return new Response(content, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'no-cache'
            }
        });
    } catch {
        return c.text('资源文件缺失: ' + fileName, 404);
    }
};
