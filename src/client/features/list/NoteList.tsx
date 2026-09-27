import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowDownWideNarrow, CheckSquare2, Columns2, Copy, FileCode, FileDown, FileText, FolderInput, Link2, MoreHorizontal, Pin, PinOff, PanelLeft, Plus, RotateCcw, Search, Star, StarOff, Trash2, X, } from 'lucide-react';
import type { NoteSummary, SortKey, ViewKind } from '@shared/types';
import { cn } from '../../lib/cn';
import { groupLabel } from '../../lib/time';
import { useNow } from '../../lib/hooks';
import { fuzzyFilter, splitByRanges } from '../../lib/fuzzy';
import { useBreakpoint } from '../../lib/hooks';
import { prettyCombo } from '../../lib/hotkeys';
import { exportNoteAsHtml, exportNoteAsMarkdown, exportNoteAsPdf } from '../../lib/export-note';
import { IconButton, Logo } from '../../components/primitives';
import { Menu, Tooltip, confirm, useContextMenu, type MenuItem } from '../../components/overlay';
import { Empty, NoteListSkeleton } from '../../components/feedback';
import { useUi } from '../../store/ui';
import { createContextualNote, useNotes, useVisibleNotes } from '../../store/notes';
import { folderPathLabel } from '../../lib/folders';
import { FolderPicker } from '../folders/FolderPicker';
import { t, useLocale, type MessageKey } from "../../lib/i18n";
import { MobileLibraryFilters } from '../shell/MobileLibraryFilters';
const VIEW_MESSAGE_KEYS: Record<ViewKind, MessageKey> = {
    all: 'navigation.all_notes',
    recent: 'navigation.recently_edited',
    starred: 'navigation.favorites',
    unfiled: 'navigation.unfiled',
    archived: 'navigation.archive',
    trash: 'navigation.trash',
    folder: 'navigation.folder',
    tag: 'navigation.tag',
};
const EMPTY_HIGHLIGHT: [
    number,
    number
][] = [];
const INITIAL_RENDERED_NOTES = 180;
const RENDERED_NOTES_STEP = 240;
export function NoteList() {
    const locale = useLocale();
    const breakpoint = useBreakpoint();
    const view = useUi((s) => s.view);
    const folderId = useUi((s) => s.folderId);
    const tag = useUi((s) => s.tag);
    const sort = useUi((s) => s.sort);
    const order = useUi((s) => s.order);
    const density = useUi((s) => s.density);
    const setSort = useUi((s) => s.setSort);
    const activeNoteId = useUi((s) => s.activeNoteId);
    const toggleNavDrawer = useUi((s) => s.toggleNavDrawer);
    const notes = useVisibleNotes();
    const folders = useNotes((s) => s.folders);
    const tags = useNotes((s) => s.tags);
    const loading = useNotes((s) => s.loading);
    const hydrated = useNotes((s) => s.hydrated);
    const openNote = useNotes((s) => s.openNote);
    const { emptyTrash, emptyingTrash } = useEmptyTrash();
    const [filter, setFilter] = useState('');
    const deferredFilter = useDeferredValue(breakpoint === 'mobile' ? filter : '');
    const [sortMenuOpen, setSortMenuOpen] = useState(false);
    const sortButtonRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const loadMoreRef = useRef<HTMLDivElement>(null);
    const [renderLimit, setRenderLimit] = useState(INITIAL_RENDERED_NOTES);
    const now = useNow();
    const tagColors = useMemo(() => new Map((tags ?? []).map((item) => [item.name, item.color])), [tags]);

    useEffect(() => setFilter(''), [view, folderId, tag, breakpoint]);
    const title = useMemo(() => {
        if (view === 'folder')
            return (folderId ? folderPathLabel(folders, folderId) : '') || t("navigation.folder");
        if (view === 'tag')
            return `#${tag ?? ''}`;
        return t(VIEW_MESSAGE_KEYS[view]);
    }, [view, folderId, tag, folders, locale]);
    const filtered = useMemo(() => {
        if (!deferredFilter.trim())
            return notes.map((note) => ({ note, ranges: EMPTY_HIGHLIGHT }));
        return fuzzyFilter(notes, deferredFilter, (n) => `${n.title} ${n.excerpt}`, 200).map(({ item, match }) => ({
            note: item,
            ranges: match.ranges.filter(([s]) => s < item.title.length),
        }));
    }, [notes, deferredFilter]);
    const filteredIds = useMemo(() => filtered.map((item) => item.note.id), [filtered]);
    const filteredPositions = useMemo(() => new Map(filteredIds.map((id, index) => [id, index + 1])), [filteredIds]);
    const filteredIdsRef = useRef(filteredIds);
    filteredIdsRef.current = filteredIds;
    const rendered = useMemo(() => filtered.slice(0, renderLimit), [filtered, renderLimit]);
    const renderedIds = useMemo(() => new Set(rendered.map((item) => item.note.id)), [rendered]);
    const groups = useMemo(() => groupNotes(rendered, sort, view === 'trash', now), [rendered, sort, view, locale, now]);
    useEffect(() => {
        setRenderLimit(INITIAL_RENDERED_NOTES);
        listRef.current?.scrollTo?.({ top: 0 });
    }, [view, folderId, tag, deferredFilter, sort, order, density]);
    useEffect(() => {
        if (!activeNoteId)
            return;
        const activeIndex = filteredIds.indexOf(activeNoteId);
        if (activeIndex < 0 || activeIndex < renderLimit)
            return;
        setRenderLimit(Math.min(filtered.length, Math.ceil((activeIndex + 1) / RENDERED_NOTES_STEP) * RENDERED_NOTES_STEP));
    }, [activeNoteId, filteredIds, filtered.length, renderLimit]);
    useEffect(() => {
        const root = listRef.current;
        const target = loadMoreRef.current;
        if (!root || !target || renderLimit >= filtered.length)
            return;
        if (typeof IntersectionObserver === 'undefined') {
            setRenderLimit(filtered.length);
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting))
                return;
            setRenderLimit((current) => Math.min(filtered.length, current + RENDERED_NOTES_STEP));
        }, { root, rootMargin: '600px 0px' });
        observer.observe(target);
        return () => observer.disconnect();
    }, [filtered.length, renderLimit]);
    useEffect(() => {
        if (!activeNoteId)
            return;
        listRef.current
            ?.querySelector<HTMLElement>(`[data-note-id="${activeNoteId}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [activeNoteId, renderLimit, view, folderId, tag]);
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === 'Escape') {
            useUi.getState().setSelected(activeNoteId ? [activeNoteId] : []);
            return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
            return;
        event.preventDefault();
        const index = filteredIds.indexOf(activeNoteId ?? '');
        const next = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? filteredIds.length - 1
                : event.key === 'ArrowDown'
                    ? index + 1
                    : index - 1;
        const target = filteredIds[Math.max(0, Math.min(filteredIds.length - 1, next))];
        if (target)
            void openNote(target);
    };
    const selectRange = useCallback((targetId: string) => {
        const ids = filteredIdsRef.current;
        const ui = useUi.getState();
        const anchor = ui.selectedIds[0] ?? ui.activeNoteId;
        const from = ids.indexOf(anchor ?? '');
        const to = ids.indexOf(targetId);
        if (from < 0 || to < 0) {
            ui.setSelected([targetId]);
            return;
        }
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        ui.setSelected(ids.slice(lo, hi + 1));
    }, []);
    const sortItems: MenuItem[] = view === 'recent' || view === 'trash' ? [
        {
            id: 'fixed-order',
            label: view === 'trash' ? t("notes.recently_deleted_first") : t("notes.recently_edited_first"),
            checked: true,
            disabled: true,
        },
        {
            id: 'density',
            label: density === 'comfortable' ? t("notes.compact_list") : t("notes.comfortable_list"),
            separatorBefore: true,
            onSelect: () => useUi.getState().setDensity(density === 'comfortable' ? 'compact' : 'comfortable'),
        },
    ] : [
        { id: 'updated', label: t("notes.modified"), checked: sort === 'updated', onSelect: () => setSort('updated') },
        { id: 'created', label: t("notes.created"), checked: sort === 'created', onSelect: () => setSort('created') },
        { id: 'title', label: t("notes.title"), checked: sort === 'title', onSelect: () => setSort('title', 'asc') },
        {
            id: 'order',
            label: order === 'desc' ? t("notes.sort_ascending") : t("notes.sort_descending"),
            separatorBefore: true,
            onSelect: () => setSort(sort, order === 'desc' ? 'asc' : 'desc'),
        },
        {
            id: 'density',
            label: density === 'comfortable' ? t("notes.compact_list") : t("notes.comfortable_list"),
            onSelect: () => useUi.getState().setDensity(density === 'comfortable' ? 'compact' : 'comfortable'),
        },
    ];
    return (<section className={cn('relative flex h-full min-h-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-base)]', breakpoint === 'mobile' && 'mobile-note-list')}>
      <header className="shrink-0 px-3 pt-3 pb-2">
        {breakpoint === 'mobile' && <div className="mobile-library-brand"><Logo size={22}/><span>{t('common.product_name')}</span></div>}
        {breakpoint !== 'mobile' && <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-[14.5px] font-semibold tracking-[-0.016em] text-[var(--text-primary)]">{title}</h2>
            {view === 'folder' && <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-quaternary)]">{t("folders.includes_subfolders")}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {breakpoint === 'tablet' && (<Tooltip label={t("notes.open_navigation")}>
                <IconButton label={t("notes.open_navigation")} size="sm" onClick={() => toggleNavDrawer(true)}>
                  <PanelLeft size={14}/>
                </IconButton>
              </Tooltip>)}
            <Tooltip label={t("notes.sort_and_display")}>
              <IconButton label={t("notes.sort_and_display")} size="sm" ref={sortButtonRef} onClick={() => setSortMenuOpen(true)}>
                <ArrowDownWideNarrow size={14}/>
              </IconButton>
            </Tooltip>
            {view !== 'trash' && view !== 'archived' && (<Tooltip label={t("common.new_note")} combo="mod+n">
                <IconButton label={t("common.new_note")} size="sm" onClick={() => void createContextualNote()}>
                  <Plus size={15}/>
                </IconButton>
              </Tooltip>)}
          </div>
        </div>}

        {breakpoint === 'mobile' && <div className="mobile-library-toolbar">
          <div className="relative mobile-note-search">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-quaternary)]"/>
            <input aria-label={t("notes.filter_in_this_view")} value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => {
              if (e.key === 'Escape')
                  setFilter('');
              if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  const first = filtered[0]?.note.id;
                  if (first)
                      void openNote(first);
                  listRef.current?.focus();
              }
          }} placeholder={t("notes.filter_in_this_view")} className={cn('h-10 w-full rounded-[var(--r-md)] border border-transparent bg-[var(--bg-inset)] md:h-[30px]', 'pr-9 pl-8 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] md:pr-7 md:pl-7', 'transition-[border-color,box-shadow] duration-[var(--dur-fast)]', 'focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none')}/>
            {filter && (<Tooltip label={t("notes.clear_filters")} side="left">
                <button type="button" onClick={() => setFilter('')} aria-label={t("notes.clear_filters")} className="absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center rounded text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]">
                  <X size={12}/>
                </button>
              </Tooltip>)}
          </div>
          <Tooltip label={t("notes.sort_and_display")}>
            <IconButton label={t("notes.sort_and_display")} size="sm" className="mobile-library-sort" ref={sortButtonRef} onClick={() => setSortMenuOpen(true)}>
              <ArrowDownWideNarrow size={17}/>
            </IconButton>
          </Tooltip>
          {view !== 'trash' && view !== 'archived' && (<Tooltip label={t("common.new_note")} combo="mod+n">
              <IconButton label={t("common.new_note")} size="sm" className="mobile-library-compose" onClick={() => void createContextualNote()}>
                <Plus size={19}/>
              </IconButton>
            </Tooltip>)}
        </div>}

        {breakpoint === 'mobile' && <MobileLibraryFilters />}

        {view === 'trash' && notes.length > 0 && (<button type="button" disabled={emptyingTrash} aria-busy={emptyingTrash} onClick={() => void emptyTrash()} className="mt-2 w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] py-1.5 text-[11.5px] text-[var(--text-tertiary)] transition-colors hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:pointer-events-none disabled:opacity-50">{t("notes.empty_trash")}{notes.length}{t("notes.notes_93aeb9")}</button>)}
      </header>

      <div key={`${view}:${folderId ?? ''}:${tag ?? ''}`} ref={listRef} role="listbox" aria-label={title} aria-multiselectable="true" aria-activedescendant={activeNoteId && renderedIds.has(activeNoteId) ? `note-option-${activeNoteId}` : undefined} tabIndex={0} onKeyDown={onKeyDown} className="anim-view-content min-h-0 flex-1 overflow-y-auto px-2 pb-4 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]">
        {!hydrated && loading ? (<NoteListSkeleton />) : filtered.length === 0 ? (<ListEmpty view={view} filtering={Boolean(filter)}/>) : (groups.map((group) => (<div key={group.key} role="group" aria-label={group.label ?? title}>
              {group.label && (<div className="px-2 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
                  {group.label}
                </div>)}
              <div role="presentation" className="space-y-px">
                {group.items.map(({ note, ranges }) => (<NoteRow key={note.id} note={note} highlight={ranges} density={density} tagColors={tagColors} position={filteredPositions.get(note.id) ?? 1} total={filtered.length} onRangeSelect={selectRange}/>))}
              </div>
            </div>)))}
        {renderLimit < filtered.length && <div ref={loadMoreRef} aria-hidden="true" className="h-px"/>}
      </div>

      <BulkBar />

      <Menu anchor={sortButtonRef} open={sortMenuOpen} onClose={() => setSortMenuOpen(false)} items={sortItems} align="end"/>
    </section>);
}
const NoteRow = memo(function NoteRow({ note, highlight, density, tagColors, position, total, onRangeSelect, }: {
    note: NoteSummary;
    highlight: [
        number,
        number
    ][];
    density: 'comfortable' | 'compact';
    tagColors: Map<string, string | null>;
    position: number;
    total: number;
    onRangeSelect: (noteId: string) => void;
}) {
    const breakpoint = useBreakpoint();
    const locale = useLocale();
    const toast = useUi((s) => s.toast);
    const active = useUi((s) => s.activeNoteId === note.id);
    const openInSecondary = useUi((s) => s.workspaceSecondaryNoteId === note.id);
    const selectedIds = useUi((s) => s.selectedIds);
    const selected = selectedIds.includes(note.id);
    const selectionHighlighted = selected && (selectedIds.length > 1 || !active);
    const toggleSelected = useUi((s) => s.toggleSelected);
    const openNote = useNotes((s) => s.openNote);
    const patchNote = useNotes((s) => s.patchNote);
    const deleteNote = useNotes((s) => s.deleteNote);
    const restoreNote = useNotes((s) => s.restoreNote);
    const purgeNote = useNotes((s) => s.purgeNote);
    const duplicateNote = useNotes((s) => s.duplicateNote);
    const folders = useNotes((s) => s.folders);
    const menu = useContextMenu();
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [moveOpen, setMoveOpen] = useState(false);
    const purgeRef = useRef(false);
    const [purging, setPurging] = useState(false);
    const inTrash = Boolean(note.deletedAt);
    const purge = async () => {
        if (purgeRef.current)
            return;
        purgeRef.current = true;
        setPurging(true);
        try {
            const ok = await confirm({
                title: t("notes.permanently_delete_this_note"),
                description: t("notes.this_operation_cannot_be_undone"),
                confirmLabel: t("notes.delete_permanently"),
                tone: 'danger',
            });
            if (ok)
                await purgeNote(note.id);
        }
        finally {
            purgeRef.current = false;
            setPurging(false);
        }
    };
    const exportNote = async (format: 'md' | 'html' | 'pdf') => {
        const state = useNotes.getState();
        let content = state.contents[note.id];
        if (content === undefined) {
            await state.openNote(note.id);
            content = useNotes.getState().contents[note.id];
            if (content === undefined) {
                toast({ title: t("common.export_failed"), tone: 'danger' });
                return;
            }
        }
        const payload = { title: note.title, content };
        if (format === 'md') {
            exportNoteAsMarkdown(payload);
            return;
        }
        try {
            if (format === 'html')
                await exportNoteAsHtml(payload, locale);
            else
                await exportNoteAsPdf(payload, locale);
        }
        catch (err) {
            toast({
                title: t("common.export_failed"),
                description: err instanceof Error ? err.message : String(err),
                tone: 'danger',
            });
        }
    };
    const copyText = async (value: string, successMessage: 'notes.title_copied' | 'notes.id_copied' | 'notes.direct_link_copied') => {
        try {
            await navigator.clipboard.writeText(value);
            toast({ title: t(successMessage), tone: 'success' });
        }
        catch {
            toast({ title: t('preview.could_not_copy'), tone: 'danger' });
        }
    };
    const noteActions: MenuItem[] = inTrash
        ? [
            { id: 'restore', label: t("common.restore"), icon: <RotateCcw size={13}/>, separatorBefore: true, onSelect: () => void restoreNote(note.id) },
            {
                id: 'purge',
                label: t("notes.delete_permanently"),
                icon: <Trash2 size={13}/>,
                tone: 'danger',
                separatorBefore: true,
                disabled: purging,
                onSelect: () => void purge(),
            },
        ]
        : [
            ...(breakpoint === 'desktop' ? [{
                id: 'open-side',
                label: t("notes.open_to_side"),
                icon: <Columns2 size={13}/>,
                separatorBefore: true,
                onSelect: () => void openNote(note.id, { pane: 'secondary' }),
            } satisfies MenuItem] : []),
            ...(breakpoint === 'mobile' ? [{
                id: 'multi-select',
                label: t("notes.add_to_selection"),
                icon: <CheckSquare2 size={13}/>,
                separatorBefore: true,
                disabled: selectedIds.includes(note.id),
                onSelect: () => toggleSelected(note.id, true),
            } satisfies MenuItem] : []),
            {
                id: 'pin',
                label: note.isPinned ? t("notes.unpin") : t("notes.pin"),
                icon: note.isPinned ? <PinOff size={13}/> : <Pin size={13}/>,
                separatorBefore: breakpoint !== 'desktop' && breakpoint !== 'mobile',
                onSelect: () => void patchNote(note.id, { isPinned: !note.isPinned }),
            },
            {
                id: 'star',
                label: note.isStarred ? t("common.remove_from_favorites") : t("navigation.favorites"),
                icon: note.isStarred ? <StarOff size={13}/> : <Star size={13}/>,
                combo: 'mod+d',
                onSelect: () => void patchNote(note.id, { isStarred: !note.isStarred }),
            },
            { id: 'duplicate', label: t("notes.create_a_copy"), icon: <Copy size={13}/>, onSelect: () => void duplicateNote(note.id) },
            {
                id: 'archive',
                label: note.isArchived ? t("common.unarchive") : t("navigation.archive"),
                icon: <Archive size={13}/>,
                onSelect: () => void patchNote(note.id, { isArchived: !note.isArchived }),
            },
            {
                id: 'move',
                label: t("notes.move_to_folder"),
                icon: <FolderInput size={13}/>,
                separatorBefore: true,
                onSelect: () => setMoveOpen(true),
            },
            { id: 'export-md', label: t("workspace.export_markdown"), icon: <FileText size={13}/>, separatorBefore: true, onSelect: () => void exportNote('md') },
            { id: 'export-html', label: t("workspace.export_html"), icon: <FileCode size={13}/>, onSelect: () => void exportNote('html') },
            { id: 'export-pdf', label: t("workspace.export_pdf"), icon: <FileDown size={13}/>, onSelect: () => void exportNote('pdf') },
            {
                id: 'delete',
                label: t("common.move_to_trash"),
                icon: <Trash2 size={13}/>,
                tone: 'danger',
                separatorBefore: true,
                onSelect: () => void deleteNote(note.id),
            },
        ];
    const items: MenuItem[] = [
        { id: 'copy-title', label: t('notes.copy_title'), icon: <Copy size={13}/>, onSelect: () => void copyText(note.title || t('common.untitled_note'), 'notes.title_copied') },
        { id: 'copy-id', label: t('notes.copy_id'), icon: <Copy size={13}/>, onSelect: () => void copyText(note.id, 'notes.id_copied') },
        { id: 'copy-direct-link', label: t('notes.copy_direct_link'), icon: <Link2 size={13}/>, onSelect: () => void copyText(new URL(`/n/${encodeURIComponent(note.id)}`, window.location.origin).href, 'notes.direct_link_copied') },
        ...noteActions,
    ];
    const titleParts = splitByRanges(note.title || t("common.untitled_note"), highlight);
    return (<>
      <div id={`note-option-${note.id}`} role="option" aria-selected={active || selected} aria-posinset={position} aria-setsize={total} tabIndex={-1} data-note-id={note.id} draggable style={{ contentVisibility: 'auto', containIntrinsicSize: density === 'compact' ? 'auto 42px' : 'auto 72px' }} onDragStart={(e) => {
            e.dataTransfer.setData('application/x-inkstone-note', note.id);
            e.dataTransfer.effectAllowed = 'move';
        }} onClick={(event) => {
            if (event.altKey && breakpoint === 'desktop') {
                event.preventDefault();
                void openNote(note.id, { pane: 'secondary' });
                return;
            }
            if (event.metaKey || event.ctrlKey) {
                toggleSelected(note.id, true);
                return;
            }
            if (event.shiftKey) {
                event.preventDefault();
                onRangeSelect(note.id);
                return;
            }
            void openNote(note.id);
        }} onContextMenu={(event) => {
            setMenuOpen(false);
            menu.onContextMenu(event);
        }} className={cn('motion-note-row group relative cursor-default rounded-[var(--r-md)] border border-transparent px-2.5 pr-11 transition-[background-color,border-color,box-shadow,transform] duration-[var(--dur-fast)] md:pr-10', density === 'compact' ? 'py-[7px]' : 'py-2.5', selectionHighlighted
            ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/40'
            : active
                ? 'border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]'
                : openInSecondary
                    ? 'border-[var(--accent)]/35 bg-[var(--accent-soft)]/45'
                : 'hover:bg-[var(--bg-hover)]')}>
        <div className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {note.isPinned && <Pin size={10} className="anim-mark-enter shrink-0 text-[var(--accent)]"/>}
              <h3 className={cn('min-w-0 flex-1 truncate text-[13px] leading-snug', active
            ? 'font-semibold text-[var(--accent)]'
            : 'font-medium text-[var(--text-primary)]')}>
                {titleParts.map((part, i) => part.hit ? (<mark key={i} className="ink-hit">
                      {part.text}
                    </mark>) : (<span key={i}>{part.text}</span>))}
              </h3>
              {note.isStarred && <Star size={10} className="anim-mark-enter shrink-0 fill-current text-[var(--warning)]"/>}
            </div>

            {density === 'comfortable' && note.excerpt && (<p className="truncate-2 mt-1 text-[11.5px] leading-[1.5] text-[var(--text-tertiary)]">
                {note.excerpt}
              </p>)}

            {note.tags.length > 0 && density === 'comfortable' && (<div className="mt-1.5 flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[10.5px] text-[var(--text-tertiary)]">
                {note.tags.map((tag) => (<span key={tag} className="max-w-[70%] shrink-0 truncate" style={{ color: tagColors.get(tag) ?? undefined }}>
                    #{tag}
                  </span>))}
              </div>)}
          </div>
        </div>
        {breakpoint === 'desktop' && (<Tooltip label={t("notes.open_to_side")} side="left">
            <IconButton label={t("notes.open_to_side")} size="sm" active={openInSecondary} onClick={(event) => {
                  event.stopPropagation();
                  void openNote(note.id, { pane: 'secondary' });
              }} className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" >
              <Columns2 size={14}/>
            </IconButton>
          </Tooltip>)}
        {breakpoint === 'mobile' && (<Tooltip label={t("common.more_actions")} side="left">
            <IconButton ref={menuButtonRef} label={t("common.more_actions")} size="sm" onClick={(event) => {
                  event.stopPropagation();
                  menu.close();
                  setMenuOpen(true);
              }} className="absolute top-1.5 right-1.5">
              <MoreHorizontal size={16}/>
            </IconButton>
          </Tooltip>)}
      </div>

      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items}/>}
      <Menu anchor={menuButtonRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} align="end" width={240}/>
      {moveOpen && <FolderPicker open title={t("notes.move_to_folder")} folders={folders} currentId={note.folderId} rootLabel={t("notes.remove_from_folder")} onSelect={(folderId) => void patchNote(note.id, { folderId })} onClose={() => setMoveOpen(false)}/>}
    </>);
});
function BulkBar() {
    const selectedIds = useUi((s) => s.selectedIds);
    const setSelected = useUi((s) => s.setSelected);
    const patchNote = useNotes((s) => s.patchNote);
    const deleteNote = useNotes((s) => s.deleteNote);
    const folders = useNotes((s) => s.folders);
    const notes = useNotes((s) => s.notes);
    const toast = useUi((s) => s.toast);
    const [folderPickerOpen, setFolderPickerOpen] = useState(false);
    const busyRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const ids = selectedIds.filter((id) => notes[id]);
    if (ids.length < 2)
        return null;
    const allStarred = ids.every((id) => notes[id]?.isStarred);
    const firstFolderId = notes[ids[0]!]?.folderId ?? null;
    const commonFolderId = ids.every((id) => notes[id]?.folderId === firstFolderId) ? firstFolderId : undefined;
    const clear = () => {
        const currentActiveId = useUi.getState().activeNoteId;
        setSelected(currentActiveId ? [currentActiveId] : []);
    };
    const performAll = async (fn: (id: string) => Promise<void>, label: string) => {
        for (const id of ids)
            await fn(id);
        toast({ title: t("notes.value0_value1_notes", { value0: label, value1: ids.length }), tone: 'success' });
        clear();
    };
    const runAll = async (task: () => Promise<void>) => {
        if (busyRef.current)
            return;
        busyRef.current = true;
        setBusy(true);
        try {
            await task();
        }
        catch (err) {
            toast({ title: t("common.action_failed"), description: err instanceof Error ? err.message : String(err), tone: 'danger' });
        }
        finally {
            busyRef.current = false;
            setBusy(false);
        }
    };
    return (<div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-3">
      <div className="anim-rise pointer-events-auto flex items-center gap-1 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 pl-3 shadow-[var(--shadow-pop)]">
        <span className="mr-1 text-[11.5px] whitespace-nowrap text-[var(--text-secondary)]">{t("notes.selected")}<span className="tabular font-medium">{ids.length}</span>{t("notes.notes")}</span>
        <Tooltip label={allStarred ? t("common.remove_from_favorites") : t("navigation.favorites")}>
          <IconButton label={t("navigation.favorites")} size="sm" disabled={busy} onClick={() => void runAll(() => performAll((id) => patchNote(id, { isStarred: !allStarred }), allStarred ? t("notes.removed_from_favorites") : t("notes.added_to_favorites")))}>
            <Star size={13} className={allStarred ? 'fill-current' : undefined}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t("notes.move_to_folder")}>
          <IconButton label={t("notes.move_to_folder")} size="sm" disabled={busy} onClick={() => setFolderPickerOpen(true)}>
            <FolderInput size={13}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t("navigation.archive")}>
          <IconButton label={t("navigation.archive")} size="sm" disabled={busy} onClick={() => void runAll(() => performAll((id) => patchNote(id, { isArchived: true }), t("notes.archived")))}>
            <Archive size={13}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t("common.move_to_trash")}>
          <IconButton label={t("common.move_to_trash")} size="sm" disabled={busy} className="text-[var(--text-tertiary)] hover:text-[var(--danger)]" onClick={() => void runAll(async () => {
            const ok = await confirm({
                title: t("notes.move_value0_notes_to_trash", { value0: ids.length }),
                description: t("notes.restore_it_from_trash_at_any_time"),
                confirmLabel: t("common.move_to_trash"),
                tone: 'danger',
            });
            if (ok)
                await performAll((id) => deleteNote(id), t("notes.deleted"));
        })}>
            <Trash2 size={13}/>
          </IconButton>
        </Tooltip>
        <span className="mx-0.5 h-4 w-px bg-[var(--border-subtle)]"/>
        <Tooltip label={t("notes.deselect")}>
          <IconButton label={t("notes.deselect")} size="sm" disabled={busy} onClick={clear}>
            <X size={13}/>
          </IconButton>
        </Tooltip>
      </div>

      {folderPickerOpen && <FolderPicker open title={t("notes.move_to_folder")} folders={folders} currentId={commonFolderId} rootLabel={t("notes.remove_from_folder")} onSelect={(folderId) => void runAll(() => performAll((id) => patchNote(id, { folderId }), folderId ? t("notes.moved") : t("notes.moved_out")))} onClose={() => setFolderPickerOpen(false)}/>}
    </div>);
}
function ListEmpty({ view, filtering }: {
    view: string;
    filtering: boolean;
}) {
    const shortcut = (combo: string) => prettyCombo(combo).join('+');
    if (filtering) {
        return <Empty art="search" title={t("notes.no_matching_notes")} description={t("notes.try_another_search_or_press_shortcut_to_search_everywhere", { shortcut: shortcut('mod+k') })}/>;
    }
    const config: Record<string, {
        art: 'notes' | 'starred' | 'trash' | 'archive' | 'folder' | 'tag';
        title: string;
        desc: string;
    }> = {
        all: { art: 'notes', title: t("notes.no_notes_yet"), desc: t("notes.press_shortcut_or_the_plus_button_to_write_your_first_note", { shortcut: shortcut('mod+n') }) },
        recent: { art: 'notes', title: t("notes.nothing_has_been_edited_recently"), desc: t("notes.write_something_and_it_will_appear_here") },
        starred: { art: 'starred', title: t("notes.no_favorites_yet"), desc: t("notes.right_click_a_note_or_press_shortcut_to_favorite_it", { shortcut: shortcut('mod+d') }) },
        unfiled: { art: 'folder', title: t("notes.every_note_is_filed"), desc: t("notes.everything_is_neatly_organized") },
        archived: { art: 'archive', title: t("notes.archive_is_empty"), desc: t("notes.keep_notes_here_when_you_want_them_out_of_the_way_but_not_deleted") },
        trash: { art: 'trash', title: t("notes.trash_is_empty"), desc: t("notes.deleted_notes_remain_until_you_restore_or_clear_them") },
        folder: { art: 'folder', title: t("notes.this_folder_is_still_empty"), desc: t("notes.drag_notes_in_or_create_new_ones_here") },
        tag: { art: 'tag', title: t("notes.there_are_no_notes_with_this_tag"), desc: t("notes.write_tags_in_the_note_to_link_them_automatically") },
    };
    const item = config[view] ?? config.all!;
    return (<Empty art={item.art} title={item.title} description={item.desc} action={view !== 'trash' && view !== 'archived' ? (<button type="button" onClick={() => void createContextualNote()} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-default)] px-3 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
            <Plus size={13}/>{t("common.new_note")}</button>) : undefined}/>);
}
interface Group {
    key: string;
    label: string | null;
    items: {
        note: NoteSummary;
        ranges: [
            number,
            number
        ][];
    }[];
}
function groupNotes(items: {
    note: NoteSummary;
    ranges: [
        number,
        number
    ][];
}[], sort: SortKey, isTrash: boolean, now: number): Group[] {
    const pinned = isTrash ? [] : items.filter((i) => i.note.isPinned);
    const rest = isTrash ? items : items.filter((i) => !i.note.isPinned);
    const groups: Group[] = [];
    if (pinned.length)
        groups.push({ key: 'pinned', label: t("notes.pin"), items: pinned });
    if (sort === 'updated' || sort === 'created' || isTrash) {
        let currentKey: string | null = null;
        let bucket: Group | null = null;
        for (const item of rest) {
            const stamp = isTrash
                ? (item.note.deletedAt ?? item.note.updatedAt)
                : sort === 'created'
                    ? item.note.createdAt
                    : item.note.updatedAt;
            const label = groupLabel(stamp, now);
            if (label !== currentKey) {
                currentKey = label;
                bucket = { key: `${label}-${groups.length}`, label, items: [] };
                groups.push(bucket);
            }
            bucket?.items.push(item);
        }
    }
    else if (rest.length) {
        groups.push({ key: 'rest', label: pinned.length ? t("notes.other") : null, items: rest });
    }
    return groups.filter((g) => g.items.length);
}
function useEmptyTrash() {
    const emptyTrashAction = useNotes((s) => s.emptyTrash);
    const toast = useUi((s) => s.toast);
    const [emptyingTrash, setEmptyingTrash] = useState(false);
    const busyRef = useRef(false);
    const emptyTrash = async () => {
        if (busyRef.current)
            return;
        busyRef.current = true;
        setEmptyingTrash(true);
        try {
            const ok = await confirm({
                title: t("common.empty_trash"),
                description: t("notes.every_note_inside_will_be_permanently_deleted_and_cannot_be_recovered"),
                confirmLabel: t("common.clear"),
                tone: 'danger',
            });
            if (!ok)
                return;
            const purged = await emptyTrashAction();
            if (purged === null)
                return;
            toast({
                title: t("common.permanently_deleted_value0_notes", { value0: purged }),
                tone: 'success',
            });
        }
        catch (err) {
            toast({ title: t("notes.clearing_failed"), description: err instanceof Error ? err.message : String(err), tone: 'danger' });
        }
        finally {
            busyRef.current = false;
            setEmptyingTrash(false);
        }
    };
    return { emptyTrash, emptyingTrash };
}
