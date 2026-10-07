import { lazy, memo, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BrainCircuit, Cloud, Database, Info, Keyboard, Link2, Palette, RefreshCw, Rss, Type, UserRound, X, } from 'lucide-react';
import { ACCENTS } from '@shared/constants';
import { cn } from '../../lib/cn';
import { Tooltip, useDialogFocus, useEscape, useLockScroll } from '../../components/overlay';
import { Button, IconButton } from '../../components/primitives';
import { SettingsLoading } from './SettingsLoading';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { AppearanceSettings } from './AppearanceSettings';
import { useUi } from '../../store/ui';
import { useSession } from '../../store/session';
import { UI_STORAGE_KEY } from '../../lib/runtime';
import { scheduleSettingsWarmup, settingsLoaders, warmSettingsSection, type SettingsSection } from './sections';
import { t } from "../../lib/i18n";
type Section = SettingsSection;
const AppearancePage = memo(AppearanceSettings);
export const SECTIONS: {
    id: Section;
    label: () => string;
    icon: React.ReactNode;
}[] = [
    { id: 'appearance', label: () => t("settings.appearance"), icon: <Palette size={14}/> },
    { id: 'editor', label: () => t("settings.editor"), icon: <Type size={14}/> },
    { id: 'backup', label: () => t("settings.backup"), icon: <Cloud size={14}/> },
    { id: 'sync', label: () => t("settings.sync"), icon: <RefreshCw size={14}/> },
    { id: 'mcp', label: () => t("settings.mcp"), icon: <BrainCircuit size={14}/> },
    { id: 'account', label: () => t("settings.account"), icon: <UserRound size={14}/> },
    { id: 'data', label: () => t("settings.data"), icon: <Database size={14}/> },
    { id: 'shares', label: () => t("share.shared_notes"), icon: <Link2 size={14}/> },
    { id: 'blog', label: () => t("settings.blog"), icon: <Rss size={14}/> },
    { id: 'about', label: () => t("settings.about"), icon: <Info size={14}/> },
];
export function SettingsPanel({ onClose }: {
    onClose: () => void;
}) {
    const userId = useSession((s) => s.user?.id);
    const storageKey = `${UI_STORAGE_KEY}:settings-section:${userId ?? 'anonymous'}`;
    const [section, setSection] = useState<Section>(() => {
        try {
            const saved = localStorage.getItem(storageKey);
            return SECTIONS.find((item) => item.id === saved)?.id ?? 'appearance';
        } catch { return 'appearance'; }
    });
    const [visited, setVisited] = useState<Section[]>([section]);
    const selectSection = (next: Section) => {
        warmSettingsSection(next);
        setVisited((current) => current.includes(next) ? current : [...current, next]);
        setSection(next);
        try { localStorage.setItem(storageKey, next); } catch { }
    };
    const openPanel = useUi((s) => s.openPanel);
    const panelRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    useEscape(true, onClose);
    useLockScroll(true);
    useDialogFocus(true, panelRef);
    useEffect(() => scheduleSettingsWarmup(200), []);
    return createPortal(<div className="app-viewport-fixed fixed z-[210] flex items-center justify-center md:p-8">
      <div className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden="true"/>

      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="anim-pop relative flex h-full w-full max-w-[880px] flex-col overflow-hidden bg-[var(--bg-overlay)] pt-[env(safe-area-inset-top)] shadow-[var(--shadow-modal)] outline-none md:max-h-[720px] md:flex-row md:rounded-[var(--r-2xl)] md:border md:border-[var(--border-default)] md:pt-0">
        { }
        <nav className="flex w-full shrink-0 flex-col border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 md:w-[172px] md:border-r md:border-b-0">
          <div id={titleId} className="px-2 py-1.5 text-[13.5px] font-semibold tracking-[-0.012em] md:py-2.5">{t("common.settings")}</div>
          <div className="flex gap-1 overflow-x-auto pb-1 md:block md:space-y-px md:overflow-visible md:pb-0">
            {SECTIONS.map((item) => (<button key={item.id} type="button" aria-current={section === item.id ? 'page' : undefined} onPointerEnter={() => warmSettingsSection(item.id)} onFocus={() => warmSettingsSection(item.id)} onClick={() => selectSection(item.id)} className={cn('flex h-10 shrink-0 items-center gap-2 rounded-[var(--r-md)] px-2.5 text-left text-[12.5px] md:h-[30px] md:w-full md:gap-2.5 md:px-2', 'transition-colors duration-[var(--dur-fast)]', section === item.id
                ? 'bg-[var(--accent-soft)] font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
                <span className={cn('shrink-0', section === item.id ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
                  {item.icon}
                </span>
                {item.label()}
              </button>))}
            <button type="button" onClick={() => {
                onClose();
                openPanel('shortcuts');
            }} className="flex h-10 shrink-0 items-center gap-2.5 rounded-[var(--r-md)] px-2.5 text-left text-[12.5px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] md:hidden">
              <Keyboard size={14}/>{t("settings.keyboard_shortcuts")}
            </button>
          </div>

          <div className="flex-1"/>
          <button type="button" onClick={() => {
            onClose();
            openPanel('shortcuts');
        }} className="hidden h-[30px] w-full items-center gap-2.5 rounded-[var(--r-md)] px-2 text-left text-[12.5px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] md:flex">
            <Keyboard size={14}/>{t("settings.keyboard_shortcuts")}</button>
        </nav>

        { }
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4 md:px-5">
            <h2 className="text-[14px] font-semibold tracking-[-0.012em]">
              {SECTIONS.find((s) => s.id === section)?.label()}
            </h2>
            <Tooltip label={t("common.close")} combo="escape" side="left">
              <IconButton label={t("common.close")} size="sm" onClick={onClose}>
                <X size={15}/>
              </IconButton>
            </Tooltip>
          </header>

          {visited.map((page) => (<div key={page} hidden={page !== section} inert={page !== section} aria-hidden={page !== section} className={cn('min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-[calc(16px+env(safe-area-inset-bottom))] md:px-5 md:py-4', page !== section && 'hidden')}>
            {page === 'appearance' ? <AppearancePage accents={ACCENTS}/> : <SettingsPage section={page}/>}
          </div>))}
        </div>
      </div>
    </div>, document.body);
}

export const SettingsPage = memo(function SettingsPage({ section }: { section: Exclude<Section, 'appearance'> }) {
    const [attempt, setAttempt] = useState(0);
    const Page = useMemo(() => lazy(settingsLoaders[section]), [section, attempt]);
    return (<ErrorBoundary key={attempt} fallback={<div role="alert" className="space-y-3 py-4 text-[12.5px] text-[var(--text-secondary)]">
      <p>{t('app.section_unavailable')}</p>
      <Button size="sm" onClick={() => setAttempt((current) => current + 1)}>{t('common.retry')}</Button>
    </div>}>
      <Suspense fallback={<SettingsLoading />}><Page /></Suspense>
    </ErrorBoundary>);
});
