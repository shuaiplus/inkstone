import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { ArrowLeft, Columns2, Eye, History, Link as LinkIcon, ListTree, MoreHorizontal, PanelRightClose, Pencil, Plus, Share2, Star, } from 'lucide-react';
import { cn } from '../../lib/cn';
import { api } from '../../lib/api';
import { readingMinutes } from '@shared/markdown-utils';
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
import { Preview } from '../preview/Preview';
import { Outline } from '../preview/Outline';
import { SplitResizer } from '../shell/Resizer';
import { EditorToolbar } from './EditorToolbar';
import { BacklinksPanel } from './BacklinksPanel';
import { SaveIndicator } from '../shell/SaveIndicator';
import type { Heading } from '../../lib/markdown/renderer';
import { useUi } from '../../store/ui';
import { useSession } from '../../store/session';
import { useActiveNote, useNotes } from '../../store/notes';
import { useSyncScroll } from './sync-scroll';
import { t } from "../../lib/i18n";
const SPLIT_HANDLE_WIDTH = 1;
const PREVIEW_BORDER_WIDTH = 1;
const OUTLINE_WIDTH = 168;
export function Workspace({ mobileLayout = 'edit', onMobileBack, }: {
    mobileLayout?: 'edit' | 'preview';
    onMobileBack?: () => void;
} = {}) {
    const { note, content, loaded } = useActiveNote();
    const settings = useSession((s) => s.settings);
    const updateSettings = useSession((s) => s.updateSettings);
    const editContent = useNotes((s) => s.editContent);
    const createNote = useNotes((s) => s.createNote);
    const patchNote = useNotes((s) => s.patchNote);
    const tags = useNotes((s) => s.tags);
    const notes = useNotes((s) => s.notes);
    const toast = useUi((s) => s.toast);
    const openPanel = useUi((s) => s.openPanel);
    const outlineOpen = useUi((s) => s.outlineOpen);
    const backlinksOpen = useUi((s) => s.backlinksOpen);
    const toggleOutline = useUi((s) => s.toggleOutline);
    const toggleBacklinks = useUi((s) => s.toggleBacklinks);
    const splitRatio = useUi((s) => s.splitRatio);
    const setLayout = useUi((s) => s.setLayout);
    const breakpoint = useBreakpoint();
    const containerRef = useRef<HTMLDivElement>(null);
    const previewScrollerRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const moreButtonRef = useRef<HTMLButtonElement>(null);
    const [view, setView] = useState<EditorView | null>(null);
    const [headings, setHeadings] = useState<Heading[]>([]);
    const [moreMenuOpen, setMoreMenuOpen] = useState(false);
    const [mobileOutlineOpen, setMobileOutlineOpen] = useState(false);
    const [containerWidth, setContainerWidth] = useState(0);
    const isMobile = breakpoint === 'mobile';
    const layout = isMobile ? mobileLayout : settings.preview.layout;
    const showEditor = layout === 'edit' || layout === 'split';
    const showPreview = layout === 'preview' || layout === 'split';
    const outlineVisible = !isMobile && outlineOpen && headings.length > 0;
    const defaultOutlineWidth = outlineVisible ? OUTLINE_WIDTH : 0;
    const defaultContentWidth = Math.max(0, containerWidth - SPLIT_HANDLE_WIDTH - PREVIEW_BORDER_WIDTH - defaultOutlineWidth);
    const defaultEditorWidth = defaultContentWidth / 2;
    const defaultPreviewWidth = PREVIEW_BORDER_WIDTH + defaultOutlineWidth + defaultEditorWidth;
    const effectiveSplitRatio = splitRatio ?? (containerWidth > 0 ? defaultEditorWidth / containerWidth : 0.5);
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
    const setEditorLayout = (next: EditorLayout) => void updateSettings({ preview: { layout: next } });
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
                const uploaded = await api.files.upload(file, note?.id);
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
        if (!note || !view)
            return;
        const frame = window.requestAnimationFrame(() => view.focus());
        return () => window.cancelAnimationFrame(frame);
    }, [note?.id, view]);
    if (!note)
        return <NoNoteSelected onCreate={() => void createNote()}/>;
    if (!loaded) {
        return (<div className="h-full overflow-hidden bg-[var(--bg-editor)]" aria-busy="true" aria-label={t("workspace.loading_note_content")}>
        <EditorSkeleton />
      </div>);
    }
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
    ];
    return (<div className="flex h-full min-h-0 flex-col bg-[var(--bg-editor)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
        {isMobile && onMobileBack && (<Tooltip label={t("workspace.back_to_notes")} side="right">
            <IconButton label={t("workspace.back_to_notes")} size="sm" onClick={onMobileBack}>
              <ArrowLeft size={16}/>
            </IconButton>
          </Tooltip>)}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="min-w-0 truncate text-[13.5px] font-medium tracking-[-0.01em] text-[var(--text-primary)]">
            {note.title || t("common.untitled_note")}
          </h1>
          {note.isStarred && <Star size={11} className="shrink-0 fill-current text-[var(--warning)]"/>}
          <span className="hidden shrink-0 text-[11px] text-[var(--text-quaternary)] md:inline">
            {updatedTime}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
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
        </div>
      </header>

      {settings.editor.showToolbar && showEditor && (<EditorToolbar view={view} mobile={isMobile} onPickImage={() => fileInputRef.current?.click()}/>)}

      <div ref={containerRef} className="flex min-h-0 flex-1">
        {showEditor && (<div className="min-w-0" style={{ width: layout === 'split' ? editorWidth : '100%' }}>
            <CodeEditor key={note.id} value={content} onChange={onChange} settings={settings.editor} sources={sources} handlers={handlers} onReady={setView}/>
          </div>)}

        {layout === 'split' && (<SplitResizer label={t("workspace.resize_editor_and_preview_panes")} containerRef={containerRef} ratio={effectiveSplitRatio} onChange={(splitRatio) => setLayout({ splitRatio })} onReset={() => setLayout({ splitRatio: null })}/>)}

        {showPreview && (<div className={cn('flex min-w-0 overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--bg-editor)]', layout === 'preview' && 'flex-1 border-l-0')} style={{ width: layout === 'split' ? previewWidth : undefined }}>
            <Preview key={note.id} content={content} onHeadings={setHeadings} scrollerRef={previewScrollerRef} onRendered={invalidateSyncAnchors} className="min-w-0 flex-1"/>
            {outlineVisible && (<Outline headings={headings} onSelect={jumpToHeading} scrollerRef={previewScrollerRef}/>)}
          </div>)}
      </div>

      {backlinksOpen && <BacklinksPanel noteId={note.id}/>}

      <Menu anchor={moreButtonRef} open={moreMenuOpen} onClose={() => setMoreMenuOpen(false)} items={mobileItems} align="end" width={220}/>
      {isMobile && showPreview && (<Drawer open={mobileOutlineOpen} onClose={() => setMobileOutlineOpen(false)} side="right" width={320} title={t("common.outline")}>
          <Outline headings={headings} scrollerRef={previewScrollerRef} className="max-h-none w-full self-stretch py-3" onSelect={(heading) => {
                jumpToHeading(heading);
                setMobileOutlineOpen(false);
            }}/>
        </Drawer>)}

      <footer className="flex h-[var(--statusbar-h)] shrink-0 items-center gap-3 border-t border-[var(--border-subtle)] px-3 text-[11px] text-[var(--text-quaternary)]">
        <span className="tabular">{note.wordCount}{t("common.words")}</span>
        <span className="tabular">{note.charCount}{t("workspace.characters")}</span>
        <span className="hidden tabular md:inline">{t("common.about")}{readingMinutes(note.wordCount)}{t("common.min")}</span>
        {note.tags.length > 0 && (<span className="hidden min-w-0 truncate md:inline">
            {note.tags.map((t) => `#${t}`).join(' ')}
          </span>)}
        <span className="flex-1"/>
        <span className="hidden lg:inline">{t("common.created")}{fullTime(note.createdAt)}</span>
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