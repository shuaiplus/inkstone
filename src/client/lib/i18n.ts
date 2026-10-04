/** Provides typed runtime localization with on-demand locale loading. */
import { useSyncExternalStore } from 'react';
import type { AppLocale } from '@shared/types';
import type { MessageKey } from '@shared/locales/en-US';
import { LOCALE_STORAGE_KEY } from './runtime';
type Params = Record<string, string | number | boolean | null | undefined>;
const STORAGE_KEY = LOCALE_STORAGE_KEY;
const listeners = new Set<() => void>();
const messages: Record<AppLocale, Record<string, string>> = {
    'en-US': {},
    'zh-CN': {},
};
let enMessagesCache: Record<string, string> | null = null;
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
    invalid_two_factor_code: 'api.error.invalid_two_factor_code',
    wrong_password: 'api.error.wrong_password',
    too_many_attempts: 'api.error.too_many_attempts',
    registration_closed: 'api.error.registration_closed',
    server_misconfigured: 'api.error.server_misconfigured',
    two_factor_already_enabled: 'api.error.two_factor_already_enabled',
    two_factor_challenge_expired: 'api.error.two_factor_challenge_expired',
    two_factor_not_enabled: 'api.error.two_factor_not_enabled',
    two_factor_setup_expired: 'api.error.two_factor_setup_expired',
    two_factor_unavailable: 'api.error.two_factor_unavailable',
};
let englishMessageKeys = new Map<string, MessageKey>();
let locale: AppLocale = detectInitialLocale();
let initPromise: Promise<void> | null = null;
const localeLoaders: Record<AppLocale, () => Promise<Record<string, string>>> = {
    'en-US': () => import('@shared/locales/en-US').then((m) => m.EN_US_MESSAGES as unknown as Record<string, string>),
    'zh-CN': () => import('@shared/locales/zh-CN').then((m) => m.ZH_CN_MESSAGES as unknown as Record<string, string>),
};
const loadedLocales = new Set<AppLocale>();
async function ensureLocaleLoaded(target: AppLocale): Promise<void> {
    if (loadedLocales.has(target)) return;
    const data = await localeLoaders[target]();
    messages[target] = data;
    loadedLocales.add(target);
    if (target === 'en-US') {
        enMessagesCache = data;
        englishMessageKeys = new Map(Object.entries(data).map(([key, value]) => [value as string, key as MessageKey]));
    }
}
export async function initI18n(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        await ensureLocaleLoaded('en-US');
        if (locale !== 'en-US') await ensureLocaleLoaded(locale);
        // Preload the other locale in background for instant switching, but don't block init
        const other: AppLocale = locale === 'en-US' ? 'zh-CN' : 'en-US';
        if (!loadedLocales.has(other)) void ensureLocaleLoaded(other);
        applyLocaleToDom();
    })();
    return initPromise;
}
export type { MessageKey };
export function t(key: MessageKey, params?: Params): string {
    const template = messages[locale][key] ?? enMessagesCache?.[key] ?? key;
    if (!params)
        return template;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
        const value = params[name];
        return value == null ? whole : String(value);
    });
}
export function translateApiError(code: string, fallback: string): string {
    const key = apiCodeMessages[code];
    if (key)
        return t(key);
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
    if (message === 'Old backup cleanup will continue after the next successful backup') return t('backup.service.cleanup_pending');
    const http = /HTTP\s+\d{3}/i.exec(message)?.[0];
    return `${t('backup.error.storage_service')}${http ? ` (${http})` : ''}`;
}
export function getLocale(): AppLocale {
    return locale;
}
export function setLocale(next: AppLocale, persist = true): void {
    if (next !== 'zh-CN' && next !== 'en-US')
        return;
    locale = next;
    if (persist) {
        try {
            localStorage.setItem(STORAGE_KEY, next);
        }
        catch { }
    }
    if (loadedLocales.has(next)) {
        applyLocaleToDom();
        listeners.forEach((listener) => listener());
        return;
    }
    void ensureLocaleLoaded(next).then(() => {
        applyLocaleToDom();
        listeners.forEach((listener) => listener());
    });
}
export async function setLocaleAsync(next: AppLocale, persist = true): Promise<void> {
    setLocale(next, persist);
    if (!loadedLocales.has(next)) await ensureLocaleLoaded(next);
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
