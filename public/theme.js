(() => {
    const KEY = 'imgapi_theme';
    const root = document.documentElement;

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
