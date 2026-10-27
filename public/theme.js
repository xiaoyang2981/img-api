(() => {
    const KEY = 'imgapi_theme';
    const TOKEN_PREFIX = 'imgapi_api_token_';
    const root = document.documentElement;

    // 仅在当前浏览器保存接口 Token，用于复制带 Token 的 API 地址。
    // Token 仍然只以哈希形式保存在服务端；这里不参与登录鉴权。
    window.ImgApiToken = {
        key(userId) {
            return TOKEN_PREFIX + String(userId || '');
        },
        get(userId) {
            if (!userId) return '';
            try {
                return localStorage.getItem(this.key(userId)) || '';
            } catch {
                return '';
            }
        },
        set(userId, token) {
            if (!userId || !token) return;
            try {
                localStorage.setItem(this.key(userId), String(token));
            } catch {
                // 隐私模式或禁用 localStorage 时忽略
            }
        },
        clear(userId) {
            if (!userId) return;
            try {
                localStorage.removeItem(this.key(userId));
            } catch {
                // ignore
            }
        }
    };

    const stored = (() => {
        try { return localStorage.getItem(KEY); } catch { return null; }
    })();

    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    const initial = stored === 'light' || stored === 'dark' ? stored : (prefersLight ? 'light' : 'dark');
    root.dataset.theme = initial;

    const save = (theme) => {
        try { localStorage.setItem(KEY, theme); } catch { /* ignore */ }
    };

    const updateButtons = () => {
        const light = root.dataset.theme === 'light';
        document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
            button.textContent = light ? '🌙' : '☀️';
            button.title = light ? '切换到深色模式' : '切换到浅色模式';
            button.setAttribute('aria-label', button.title);
        });
    };

    const bind = () => {
        document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
            button.addEventListener('click', () => {
                root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
                save(root.dataset.theme);
                updateButtons();
                window.dispatchEvent(new CustomEvent('imgapi-theme-change', {
                    detail: { theme: root.dataset.theme }
                }));
            });
        });

        document.querySelectorAll('[data-year]').forEach((el) => {
            el.textContent = new Date().getFullYear();
        });

        updateButtons();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }
})();
