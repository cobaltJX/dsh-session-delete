/**
 * Browser half of the session-delete bundle.
 *
 * Contributes one context-menu action to every conversation row and owns the
 * confirmation dialog it opens. Both halves are plain JavaScript so the module
 * needs no build step; React and the slot/context-menu services come from the
 * page's module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'sessionDelete';

    const en = {
      'menu.delete': 'Delete conversation',
      'dialog.title': 'Delete this conversation?',
      'dialog.body':
        'This permanently deletes “{title}” and every message in it. The conversation disappears from the sidebar and its local history is removed. This cannot be undone.',
      'dialog.untitled': 'Untitled conversation',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.deleting': 'Deleting…',
      'toast.deleted': 'Conversation deleted',
      'errors.notFound': 'This conversation no longer exists.',
      'errors.unauthorized': 'The page is not authorized. Reopen the URL Harness printed, then try again.',
      'errors.generic': 'The conversation could not be deleted. Nothing was removed.',
    };

    const zh = {
      'menu.delete': '删除对话',
      'dialog.title': '删除这个对话？',
      'dialog.body':
        '将永久删除“{title}”及其中的全部消息。该对话会从侧边栏消失，本机上的历史记录也会被移除。此操作无法撤销。',
      'dialog.untitled': '未命名对话',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.deleting': '正在删除…',
      'toast.deleted': '对话已删除',
      'errors.notFound': '该对话已不存在。',
      'errors.unauthorized': '页面未获得授权。请重新打开 Harness 启动时打印的网址后再试。',
      'errors.generic': '删除失败，未做任何更改。',
    };

    /* ------------------------------------------------------------------ *
     * Pending-deletion store: the menu action opens the dialog, and the
     * overlay slot (a different component tree) renders it.
     * ------------------------------------------------------------------ */
    let pending = null;
    const listeners = new Set();

    function setPending(next) {
      pending = next;
      for (const listener of listeners) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function readPending() {
      return pending;
    }

    function usePending() {
      return React.useSyncExternalStore(subscribe, readPending, readPending);
    }

    /* ------------------------------------------------------------------ *
     * Host call
     * ------------------------------------------------------------------ */

    /** Resolve a route against the page's own mount point. */
    function apiUrl(path) {
      if (typeof document === 'undefined') return path;
      return new URL(path.replace(/^\/+/, ''), document.baseURI).pathname;
    }

    /**
     * Ask the Host to delete one conversation.
     * @param sessionId - the chosen conversation.
     * @returns the Host result.
     */
    async function removeSession(sessionId) {
      const response = await fetch(apiUrl('/session-delete'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sessionId }),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (response.ok !== true || payload?.ok !== true) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
        error.code = payload?.error?.code;
        throw error;
      }
      return payload;
    }

    /* ------------------------------------------------------------------ *
     * Styles (theme tokens only; no literal colours for UI chrome)
     * ------------------------------------------------------------------ */
    const styles = `
.dsd-layer { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center; font-family: inherit; pointer-events: auto; }
.dsd-mask { position: absolute; inset: 0; background: color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent); backdrop-filter: blur(1px); }
.dsd-panel { position: relative; width: min(420px, calc(100vw - 32px)); box-sizing: border-box; padding: 20px 20px 16px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 16px 48px color-mix(in srgb, var(--dsw-alias-bg-base) 30%, transparent); outline: none; }
.dsd-title { margin: 0 0 8px; font-size: 15px; font-weight: 600; line-height: 1.4; }
.dsd-body { margin: 0; font-size: 13px; line-height: 1.65; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsd-error { margin: 10px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.dsd-detail { margin: 4px 0 0; font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-secondary); opacity: 0.75; overflow-wrap: anywhere; }
.dsd-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.dsd-button { height: 30px; padding: 0 14px; border-radius: 8px; font: inherit; font-size: 13px; line-height: 1; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease; }
.dsd-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsd-button:disabled { cursor: default; opacity: 0.6; }
.dsd-cancel { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); }
.dsd-cancel:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsd-confirm { border: 1px solid transparent; background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-base); font-weight: 500; }
.dsd-confirm:hover:not(:disabled) { border-color: var(--dsw-alias-state-error-primary); opacity: 0.88; }
`;

    /* ------------------------------------------------------------------ *
     * Icons
     * ------------------------------------------------------------------ */
    function TrashIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M5.5 1.5h5a1 1 0 0 1 1 1V3H14v1.5h-1l-.6 8.6a1.5 1.5 0 0 1-1.5 1.4H5.1a1.5 1.5 0 0 1-1.5-1.4L3 4.5H2V3h2.5v-.5a1 1 0 0 1 1-1Zm.75 1.5h3.5v-.5h-3.5V3ZM4.5 4.5l.58 8.4h5.84l.58-8.4H4.5Z',
          fill: 'currentColor',
        }),
      );
    }

    /**
     * Localized copy for one failed deletion.
     * @param error - the thrown failure.
     * @param t - the plugin's translator.
     * @returns user-facing text.
     */
    function errorText(error, t) {
      if (error?.code === 'SESSION_NOT_FOUND') return t('errors.notFound');
      if (error?.code === 'UNAUTHORIZED') return t('errors.unauthorized');
      return t('errors.generic');
    }

    /* ------------------------------------------------------------------ *
     * Confirmation dialog
     * ------------------------------------------------------------------ */
    function DeleteSessionDialog({ t, remove, notify }) {
      const current = usePending();
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const busyRef = React.useRef(false);
      const cancelRef = React.useRef(null);
      const sessionKey = current === null ? null : current.sessionId;

      busyRef.current = busy;

      React.useEffect(() => {
        if (sessionKey === null) return undefined;
        setBusy(false);
        setFailure(null);
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && busyRef.current !== true) setPending(null);
        };
        const previous = document.activeElement;
        document.addEventListener('keydown', onKeyDown, true);
        const timer = setTimeout(() => {
          if (cancelRef.current !== null) cancelRef.current.focus();
        }, 0);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          clearTimeout(timer);
          if (previous instanceof HTMLElement) previous.focus();
        };
      }, [sessionKey]);

      if (current === null) return null;

      const title = typeof current.title === 'string' && current.title.trim() !== ''
        ? current.title
        : t('dialog.untitled');

      const close = () => {
        if (busyRef.current === true) return;
        setPending(null);
      };

      const confirm = async () => {
        if (busyRef.current === true) return;
        setBusy(true);
        setFailure(null);
        try {
          const result = await remove(current.sessionId);
          setPending(null);
          notify(t('toast.deleted'), true);
          return result;
        } catch (error) {
          setFailure(error);
          notify(errorText(error, t), false);
          return undefined;
        } finally {
          setBusy(false);
        }
      };

      const failureText = failure === null ? null : errorText(failure, t);

      return h(
        React.Fragment,
        null,
        h('style', { key: 'session-delete-styles' }, styles),
        h(
          'div',
          { className: 'dsd-layer', role: 'presentation' },
          h('div', { className: 'dsd-mask', 'aria-hidden': 'true', onClick: close }),
          h(
            'div',
            {
              className: 'dsd-panel',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': 'session-delete-title',
              'aria-describedby': 'session-delete-body',
              tabIndex: -1,
            },
            h('h2', { className: 'dsd-title', id: 'session-delete-title' }, t('dialog.title')),
            h('p', { className: 'dsd-body', id: 'session-delete-body' }, t('dialog.body', { title })),
            failureText === null ? null : h('p', { className: 'dsd-error', role: 'alert' }, failureText),
            failureText === null || failure?.message === undefined
              ? null
              : h('p', { className: 'dsd-detail' }, String(failure.message)),
            h(
              'div',
              { className: 'dsd-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsd-button dsd-cancel',
                  ref: cancelRef,
                  disabled: busy,
                  onClick: close,
                },
                t('dialog.cancel'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsd-button dsd-confirm',
                  disabled: busy,
                  onClick: confirm,
                },
                busy ? t('dialog.deleting') : t('dialog.confirm'),
              ),
            ),
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'locale', 'contextMenus'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-delete: dictionaries');
        const t = ctx.locale.bind(NS);
        const notify = (text) => {
          ctx.contextMenus.notify(text, true);
        };

        // One action on every conversation row: right-click and the row's …
        // menu both dispatch the same session target.
        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: 'sessionDelete.delete',
              target: 'session',
              order: 700,
              resolve: ({ sessionId, displayTitle }) => [
                {
                  id: 'delete',
                  label: t('menu.delete'),
                  icon: { key: 'sessionDelete.trash' },
                  afterContent: true,
                  run: () => setPending({ sessionId, title: displayTitle }),
                },
              ],
            }),
          'session-delete: conversation menu',
        );

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'session-delete.dialog',
              order: 900,
              locale: NS,
              inject: () => ({ remove: removeSession, notify }),
            },
            DeleteSessionDialog,
          ),
        );

        ctx.slots.inject('contextMenu.icon', () =>
          ctx.slots.register(
            { name: 'contextMenu.icon', key: 'sessionDelete.trash' },
            TrashIcon,
          ),
        );
      },
    };
  },
});
