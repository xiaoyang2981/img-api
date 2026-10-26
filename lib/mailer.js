import nodemailer from 'nodemailer';
import { getConfig } from '../config.js';

export const isMailConfigured = (config = getConfig()) =>
    Boolean(String(config.smtpHost || '').trim() && String(config.smtpFrom || config.smtpUser || '').trim());

export const sendMail = async ({ to, subject, text, html }) => {
    const config = getConfig();

    if (!isMailConfigured(config)) {
        throw new Error('SMTP 尚未配置，无法发送邮件');
    }

    const transport = nodemailer.createTransport({
        host: config.smtpHost,
        port: Number(config.smtpPort) || 587,
        secure: Boolean(config.smtpSecure),
        auth: config.smtpUser
            ? { user: config.smtpUser, pass: config.smtpPass }
            : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000
    });

    await transport.sendMail({
        from: config.smtpFrom || config.smtpUser,
        to,
        subject,
        text,
        html,
        headers: {
            'Auto-Submitted': 'auto-generated',
            'X-Auto-Response-Suppress': 'All'
        }
    });
};
