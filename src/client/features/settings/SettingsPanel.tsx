import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, Database, Info, Keyboard, Palette, RefreshCw, Sparkles, Type, UserRound, X, } from 'lucide-react';
import { ACCENTS } from '@shared/constants';
import { cn } from '../../lib/cn';
import { Tooltip, useDialogFocus, useEscape, useLockScroll } from '../../components/overlay';
import { IconButton } from '../../components/primitives';
import { LoadingBlock } from '../../components/feedback';
import { AppearanceSettings } from './AppearanceSettings';
import { EditorSettings } from './EditorSettings';
import { SyncSettings } from './SyncSettings';
import { DataSettings } from './DataSettings';
import { AccountSettings } from './AccountSettings';
import { AboutSettings } from './AboutSettings';
import { AiSettings } from './AiSettings';
import { useUi } from '../../store/ui';
import { t } from "../../lib/i18n";
const BackupSettings = lazy(() => import('./BackupSettings').then((m) => ({ default: m.BackupSettings })));
type Section = 'appearance' | 'editor' | 'backup' | 'sync' | 'account' | 'data' | 'ai' | 'about';
const SECTIONS: {
    id: Section;
    label: () => string;
    icon: React.ReactNode;
}[] = [
    { id: 'appearance', label: () => t("settings.appearance"), icon: <Palette size={14}/> },
    { id: 'editor', label: () => t("settings.editor"), icon: <Type size={14}/> },
    { id: 'backup', label: () => t("settings.backup"), icon: <Cloud size={14}/> },
    { id: 'sync', label: () => t("settings.sync"), icon: <RefreshCw size={14}/> },
    { id: 'ai', label: () => t("settings.ai"), icon: <Sparkles size={14}/> },
    { id: 'account', label: () => t("settings.account"), icon: <UserRound size={14}/> },
    { id: 'data', label: () => t("settings.data"), icon: <Database size={14}/> },
    { id: 'about', label: () => t("settings.about"), icon: <Info size={14}/> },
];
export function SettingsPanel({ onClose }: {
    onClose: () => void;
}) {
    const [section, setSection] = useState<Section>('appearance');
    const openPanel = useUi((s) => s.openPanel);
    const panelRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    useEscape(true, onClose);
    useLockScroll(true);
    useDialogFocus(true, panelRef);
    useEffect(() => {
        bodyRef.current?.scrollTo({ top: 0 });
    }, [section]);
    return createPortal(<div className="fixed inset-0 z-[210] flex items-center justify-center md:p-8">
      <div className="anim-fade absolute inset-0 bg-[var(--scrim)] backdrop-blur-[3px]" onClick={onClose} aria-hidden="true"/>

      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="anim-pop relative flex h-full w-full max-w-[880px] flex-col overflow-hidden bg-[var(--bg-overlay)] pt-[env(safe-area-inset-top)] shadow-[var(--shadow-modal)] outline-none md:max-h-[720px] md:flex-row md:rounded-[var(--r-2xl)] md:border md:border-[var(--border-default)] md:pt-0">
        { }
        <nav className="flex w-full shrink-0 flex-col border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 md:w-[172px] md:border-r md:border-b-0">
          <div id={titleId} className="px-2 py-1.5 text-[13.5px] font-semibold tracking-[-0.012em] md:py-2.5">{t("common.settings")}</div>
          <div className="flex gap-1 overflow-x-auto pb-1 md:block md:space-y-px md:overflow-visible md:pb-0">
            {SECTIONS.map((item) => (<button key={item.id} type="button" aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)} className={cn('flex h-10 shrink-0 items-center gap-2 rounded-[var(--r-md)] px-2.5 text-left text-[12.5px] md:h-[30px] md:w-full md:gap-2.5 md:px-2', 'transition-colors duration-[var(--dur-fast)]', section === item.id
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

          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-[calc(16px+env(safe-area-inset-bottom))] md:px-5 md:py-4">
            {section === 'appearance' && <AppearanceSettings accents={ACCENTS}/>}
            {section === 'editor' && <EditorSettings />}
            {section === 'sync' && <SyncSettings />}
            {section === 'account' && <AccountSettings />}
            {section === 'data' && <DataSettings />}
            {section === 'ai' && <AiSettings />}
            {section === 'about' && <AboutSettings />}
            {section === 'backup' && (<Suspense fallback={<LoadingBlock label={t("settings.loading_backup_settings")}/>}>
                <BackupSettings />
              </Suspense>)}
          </div>
        </div>
      </div>
    </div>, document.body);
}