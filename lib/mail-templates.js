import { CODE_TTL_SECONDS } from './email-codes.js';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',Arial,sans-serif";
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";
const TTL_MINUTES = Math.round(CODE_TTL_SECONDS / 60);

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const displaySiteName = (siteName) => oneLine(siteName) || 'img-api';

const formatTime = (date = new Date()) => {
    const parts = new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'short'
    }).formatToParts(date);
    const value = (type) => parts.find((part) => part.type === type)?.value || '';

    return `${value('year')}/${value('month')}/${value('day')} ${value('hour')}:${value('minute')} (${value('timeZoneName')})`;
};

const textFooter = (siteName) => [
    '--',
    `此邮件由「${siteName}」系统自动发送，请勿直接回复。`,
    `© ${new Date().getFullYear()} ${siteName} · img-api`
].join('\n');

const spacer = (height) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td height="${height}" style="height:${height}px;font-size:0;line-height:0;">&nbsp;</td></tr>
</table>`;

const htmlHeader = (siteName) => `<tr>
    <td height="4" bgcolor="#50b7fe" style="height:4px;font-size:0;line-height:0;">&nbsp;</td>
</tr>
<tr>
    <td class="email-head" bgcolor="#101828" style="padding:26px 36px;background-color:#101828;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
            <tr>
                <td style="vertical-align:top;">
                    <div style="font-size:18px;font-weight:700;line-height:1.4;color:#ffffff;">${escapeHtml(siteName)}</div>
                    <div style="margin-top:4px;font-size:11px;letter-spacing:.08em;line-height:1.5;color:#98a2b3;">图片托管服务</div>
                </td>
                <td align="right" valign="top">
                    <span style="display:inline-block;padding:5px 9px;border:1px solid #344054;border-radius:6px;font-size:10px;font-weight:600;letter-spacing:.12em;line-height:1.4;color:#cbd5e1;">IMG · API</span>
                </td>
            </tr>
        </table>
    </td>
</tr>`;

const htmlFooter = (siteName) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
    <tr>
        <td style="padding-top:18px;border-top:1px solid #eaecf0;font-size:12px;line-height:1.7;color:#98a2b3;">
            此邮件由「${escapeHtml(siteName)}」系统自动发送，请勿直接回复。<br>
            © ${new Date().getFullYear()} ${escapeHtml(siteName)} · img-api
        </td>
    </tr>
</table>`;

const codeCard = (code) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f9ff" style="border-collapse:separate;background-color:#f5f9ff;border:1px solid #d6e9ff;border-radius:14px;">
    <tr>
        <td align="center" style="padding:20px 16px 18px;">
            <div style="font-size:11px;font-weight:600;letter-spacing:.14em;line-height:1.5;color:#667085;">验证码</div>
            <div class="email-code" style="margin-top:7px;font-family:${MONO};font-size:34px;font-weight:700;line-height:1.2;letter-spacing:8px;color:#101828;">${escapeHtml(code)}</div>
            <div style="margin-top:10px;font-size:12px;line-height:1.6;color:#667085;">${TTL_MINUTES} 分钟内有效 · 仅可使用一次</div>
        </td>
    </tr>
</table>`;

const noteCard = ({ title = '', text, tone = 'neutral' }) => {
    const palette = tone === 'warning'
        ? { bg: '#fff8ed', border: '#fde6c7', text: '#8a4b00', title: '#8a4b00' }
        : { bg: '#f8fafc', border: '#e4e7ec', text: '#475467', title: '#344054' };

    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.bg}" style="border-collapse:separate;background-color:${palette.bg};border:1px solid ${palette.border};border-radius:12px;">
        <tr>
            <td style="padding:14px 16px;font-size:13px;line-height:1.7;color:${palette.text};">
                ${title ? `<strong style="display:block;margin-bottom:3px;color:${palette.title};">${escapeHtml(title)}</strong>` : ''}
                ${escapeHtml(text)}
            </td>
        </tr>
    </table>`;
};

const successCard = (title, text) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ecfdf3" style="border-collapse:separate;background-color:#ecfdf3;border:1px solid #abefc6;border-radius:12px;">
    <tr>
        <td style="padding:16px;font-size:14px;line-height:1.7;color:#067647;">
            <strong style="display:block;margin-bottom:3px;color:#067647;">${escapeHtml(title)}</strong>
            ${escapeHtml(text)}
        </td>
    </tr>
</table>`;

const infoTable = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border-collapse:collapse;border-top:1px solid #eaecf0;">
    ${rows.map(({ label, value }, index) => `<tr>
        <td class="email-info-label" style="width:104px;padding:11px 0;border-bottom:${index === rows.length - 1 ? 'none' : '1px solid #eaecf0'};font-size:12px;line-height:1.6;color:#667085;">${escapeHtml(label)}</td>
        <td align="right" style="padding:11px 0;border-bottom:${index === rows.length - 1 ? 'none' : '1px solid #eaecf0'};font-size:12px;line-height:1.6;color:#344054;word-break:break-all;">${escapeHtml(value)}</td>
    </tr>`).join('')}
</table>`;

const layout = ({ siteName, preheader, eyebrow, title, content }) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
<style>
    @media only screen and (max-width: 620px) {
        .email-wrap { padding: 18px 10px !important; }
        .email-card { border-radius: 14px !important; }
        .email-head { padding: 22px !important; }
        .email-pad { padding: 26px 22px !important; }
        .email-title { font-size: 21px !important; }
        .email-code { font-size: 30px !important; letter-spacing: 6px !important; }
        .email-info-label { width: 92px !important; }
    }
</style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:#f3f6fb;font-family:${FONT};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#f3f6fb;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f6fb" style="width:100%;background-color:#f3f6fb;border-collapse:collapse;">
    <tr>
        <td class="email-wrap" align="center" style="padding:36px 16px;">
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="email-card" style="width:100%;max-width:600px;border-collapse:separate;background-color:#ffffff;border:1px solid #e4e7ec;border-radius:18px;overflow:hidden;">
                ${htmlHeader(siteName)}
                <tr>
                    <td class="email-pad" style="padding:32px 36px 30px;">
                        <div style="display:inline-block;padding:4px 10px;border-radius:99px;background-color:#eff8ff;font-size:11px;font-weight:600;letter-spacing:.08em;line-height:1.5;color:#1677c8;">${escapeHtml(eyebrow)}</div>
                        <h1 class="email-title" style="margin:14px 0 10px;font-size:24px;line-height:1.35;font-weight:700;color:#101828;">${escapeHtml(title)}</h1>
                        ${content}
                        ${spacer(26)}
                        ${htmlFooter(siteName)}
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
</body>
</html>`;

const introHtml = (text) => `<p style="margin:0;font-size:15px;line-height:1.8;color:#475467;">${escapeHtml(text)}</p>`;

export const registrationCodeEmail = ({ siteName, code }) => {
    const name = displaySiteName(siteName);
    const intro = `你好，欢迎注册「${name}」。请使用下面的验证码完成邮箱验证。`;
    const note = {
        title: '请妥善保管验证码',
        text: '请勿将验证码转发给他人。如果这不是你本人的操作，请忽略这封邮件，验证码会自动失效。'
    };

    return {
        subject: `【${name}】注册验证码`,
        text: [
            '你好，',
            '',
            `欢迎注册「${name}」。请使用以下验证码完成邮箱验证：`,
            '',
            code,
            '',
            `${TTL_MINUTES} 分钟内有效，仅可使用一次。请勿将验证码转发给他人。`,
            '',
            '如果这不是你本人的操作，请忽略这封邮件，验证码会自动失效。',
            '',
            textFooter(name)
        ].join('\n'),
        html: layout({
            siteName: name,
            preheader: `你的注册验证码已发送，${TTL_MINUTES} 分钟内有效。`,
            eyebrow: '账户验证',
            title: '完成邮箱验证',
            content: [
                introHtml(intro),
                spacer(22),
                codeCard(code),
                spacer(14),
                noteCard(note)
            ].join('')
        })
    };
};

export const passwordResetCodeEmail = ({ siteName, username, code }) => {
    const name = displaySiteName(siteName);
    const user = oneLine(username) || '你';
    const intro = `你好，${user}。我们收到了重置「${name}」账户密码的请求，请使用下面的验证码继续操作。`;
    const note = {
        title: '不是你本人操作？',
        text: '如果你没有发起这次密码重置请求，请忽略这封邮件，你的密码不会被修改。请勿将验证码转发给他人。',
        tone: 'warning'
    };

    return {
        subject: `【${name}】密码重置验证码`,
        text: [
            `你好，${user}：`,
            '',
            `我们收到了重置「${name}」账户密码的请求。请使用以下验证码继续操作：`,
            '',
            code,
            '',
            `${TTL_MINUTES} 分钟内有效，仅可使用一次。请勿将验证码转发给他人。`,
            '',
            '如果你没有发起这次请求，请忽略这封邮件，你的密码不会被修改。',
            '',
            textFooter(name)
        ].join('\n'),
        html: layout({
            siteName: name,
            preheader: `密码重置验证码已发送，${TTL_MINUTES} 分钟内有效。`,
            eyebrow: '账户安全',
            title: '重置账户密码',
            content: [
                introHtml(intro),
                spacer(22),
                codeCard(code),
                spacer(14),
                noteCard(note)
            ].join('')
        })
    };
};

export const profileSecurityCodeEmail = ({ siteName, username, action, newEmail = '', code }) => {
    const name = displaySiteName(siteName);
    const user = oneLine(username) || '你';
    const target = oneLine(newEmail);

    const variants = {
        'email-bind': {
            subject: `【${name}】绑定邮箱验证码`,
            preheader: `绑定邮箱验证码已发送，${TTL_MINUTES} 分钟内有效。`,
            eyebrow: '邮箱验证',
            title: '绑定邮箱',
            intro: `你好，${user}。你正在为账户绑定邮箱 ${target}，请使用下面的验证码完成验证。`,
            textIntro: `你正在为账户绑定邮箱 ${target}，请使用以下验证码完成验证：`,
            warning: '如果这不是你本人的操作，请忽略这封邮件，账户不会绑定此邮箱。',
            note: {
                title: '请妥善保管验证码',
                text: '请勿将验证码转发给他人。如果这不是你本人的操作，请忽略这封邮件，账户不会绑定此邮箱。'
            }
        },
        'email-change': {
            subject: `【${name}】邮箱变更验证码`,
            preheader: `邮箱变更验证码已发送，${TTL_MINUTES} 分钟内有效。`,
            eyebrow: '账户安全',
            title: '确认修改邮箱',
            intro: `你好，${user}。我们收到了将账户邮箱修改为 ${target} 的请求，请使用下面的验证码确认。`,
            textIntro: `我们收到了将账户邮箱修改为 ${target} 的请求。请使用以下验证码确认：`,
            warning: '如果你没有发起这次请求，请忽略这封邮件，你的邮箱不会被修改。',
            note: {
                title: '不是你本人操作？',
                text: '如果你没有发起这次邮箱修改请求，请忽略这封邮件，你的邮箱不会被修改。请勿将验证码转发给他人。',
                tone: 'warning'
            }
        },
        'password-change': {
            subject: `【${name}】密码修改验证码`,
            preheader: `密码修改验证码已发送，${TTL_MINUTES} 分钟内有效。`,
            eyebrow: '账户安全',
            title: '确认修改密码',
            intro: `你好，${user}。我们收到了修改账户密码的请求，请使用下面的验证码确认。`,
            textIntro: '我们收到了修改账户密码的请求。请使用以下验证码确认：',
            warning: '如果你没有发起这次请求，请忽略这封邮件，你的密码不会被修改。',
            note: {
                title: '不是你本人操作？',
                text: '如果你没有发起这次密码修改请求，请忽略这封邮件，你的密码不会被修改。请勿将验证码转发给他人。',
                tone: 'warning'
            }
        }
    };

    const variant = variants[action] || variants['password-change'];

    return {
        subject: variant.subject,
        text: [
            `你好，${user}：`,
            '',
            variant.textIntro,
            '',
            code,
            '',
            `${TTL_MINUTES} 分钟内有效，仅可使用一次。请勿将验证码转发给他人。`,
            '',
            variant.warning,
            '',
            textFooter(name)
        ].join('\n'),
        html: layout({
            siteName: name,
            preheader: variant.preheader,
            eyebrow: variant.eyebrow,
            title: variant.title,
            content: [
                introHtml(variant.intro),
                spacer(22),
                codeCard(code),
                spacer(14),
                noteCard(variant.note)
            ].join('')
        })
    };
};

export const smtpTestEmail = ({ siteName, smtpHost, smtpPort, smtpSecure, sentAt = formatTime() }) => {
    const name = displaySiteName(siteName);
    const server = `${smtpHost || '-'}:${smtpPort || '-'}`;
    const secureLabel = smtpSecure ? '已开启' : '未开启';
    const intro = `你好，这是一封来自「${name}」的测试邮件。看到这封信，说明邮件服务器已经可以正常发送注册验证码和密码重置邮件。`;
    const note = {
        text: '你不需要进行任何操作。此邮件仅用于验证邮件服务器配置，不会影响账户安全。'
    };

    return {
        subject: `【${name}】SMTP 测试成功`,
        text: [
            '你好，',
            '',
            `这是一封来自「${name}」的 SMTP 测试邮件。`,
            '',
            '邮件服务器配置正常，可以发送注册验证码和密码重置邮件。',
            '',
            '测试信息：',
            `· SMTP 服务器：${server}`,
            `· SSL/TLS：${secureLabel}`,
            `· 发送时间：${sentAt}`,
            '',
            '你不需要进行任何操作。',
            '',
            textFooter(name)
        ].join('\n'),
        html: layout({
            siteName: name,
            preheader: 'SMTP 配置已通过测试，可以正常发送邮件。',
            eyebrow: 'SMTP 测试',
            title: '邮件服务连接正常',
            content: [
                introHtml(intro),
                spacer(22),
                successCard('配置测试通过', '服务器已成功发出这封测试邮件。'),
                infoTable([
                    { label: 'SMTP 服务器', value: server },
                    { label: 'SSL / TLS', value: secureLabel },
                    { label: '发送时间', value: sentAt }
                ]),
                spacer(14),
                noteCard(note)
            ].join('')
        })
    };
};
