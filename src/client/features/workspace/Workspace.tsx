import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { setActiveEditorView } from '../ai/active-editor';
import { ArrowLeft, Columns2, Download, Eye, FileCode, FileDown, FileText, FolderClosed, Hash, History, Link as LinkIcon, ListTree, MoreHorizontal, PanelRightClose, Pencil, Plus, Share2, Star, X, } from 'lucide-react';
import { cn } from '../../lib/cn';
import { api } from '../../lib/api';
import { readingMinutes } from '@shared/markdown-utils';
import { LIMITS } from '@shared/constants';
import type { EditorLayout } from '@shared/types';
import { fullTime } from '../../lib/time';
import { useBreakpoint, useRelativeTime } from '../../lib/hooks';
import { prettyCombo } from '../../lib/hotkeys';
import { IconButton } from '../../components/primitives';
import { Drawer, Menu, Tooltip, type MenuItem } from '../../components/overlay';
import { Segmented } from '../../components/form';
import { EditorSkeleton, Empty } from '../../components/feedback';
import { CodeEditor } from '../../editor/CodeEditor';
import { insertFiles } from '../../editor/paste';
import { optimizeImageFile } from '../../lib/image';
import { exportNoteAsHtml, exportNoteAsMarkdown, exportNoteAsPdf } from '../../lib/export-note';
import { Preview } from '../preview/Preview';
import { Outline } from '../preview/Outline';
import { SplitResizer } from '../shell/Resizer';
import { EditorToolbar } from './EditorToolbar';
import { BacklinksPanel } from './BacklinksPanel';
import { SaveIndicator } from '../shell/SaveIndicator';
import type { Heading } from '../../lib/markdown/renderer';
import { useUi, type WorkspacePane } from '../../store/ui';
import { useSession } from '../../store/session';
import { createContextualNote, useActiveNote, useNotes } from '../../store/notes';
import { folderPathLabel, openFolderView } from '../../lib/folders';
import { useSyncScroll } from './sync-scroll';
import { t, useLocale } from "../../lib/i18n";
const SPLIT_HANDLE_WIDTH = 1;
const PREVIEW_BORDER_WIDTH = 1;
const OUTLINE_WIDTH = 168;
export function Workspace({ mobileLayout = 'edit', onMobileBack, pane = 'active', grouped = false, }: {
    mobileLayout?: 'edit' | 'preview';
    onMobileBack?: () => void;
    pane?: WorkspacePane | 'active';
    grouped?: boolean;
} = {}) {
    const { note, content, loaded } = useActiveNote(pane);
    const settings = useSession((s) => s.settings);
    const updateSettings = useSession((s) => s.updateSettings);
    const editContent = useNotes((s) => s.editContent);
    const editTitle = useNotes((s) => s.editTitle);
    const patchNote = useNotes((s) => s.patchNote);
    const tags = useNotes((s) => s.tags);
    const folders = useNotes((s) => s.folders);
    const notes = useNotes((s) => s.notes);
    const toast = useUi((s) => s.toast);
    const locale = useLocale();
    const openPanel = useUi((s) => s.openPanel);
    const outlineOpen = useUi((s) => s.outlineOpen);
    const backlinksOpen = useUi((s) => s.backlinksOpen);
    const toggleOutline = useUi((s) => s.toggleOutline);
    const toggleBacklinks = useUi((s) => s.toggleBacklinks);
    const splitRatio = useUi((s) => s.splitRatio);
    const setLayout = useUi((s) => s.setLayout);
    const activeWorkspacePane = useUi((s) => s.activeWorkspacePane);
    const workspacePaneLayouts = useUi((s) => s.workspacePaneLayouts);
    const setWorkspacePaneLayout = useUi((s) => s.setWorkspacePaneLayout);
    const activateWorkspacePane = useUi((s) => s.activateWorkspacePane);
    const closeSecondaryNote = useUi((s) => s.closeSecondaryNote);
    const breakpoint = useBreakpoint();
    const containerRef = useRef<HTMLDivElement>(null);
    const previewScrollerRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const moreButtonRef = useRef<HTMLButtonElement>(null);
    const exportMenuRef = useRef<HTMLButtonElement>(null);
    const [view, setViewState] = useState<EditorView | null>(null);
    const setView = useCallback((next: EditorView | null) => {
        setViewState(next);
        setActiveEditorView(next);
    }, []);
    const [headings, setHeadings] = useState<Heading[]>([]);
    const [moreMenuOpen, setMoreMenuOpen] = useState(false);
    const [exportMenuOpen, setExportMenuOpen] = useState(false);
    const [mobileOutlineOpen, setMobileOutlineOpen] = useState(false);
    const [containerWidth, setContainerWidth] = useState(0);
    const isMobile = breakpoint === 'mobile';
    const paneActive = !grouped || pane === 'active' || activeWorkspacePane === pane;
    const layout = isMobile
        ? mobileLayout
        : grouped && pane !== 'active'
            ? workspacePaneLayouts[pane]
            : settings.preview.layout;
    const showEditor = layout === 'edit' || layout === 'split';
    const showPreview = layout === 'preview' || layout === 'split';
    const outlineVisible = !isMobile && outlineOpen && paneActive && headings.length > 0;
    const defaultOutlineWidth = outlineVisible ? OUTLINE_WIDTH : 0;
    const defaultContentWidth = Math.max(0, containerWidth - SPLIT_HANDLE_WIDTH - PREVIEW_BORDER_WIDTH - defaultOutlineWidth);
    const defaultEditorWidth = defaultContentWidth / 2;
    const defaultPreviewWidth = PREVIEW_BORDER_WIDTH + defaultOutlineWidth + defaultEditorWidth;
    const effectiveSplitRatio = splitRatio ?? (containerWidth > 0 ? defaultEditorWidth / containerWidth : 0.5);
    const tagColors = useMemo(() => new Map(tags.map((tag) => [tag.name, tag.color])), [tags]);
    const editorWidth = splitRatio === null
        ? containerWidth > 0
            ? `${defaultEditorWidth}px`
            : `calc((100% - ${SPLIT_HANDLE_WIDTH + PREVIEW_BORDER_WIDTH + defaultOutlineWidth}px) / 2)`
        : `${splitRatio * 100}%`;
    const previewWidth = splitRatio === null
        ? containerWidth > 0
            ? `${defaultPreviewWidth}px`
            : `calc((100% + ${PREVIEW_BORDER_WIDTH + defaultOutlineWidth - SPLIT_HANDLE_WIDTH}px) / 2)`
        : `${(1 - splitRatio) * 100}%`;
    const updatedTime = useRelativeTime(note?.updatedAt ?? 0, Boolean(note));
    useLayoutEffect(() => {
        setHeadings([]);
        setMobileOutlineOpen(false);
    }, [note?.id, showPreview]);
    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container)
            return;
        const measure = () => {
            const next = container.getBoundingClientRect().width;
            setContainerWidth((current) => Math.abs(current - next) < 0.5 ? current : next);
        };
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
    }, [loaded, note?.id]);
    const setEditorLayout = (next: EditorLayout) => {
        if (grouped && pane !== 'active') {
            setWorkspacePaneLayout(pane, next);
            return;
        }
        void updateSettings({ preview: { layout: next } });
    };
    const sources = useMemo(() => ({
        notes: () => Object.values(notes)
            .filter((n) => !n.deletedAt && n.id !== note?.id)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 300)
            .map((n) => ({ id: n.id, title: n.title, excerpt: n.excerpt })),
        tags: () => tags.map((t) => ({ name: t.name, count: t.count })),
    }), [notes, tags, note?.id]);
    const handlers = useMemo(() => ({
        uploadFile: async (file: File) => {
            try {
                const optimized = await optimizeImageFile(file);
                const uploaded = await api.files.upload(optimized, note?.id);
                return {
                    url: uploaded.url,
                    filename: uploaded.filename,
                    isImage: uploaded.mime.startsWith('image/'),
                };
            }
            catch (err) {
                toast({
                    title: t("workspace.upload_failed"),
                    description: err instanceof Error ? err.message : String(err),
                    tone: 'danger',
                });
                return null;
            }
        },
        replaceDetachedUpload: (placeholder: string, replacement: string) => {
            const noteId = note?.id;
            if (!noteId)
                return;
            const state = useNotes.getState();
            const source = state.contents[noteId];
            const at = source?.indexOf(placeholder) ?? -1;
            if (source === undefined || at < 0)
                return;
            state.editContent(noteId, `${source.slice(0, at)}${replacement}${source.slice(at + placeholder.length)}`);
        },
    }), [note?.id, toast]);
    const onChange = useCallback((next: string) => {
        if (!note)
            return;
        editContent(note.id, next);
    }, [note, editContent]);
    const runEditorCommand = useCallback((command: (target: EditorView) => boolean) => {
        if (!view)
            return;
        command(view);
        view.focus();
    }, [view]);
    const invalidateSyncAnchors = useSyncScroll(view, previewScrollerRef, settings.preview.syncScroll && layout === 'split');
    const jumpToHeading = useCallback((heading: Heading) => {
        const scroller = previewScrollerRef.current;
        const target = scroller?.querySelector<HTMLElement>(`#${CSS.escape(heading.slug)}`);
        if (target && scroller) {
            scroller.scrollTo({ top: target.offsetTop - 12, behavior: 'smooth' });
        }
        if (view) {
            const line = Math.min(view.state.doc.lines, heading.line + 1);
            const pos = view.state.doc.line(line).from;
            view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        }
    }, [view]);
    useEffect(() => {
        if (!note || !view || !paneActive)
            return;
        const frame = window.requestAnimationFrame(() => {
            if (!note.title)
                titleInputRef.current?.focus();
            else
                view.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [note?.id, paneActive, view]);
    if (!note)
        return <NoNoteSelected onCreate={() => void createContextualNote()}/>;
    if (!loaded) {
        return (<div className="h-full overflow-hidden bg-[var(--bg-editor)]" aria-busy="true" aria-label={t("workspace.loading_note_content")}>
        <EditorSkeleton />
      </div>);
    }
    const noteFolder = note.folderId ? folders.find((folder) => folder.id === note.folderId) ?? null : null;
    const noteFolderPath = note.folderId ? folderPathLabel(folders, note.folderId) : '';
    const exportNote = async (format: 'md' | 'html' | 'pdf') => {
        setExportMenuOpen(false);
        if (!note)
            return;
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
                title: t("workspace.export_failed"),
                description: err instanceof Error ? err.message : String(err),
                tone: 'danger',
            });
        }
    };
    const exportMenuItems: MenuItem[] = [
        { id: 'md', label: t("workspace.export_markdown"), icon: <FileText size={13}/>, onSelect: () => void exportNote('md') },
        { id: 'html', label: t("workspace.export_html"), icon: <FileCode size={13}/>, onSelect: () => void exportNote('html') },
        { id: 'pdf', label: t("workspace.export_pdf"), icon: <FileDown size={13}/>, onSelect: () => void exportNote('pdf') },
    ];
    const mobileItems: MenuItem[] = [
        {
            id: 'versions',
            label: t("common.version_history"),
            icon: <History size={13}/>,
            onSelect: () => openPanel('versions'),
        },
        {
            id: 'share',
            label: t("workspace.share"),
            icon: <Share2 size={13}/>,
            onSelect: () => openPanel('share'),
        },
        {
            id: 'export-md',
            label: t("workspace.export_markdown"),
            icon: <FileText size={13}/>,
            onSelect: () => void exportNote('md'),
        },
        {
            id: 'export-html',
            label: t("workspace.export_html"),
            icon: <FileCode size={13}/>,
            onSelect: () => void exportNote('html'),
        },
        {
            id: 'export-pdf',
            label: t("workspace.export_pdf"),
            icon: <FileDown size={13}/>,
            onSelect: () => void exportNote('pdf'),
        },
    ];
    const groupedItems: MenuItem[] = [
        { id: 'layout-edit', label: t("workspace.edit_only"), checked: layout === 'edit', onSelect: () => setEditorLayout('edit') },
        { id: 'layout-split', label: t("workspace.split_view"), checked: layout === 'split', onSelect: () => setEditorLayout('split') },
        { id: 'layout-preview', label: t("workspace.preview_only"), checked: layout === 'preview', onSelect: () => setEditorLayout('preview') },
        {
            id: 'star',
            label: note.isStarred ? t("common.remove_from_favorites") : t("navigation.favorites"),
            icon: <Star size={13}/>,
            separatorBefore: true,
            onSelect: () => void patchNote(note.id, { isStarred: !note.isStarred }),
        },
        {
            id: 'backlinks',
            label: t("common.backlinks"),
            icon: <LinkIcon size={13}/>,
            checked: backlinksOpen && paneActive,
            onSelect: toggleBacklinks,
        },
        ...(showPreview ? [{
            id: 'outline',
            label: t("common.outline"),
            icon: <ListTree size={13}/>,
            checked: outlineOpen && paneActive,
            onSelect: toggleOutline,
        } satisfies MenuItem] : []),
        ...mobileItems,
    ];
    const activatePane = () => {
        if (grouped && pane !== 'active' && !paneActive)
            activateWorkspacePane(pane);
    };
    return (<div role={grouped ? 'region' : undefined} aria-label={grouped ? (pane === 'secondary' ? t("workspace.right_note_pane") : t("workspace.left_note_pane")) : undefined} data-workspace-pane={grouped ? pane : undefined} onPointerDownCapture={activatePane} onFocusCapture={activatePane} className={cn('flex h-full min-h-0 flex-col bg-[var(--bg-editor)]', grouped && paneActive && 'shadow-[inset_0_2px_0_var(--accent)]')}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
        {isMobile && onMobileBack && (<Tooltip label={t("workspace.back_to_notes")} side="right">
            <IconButton label={t("workspace.back_to_notes")} size="sm" onClick={onMobileBack}>
              <ArrowLeft size={16}/>
            </IconButton>
          </Tooltip>)}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <input
            ref={titleInputRef}
            type="text"
            value={note.title}
            maxLength={LIMITS.titleMaxLength}
            aria-label={t("workspace.note_title")}
            placeholder={t("common.untitled_note")}
            className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-[14px] font-semibold tracking-[-0.01em] text-[var(--text-primary)] outline-none transition-colors placeholder:font-medium placeholder:text-[var(--text-quaternary)] hover:border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)]"
            onChange={(event) => editTitle(note.id, event.target.value)}
            onBlur={(event) => editTitle(note.id, event.currentTarget.value.trim())}
            onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                view?.focus();
            }}
          />
          {note.isStarred && <Star size={11} className="shrink-0 fill-current text-[var(--warning)]"/>}
          {!grouped && (<span className="hidden shrink-0 text-[11px] text-[var(--text-quaternary)] md:inline">
              {updatedTime}
            </span>)}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {grouped ? (<>
            <div className="mr-1 hidden 2xl:block">
              <Segmented label={t("workspace.layout")} size="sm" value={layout} onChange={setEditorLayout} options={[
                { value: 'edit', label: <Pencil size={12.5}/>, title: t("workspace.edit_only") },
                { value: 'split', label: <Columns2 size={12.5}/>, title: t("workspace.split_view") },
                { value: 'preview', label: <Eye size={12.5}/>, title: t("workspace.preview_only") },
              ]}/>
            </div>
            <Tooltip label={t("common.more_actions")} side="left">
              <IconButton ref={moreButtonRef} label={t("common.more_actions")} size="sm" onClick={() => setMoreMenuOpen(true)}>
                <MoreHorizontal size={16}/>
              </IconButton>
            </Tooltip>
            {pane === 'secondary' && (<Tooltip label={t("workspace.close_right_note")} side="left">
                <IconButton label={t("workspace.close_right_note")} size="sm" onClick={closeSecondaryNote}>
                  <X size={15}/>
                </IconButton>
              </Tooltip>)}
          </>) : (<>
          <span className="mr-1 hidden xl:inline-flex">
            <SaveIndicator />
          </span>
          <div className="mr-1 hidden lg:block">
            <Segmented label={t("workspace.layout")} size="sm" value={layout} onChange={setEditorLayout} options={[
            { value: 'edit', label: <Pencil size={12.5}/>, title: t("workspace.edit_only") },
            { value: 'split', label: <Columns2 size={12.5}/>, title: t("workspace.split_view"), combo: 'mod+\\' },
            { value: 'preview', label: <Eye size={12.5}/>, title: t("workspace.preview_only") },
        ]}/>
          </div>
          <Tooltip label={note.isStarred ? t("common.remove_from_favorites") : t("navigation.favorites")} combo="mod+d">
            <IconButton label={t("navigation.favorites")} size="sm" active={note.isStarred} onClick={() => void patchNote(note.id, { isStarred: !note.isStarred })}>
              <Star size={14} className={note.isStarred ? 'fill-current' : undefined}/>
            </IconButton>
          </Tooltip>
          <Tooltip label={t("common.backlinks")}>
            <IconButton label={t("common.backlinks")} size="sm" active={backlinksOpen} onClick={toggleBacklinks}>
              <LinkIcon size={14}/>
            </IconButton>
          </Tooltip>
          {!isMobile && (<Tooltip label={t("common.version_history")}>
              <IconButton label={t("common.version_history")} size="sm" onClick={() => openPanel('versions')}>
                <History size={14}/>
              </IconButton>
            </Tooltip>)}
          {!isMobile && (<>
              <Tooltip label={t("workspace.export")}>
                <IconButton ref={exportMenuRef} label={t("workspace.export")} size="sm" onClick={() => setExportMenuOpen(true)}>
                  <Download size={14}/>
                </IconButton>
              </Tooltip>
              <Menu anchor={exportMenuRef} open={exportMenuOpen} onClose={() => setExportMenuOpen(false)} items={exportMenuItems} align="end" width={200}/>
            </>)}
          {showPreview && (<Tooltip label={t("common.outline")} combo="mod+shift+o">
              <IconButton label={t("common.outline")} size="sm" active={isMobile ? mobileOutlineOpen : outlineOpen} onClick={() => isMobile ? setMobileOutlineOpen((open) => !open) : toggleOutline()}>
                {(isMobile ? mobileOutlineOpen : outlineOpen) ? <PanelRightClose size={14}/> : <ListTree size={14}/>}
              </IconButton>
            </Tooltip>)}
          {!isMobile && (<Tooltip label={t("workspace.share")}>
              <IconButton label={t("workspace.share")} size="sm" onClick={() => openPanel('share')}>
                <Share2 size={14}/>
              </IconButton>
            </Tooltip>)}
          {isMobile && (<Tooltip label={t("common.more_actions")} side="left">
              <IconButton ref={moreButtonRef} label={t("common.more_actions")} size="sm" onClick={() => setMoreMenuOpen(true)}>
                <MoreHorizontal size={16}/>
              </IconButton>
            </Tooltip>)}
          </>)}
        </div>
      </header>

      {settings.editor.showToolbar && showEditor && (<EditorToolbar runCommand={runEditorCommand} mobile={isMobile} onPickImage={() => fileInputRef.current?.click()}/>)}

      <div ref={containerRef} className="flex min-h-0 flex-1">
        {showEditor && (<div className="min-w-0" style={{ width: layout === 'split' ? editorWidth : '100%' }}>
            <CodeEditor key={note.id} value={content} onChange={onChange} settings={settings.editor} sources={sources} handlers={handlers} onReady={setView}/>
          </div>)}

        {layout === 'split' && (<SplitResizer label={t("workspace.resize_editor_and_preview_panes")} containerRef={containerRef} ratio={effectiveSplitRatio} onChange={(splitRatio) => setLayout({ splitRatio })} onReset={() => setLayout({ splitRatio: null })}/>)}

        {showPreview && (<div className={cn('flex min-w-0 overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--bg-editor)]', layout === 'preview' && 'flex-1 border-l-0')} style={{ width: layout === 'split' ? previewWidth : undefined }}>
            <Preview key={note.id} content={content} noteId={note.id} noteTitle={note.title} onHeadings={setHeadings} scrollerRef={previewScrollerRef} onRendered={invalidateSyncAnchors} className="min-w-0 flex-1"/>
            {outlineVisible && (<Outline headings={headings} onSelect={jumpToHeading} scrollerRef={previewScrollerRef}/>)}
          </div>)}
      </div>

      {backlinksOpen && paneActive && <BacklinksPanel noteId={note.id}/>}

      <Menu anchor={moreButtonRef} open={moreMenuOpen} onClose={() => setMoreMenuOpen(false)} items={grouped ? groupedItems : mobileItems} align="end" width={220}/>
      {isMobile && showPreview && (<Drawer open={mobileOutlineOpen} onClose={() => setMobileOutlineOpen(false)} side="right" width={320} title={t("common.outline")}>
          <Outline headings={headings} scrollerRef={previewScrollerRef} className="max-h-none w-full self-stretch py-3" onSelect={(heading) => {
                jumpToHeading(heading);
                setMobileOutlineOpen(false);
            }}/>
        </Drawer>)}

      <footer className="flex h-[var(--statusbar-h)] shrink-0 items-center gap-2 overflow-hidden border-t border-[var(--border-subtle)] px-3 text-[11px] text-[var(--text-quaternary)]">
        <span className="tabular">{note.wordCount}{t("common.words")}</span>
        <span className="hidden tabular sm:inline">{note.charCount}{t("workspace.characters")}</span>
        <span className="hidden tabular md:inline">{t("common.about")}{readingMinutes(note.wordCount)}{t("common.min")}</span>
        {noteFolder && noteFolderPath && (<Tooltip label={noteFolderPath} side="top">
            <button type="button" onClick={() => openFolderView(folders, noteFolder.id)} className="inline-flex min-w-0 max-w-40 items-center gap-1 truncate rounded px-1 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] md:max-w-48">
              <FolderClosed size={11} className="shrink-0" style={{ color: noteFolder.color ?? undefined }}/>
              <span className="truncate">{noteFolderPath}</span>
            </button>
          </Tooltip>)}
        {note.tags.length > 0 && (<span className="flex min-w-0 items-center gap-0.5 overflow-hidden">
            {note.tags.slice(0, isMobile ? 2 : 4).map((name) => (<button key={name} type="button" onClick={() => useUi.getState().openView('tag', { tag: name })} className="inline-flex min-w-0 items-center gap-0.5 rounded px-1 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]">
                <Hash size={9} className="shrink-0" style={{ color: tagColors.get(name) ?? undefined }}/><span className="truncate">{name}</span>
              </button>))}
          </span>)}
        <span className="flex-1"/>
        <span className={cn('hidden', grouped ? '2xl:inline' : 'lg:inline')}>{t("common.created")}{fullTime(note.createdAt)}</span>
      </footer>

      <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={async (event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            if (view && files.length)
                await insertFiles(view, files, handlers);
        }}/>
    </div>);
}
function NoNoteSelected({ onCreate }: {
    onCreate: () => void;
}) {
    return (<div className="flex h-full items-center justify-center bg-[var(--bg-editor)]">
      <Empty art="select" title={t("workspace.choose_a_note_or_write_a_new_one")} description={t("workspace.open_a_note_from_the_list_or_press_shortcut_to_create_one", { shortcut: prettyCombo('mod+n').join('+') })} action={<button type="button" onClick={onCreate} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] bg-[var(--accent)] px-3.5 text-[12.5px] font-medium text-[var(--accent-contrast)] transition-transform active:translate-y-px">
            <Plus size={14}/>{t("common.new_note")}</button>}/>
    </div>);
}
