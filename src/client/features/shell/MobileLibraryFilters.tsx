import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ChevronDown, Clock, FileText, FolderClosed, Hash, Inbox, Star, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { useDialogFocus, useEscape, useLockScroll } from '../../components/overlay';
import { IconButton } from '../../components/primitives';
import { useUi } from '../../store/ui';
import { useNavigationCounts, useNotes } from '../../store/notes';
import { FolderSection, TagSection } from '../sidebar/Sidebar';

export function MobileLibraryFilters() {
    const [open, setOpen] = useState<'menu' | 'tag' | 'folder' | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const dragStart = useRef<number | null>(null);
    const id = useId();
    const view = useUi((s) => s.view);
    const tag = useUi((s) => s.tag);
    const folderId = useUi((s) => s.folderId);
    const folders = useNotes((s) => s.folders);
    const counts = useNavigationCounts();
    const openView = useUi((s) => s.openView);
    const mobilePane = useUi((s) => s.mobilePane);
    const close = () => setOpen(null);
    useEscape(Boolean(open), close);
    useLockScroll(Boolean(open));
    useDialogFocus(Boolean(open), panelRef, panelRef);
    useEffect(() => { if (mobilePane !== 'list') setOpen(null); }, [mobilePane]);
    const items = [
        { view: 'all' as const, label: t('navigation.all_notes'), icon: FileText, count: counts.all },
        { view: 'recent' as const, label: t('navigation.recently_edited'), icon: Clock },
        { view: 'starred' as const, label: t('navigation.favorites'), icon: Star, count: counts.starred },
        { view: 'unfiled' as const, label: t('navigation.unfiled'), icon: Inbox, count: counts.unfiled },
        { view: 'archived' as const, label: t('navigation.archive'), icon: Archive, count: counts.archived },
        { view: 'trash' as const, label: t('navigation.trash'), icon: Trash2, count: counts.trash },
    ];
    const controls = [
        { id: 'menu' as const, icon: FileText, label: items.find((item) => item.view === view)?.label ?? t('navigation.note_views'), active: view !== 'tag' && view !== 'folder' },
        { id: 'tag' as const, icon: Hash, label: view === 'tag' ? tag : t('navigation.tag'), active: view === 'tag' },
        { id: 'folder' as const, icon: FolderClosed, label: view === 'folder' ? folders.find((folder) => folder.id === folderId)?.name : t('navigation.folder'), active: view === 'folder' },
    ];
    return <div className="mobile-library-filters relative mt-2">
        <div className="grid grid-cols-3 gap-1">
            {controls.map(({ id: key, icon: Icon, label, active }) => <button key={key} type="button" aria-haspopup="dialog" aria-expanded={open === key} aria-controls={open === key ? id : undefined} onClick={() => {
                setOpen(open === key ? null : key);
            }} className={cn('flex min-h-11 min-w-0 items-center gap-1.5 rounded-[var(--r-md)] px-2 text-[12px] transition-colors active:bg-[var(--bg-active)]', open === key ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : active ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]')}>
                <Icon size={14} aria-hidden="true" className="shrink-0"/><span className="min-w-0 flex-1 truncate text-left">{label}</span><ChevronDown size={12} aria-hidden="true" className="shrink-0"/>
            </button>)}
        </div>
        {open && createPortal(<div className="app-viewport-fixed fixed z-[240] flex items-end">
          <div aria-hidden="true" className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={close}/>
          <div ref={panelRef} id={id} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} className="mobile-library-sheet anim-pop relative flex max-h-[85dvh] w-full flex-col rounded-t-[var(--r-2xl)] border border-b-0 border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-modal)] outline-none">
            <button type="button" aria-label={t('common.close')} className="flex h-7 w-full shrink-0 touch-none items-center justify-center" onClick={close} onPointerDown={(event) => {
                dragStart.current = event.clientY;
                event.currentTarget.setPointerCapture(event.pointerId);
            }} onPointerUp={(event) => {
                if (dragStart.current !== null && event.clientY - dragStart.current > 60) close();
                dragStart.current = null;
            }} onPointerCancel={() => { dragStart.current = null; }}><span className="h-1 w-8 rounded-full bg-[var(--border-strong)]"/></button>
            <div className="flex shrink-0 items-center justify-between px-4 pb-2">
                <h2 id={`${id}-title`} className="text-[15px] font-semibold">{open === 'menu' ? t('navigation.note_views') : open === 'folder' ? t('navigation.folder') : t('navigation.tag')}</h2>
                <IconButton label={t('common.close')} onClick={close}><X size={16}/></IconButton>
            </div>
            <div className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-[calc(16px+env(safe-area-inset-bottom))]" onClick={(event) => {
            if ((event.target as HTMLElement).closest('[data-navigation-item]')) close();
        }}>
            {open === 'menu' ? items.map(({ view: key, label, icon: Icon, count }) => <button key={key} type="button" aria-current={view === key ? 'page' : undefined} onClick={() => { openView(key); close(); }} className={cn('flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] active:bg-[var(--bg-active)]', key === 'archived' && 'mt-3 border-t border-[var(--border-subtle)]', view === key && 'bg-[var(--accent-soft)] text-[var(--accent)]')}>
                <Icon size={16} aria-hidden="true"/><span className="flex-1">{label}</span><span className="text-[var(--text-tertiary)]">{count}</span>
            </button>) : open === 'folder' ? <FolderSection mobile/> : <TagSection mobile/>}
            </div>
          </div>
        </div>, document.body)}
    </div>;
}
