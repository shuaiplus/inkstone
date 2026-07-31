/** Provides typed runtime localization with complete English and Simplified Chinese resources. */
import { useSyncExternalStore } from 'react';
import type { AppLocale } from '@shared/types';
import { EN_US_MESSAGES, type MessageKey } from '@shared/locales/en-US';
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN';
import { LOCALE_STORAGE_KEY } from './runtime';
type Params = Record<string, string | number | boolean | null | undefined>;
const STORAGE_KEY = LOCALE_STORAGE_KEY;
const listeners = new Set<() => void>();
const messages: Record<AppLocale, Record<MessageKey, string>> = {
    'en-US': EN_US_MESSAGES,
    'zh-CN': ZH_CN_MESSAGES,
};
const apiCodeMessages: Record<string, MessageKey> = {
    unauthenticated: 'api.error.unauthenticated',
    forbidden: 'api.error.forbidden',
    not_found: 'api.error.not_found',
    conflict: 'api.error.conflict',
    bad_request: 'api.error.bad_request',
    payload_too_large: 'api.error.payload_too_large',
    storage_unavailable: 'api.error.storage_unavailable',
    internal: 'api.error.internal',
    invalid_username: 'api.error.invalid_username',
    invalid_profile_name: 'api.error.invalid_profile_name',
    invalid_avatar: 'api.error.invalid_avatar',
    weak_password: 'api.error.weak_password',
    username_taken: 'api.error.username_taken',
    invalid_credentials: 'api.error.invalid_credentials',
    wrong_password: 'api.error.wrong_password',
    too_many_attempts: 'api.error.too_many_attempts',
    registration_closed: 'api.error.registration_closed',
    server_misconfigured: 'api.error.server_misconfigured',
    invalid_response: 'api.error.invalid_response',
};
const englishMessageKeys = new Map<string, MessageKey>(Object.entries(EN_US_MESSAGES).map(([key, value]) => [value, key as MessageKey]));
let locale: AppLocale = detectInitialLocale();
export { EN_US_MESSAGES, ZH_CN_MESSAGES };
export type { MessageKey };
export function t(key: MessageKey, params?: Params): string {
    const template = messages[locale][key] ?? EN_US_MESSAGES[key] ?? key;
    if (!params)
        return template;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
        const value = params[name];
        return value == null ? whole : String(value);
    });
}
export function translateApiError(code: string, fallback: string): string {
    const key = apiCodeMessages[code];
    if (key) {
        // server_misconfigured and invalid_response carry concrete failure reasons (e.g.
        // "Image generation failed (HTTP 400): ..."). translateServiceMessage's fallback
        // misclassifies any "HTTP xxx" message as a storage service error, so return the
        // fallback as-is to preserve the accurate diagnostic information.
        if ((code === 'server_misconfigured' || code === 'invalid_response') && fallback)
            return fallback;
        return t(key);
    }
    return fallback ? translateServiceMessage(fallback) : t('api.error.unknown');
}
export function translateServiceMessage(message: string | null | undefined): string {
    if (!message || locale === 'en-US')
        return message ?? '';
    const exactKey = englishMessageKeys.get(message);
    if (exactKey)
        return t(exactKey);
    let match = /^Write succeeded but read failed:\s*(.+)$/i.exec(message);
    if (match)
        return t('backup.service.read_failed', { details: match[1] });
    match = /^Server returned HTTP\s+(\d{3})$/i.exec(message);
    if (match)
        return t('backup.service.http_error', { status: match[1] });
    match = /^Write test failed:\s*HTTP\s+(\d{3})$/i.exec(message);
    if (match)
        return t('backup.service.write_test_failed', { status: match[1] });
    match = /^Creating folder\s+(.+?)\s+failed:\s*HTTP\s+(\d{3})$/i.exec(message);
    if (match)
        return t('backup.service.create_folder_failed', { path: match[1], status: match[2] });
    match = /^Path not found:\s*(.+)$/i.exec(message);
    if (match)
        return t('backup.service.path_not_found', { path: match[1] });
    match = /^Upload\s+(.+?)\s+failed:\s*HTTP\s+(\d{3})$/i.exec(message);
    if (match)
        return t('backup.service.upload_failed', { path: match[1], status: match[2] });
    match = /^Read and write succeeded, but the test file could not be removed:\s*HTTP\s+(\d{3})$/i.exec(message);
    if (match)
        return t('backup.service.cleanup_failed', { status: match[1] });
    const http = /HTTP\s+\d{3}/i.exec(message)?.[0];
    return `${t('backup.error.storage_service')}${http ? ` (${http})` : ''}`;
}
export function getLocale(): AppLocale {
    return locale;
}
export function setLocale(next: AppLocale, persist = true): void {
    if (next !== 'zh-CN' && next !== 'en-US')
        return;
    const changed = locale !== next;
    locale = next;
    if (persist) {
        try {
            localStorage.setItem(STORAGE_KEY, next);
        }
        catch { }
    }
    applyLocaleToDom();
    if (changed)
        listeners.forEach((listener) => listener());
}
export function subscribeLocale(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
export function useLocale(): AppLocale {
    return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
export function localeTag(): string {
    return locale;
}
function detectInitialLocale(): AppLocale {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'zh-CN' || saved === 'en-US')
            return saved;
    }
    catch { }
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}
function applyLocaleToDom(): void {
    document.documentElement.lang = locale;
    document.title = t('app.document_title');
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description)
        description.content = t('app.meta_description');
    const bootLabel = document.querySelector<HTMLElement>('#boot [data-boot-label]');
    if (bootLabel)
        bootLabel.textContent = t('app.boot_label');
}
applyLocaleToDom();