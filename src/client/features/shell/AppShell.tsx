import { lazy, Suspense, useEffect, useRef } from 'react';
import { Eye, FileText, ListTree, PencilLine } from 'lucide-react';
import { cn } from '../../lib/cn';
import { registerAll } from '../../lib/hotkeys';
import { useBreakpoint } from '../../lib/hooks';
import { useSyncEngine } from '../../lib/sync';
import { Drawer } from '../../components/overlay';
import { InlineErrorBoundary } from '../../components/ErrorBoundary';
import { EditorSkeleton } from '../../components/feedback';
import { PANEL_WIDTHS, useUi } from '../../store/ui';
import { createContextualNote, useNotes } from '../../store/notes';
import { useSession } from '../../store/session';
import { useUpdate } from '../../store/update';
import { Sidebar } from '../sidebar/Sidebar';
import { NoteList } from '../list/NoteList';
import { FloatingSearch } from './FloatingSearch';
import { Resizer, SplitResizer } from './Resizer';
import { t } from "../../lib/i18n";
const Workspace = lazy(() => import('../workspace/Workspace').then((m) => ({ default: m.Workspace })));
const CommandPalette = lazy(() => import('../command/CommandPalette').then((m) => ({ default: m.CommandPalette })));
const SettingsPanel = lazy(() => import('../settings/SettingsPanel').then((m) => ({ default: m.SettingsPanel })));
const ShortcutsPanel = lazy(() => import('../command/ShortcutsPanel').then((m) => ({ default: m.ShortcutsPanel })));
const GraphPanel = lazy(() => import('../graph/GraphPanel').then((m) => ({ default: m.GraphPanel })));
const SharePanel = lazy(() => import('../share/SharePanel').then((m) => ({ default: m.SharePanel })));
const AiPanel = lazy(() => import('../ai/AiPanel').then((m) => ({ default: m.AiPanel })));
const VersionsPanel = lazy(() => import('../workspace/VersionsPanel').then((m) => ({ default: m.VersionsPanel })));
const Lightbox = lazy(() => import('../preview/Lightbox').then((m) => ({ default: m.Lightbox })));
const UpdateDialog = lazy(() => import('../update/UpdateDialog').then((m) => ({ default: m.UpdateDialog })));
export function AppShell() {
    const breakpoint = useBreakpoint();
    const role = useSession((s) => s.user?.role);
    const checkForUpdates = useUpdate((s) => s.check);
    useSyncEngine();
    useGlobalHotkeys();
    const hydrated = useNotes((s) => s.hydrated);
    const openNote = useNotes((s) => s.openNote);
    const deepLinkHandled = useRef(false);
    useEffect(() => {
        if (!hydrated || deepLinkHandled.current)
            return;
        deepLinkHandled.current = true;
        const match = /^\/n\/([0-9a-hjkmnp-tv-z]{26})\/?$/.exec(location.pathname);
        if (!match)
            return;
        useUi.getState().openView('all');
        void openNote(match[1]!);
    }, [hydrated, openNote]);
    useEffect(() => {
        if (role === 'owner')
            void checkForUpdates();
    }, [role, checkForUpdates]);

    useEffect(() => {
        const ui = useUi.getState();
        useUi.setState({
            outlineOpen: ui.workspaceSecondaryNoteId
                ? false
                : useSession.getState().settings.preview.showToc,
        });
    }, []);
    const navWidth = useUi((s) => s.navWidth);
    const listWidth = useUi((s) => s.listWidth);
    const navCollapsed = useUi((s) => s.navCollapsed);
    const listCollapsed = useUi((s) => s.listCollapsed);
    const navDrawerOpen = useUi((s) => s.navDrawerOpen);
    const workspaceSecondaryNoteId = useUi((s) => s.workspaceSecondaryNoteId);
    const workspaceSplitRatio = useUi((s) => s.workspaceSplitRatio);
    const toggleNav = useUi((s) => s.toggleNav);
    const toggleNavDrawer = useUi((s) => s.toggleNavDrawer);
    const setLayout = useUi((s) => s.setLayout);
    const workspaceGroupsRef = useRef<HTMLElement>(null);
    const isMobile = breakpoint === 'mobile';
    const isTablet = breakpoint === 'tablet';

    const showNav = !isMobile && !isTablet;
    const navAsDrawer = isTablet && navDrawerOpen;
    const showList = !listCollapsed && !isMobile;
    const showWorkspaceSplit = breakpoint === 'desktop' && Boolean(workspaceSecondaryNoteId);
    const effectiveWorkspaceSplitRatio = workspaceSplitRatio ?? 0.5;
    if (isMobile)
        return <MobileShell />;
    return (<div className="relative flex h-full min-h-0 overflow-hidden bg-[var(--bg-base)]">
      <div className="flex min-w-0 flex-1">
        {showNav && (<>
            <div style={{ width: navCollapsed ? 48 : navWidth }} className="shrink-0 overflow-hidden transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]">
              <Sidebar collapsed={navCollapsed} onCollapse={toggleNav}/>
            </div>
            {!navCollapsed && (<Resizer label={t("shell.resize_navigation_panel")} value={navWidth} min={PANEL_WIDTHS.navigation.min} max={PANEL_WIDTHS.navigation.max} onChange={(navWidth) => setLayout({ navWidth })} onReset={() => setLayout({ navWidth: PANEL_WIDTHS.navigation.min })}/>)}
          </>)}

        {showList && (<>
            <div style={{ width: listWidth }} className="anim-view-content shrink-0 overflow-hidden">
              <NoteList />
            </div>
            <Resizer label={t("shell.resize_note_list")} value={listWidth} min={PANEL_WIDTHS.noteList.min} max={PANEL_WIDTHS.noteList.max} onChange={(listWidth) => setLayout({ listWidth })} onReset={() => setLayout({ listWidth: PANEL_WIDTHS.noteList.min })}/>
          </>)}

        <main ref={workspaceGroupsRef} className="flex min-w-0 flex-1">
          <Suspense fallback={<WorkspaceFallback />}>
            {showWorkspaceSplit ? (<>
              <div className="min-w-0" style={{ width: `${effectiveWorkspaceSplitRatio * 100}%` }}>
                <InlineErrorBoundary><Workspace pane="primary" grouped/></InlineErrorBoundary>
              </div>
              <SplitResizer label={t("shell.resize_note_panes")} containerRef={workspaceGroupsRef} ratio={effectiveWorkspaceSplitRatio} onChange={(workspaceSplitRatio) => setLayout({ workspaceSplitRatio })} onReset={() => setLayout({ workspaceSplitRatio: null })}/>
              <div className="anim-view-content min-w-0 flex-1">
                <InlineErrorBoundary><Workspace pane="secondary" grouped/></InlineErrorBoundary>
              </div>
            </>) : (<div className="min-w-0 flex-1">
                <InlineErrorBoundary><Workspace /></InlineErrorBoundary>
              </div>)}
          </Suspense>
        </main>
      </div>

      <FloatingSearch />

      <Drawer open={navAsDrawer} onClose={() => toggleNavDrawer(false)} side="left" width={272} title={t("common.navigation")}>
        <Sidebar onCollapse={() => toggleNavDrawer(false)}/>
      </Drawer>

      <OverlayHost />
    </div>);
}

function MobileShell() {
    const pane = useUi((s) => s.mobilePane);
    const setPane = useUi((s) => s.setMobilePane);
    const activeNoteId = useUi((s) => s.activeNoteId);
    const notePane = pane === 'editor' || pane === 'preview';
    useEffect(() => {
        if (!activeNoteId && notePane)
            setPane('list');
    }, [activeNoteId, notePane, setPane]);
    const tabs = [
        { id: 'nav' as const, icon: <ListTree size={19}/>, label: t("common.navigation") },
        { id: 'list' as const, icon: <FileText size={19}/>, label: t("common.note") },
        ...(activeNoteId ? [
            { id: 'editor' as const, icon: <PencilLine size={19}/>, label: t("common.edit") },
            { id: 'preview' as const, icon: <Eye size={19}/>, label: t("common.preview") },
        ] : []),
    ];
    return (<div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)] pt-[env(safe-area-inset-top)]">
      <div className="relative min-h-0 flex-1">
        <div aria-hidden={pane !== 'nav'} inert={pane !== 'nav'} data-active={pane === 'nav' || undefined} className="mobile-pane-layer absolute inset-0">
          <Sidebar onCollapse={() => setPane('list')}/>
        </div>
        <div aria-hidden={pane !== 'list'} inert={pane !== 'list'} data-active={pane === 'list' || undefined} className="mobile-pane-layer absolute inset-0">
          <NoteList />
        </div>
        <div aria-hidden={!notePane} inert={!notePane} data-active={notePane || undefined} data-from="right" className="mobile-pane-layer absolute inset-0">
          {notePane && activeNoteId && (<Suspense fallback={<WorkspaceFallback />}><Workspace mobileLayout={pane === 'preview' ? 'preview' : 'edit'} onMobileBack={() => setPane('list')}/></Suspense>) }
        </div>
      </div>

      <FloatingSearch compact/>

      <nav aria-label={t("shell.mobile_navigation")} className="flex h-[calc(56px+env(safe-area-inset-bottom))] shrink-0 items-stretch justify-around border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] pb-[env(safe-area-inset-bottom)]">
        {tabs.map((tab) => (<button key={tab.id} type="button" aria-current={pane === tab.id ? 'page' : undefined} onClick={() => setPane(tab.id)} className={cn('flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors active:bg-[var(--bg-active)]', pane === tab.id ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]')}>
            <span className={cn('mobile-tab-icon', pane === tab.id && 'is-active')}>{tab.icon}</span>
            {tab.label}
          </button>))}
      </nav>

      <OverlayHost />
    </div>);
}
function WorkspaceFallback() {
    return (
        <div
            className="h-full min-w-0 flex-1 overflow-hidden bg-[var(--bg-editor)]"
            aria-busy="true"
            aria-label={t("workspace.loading_note_content")}
        >
            <EditorSkeleton />
        </div>
    );
}

function OverlayHost() {
    const panel = useUi((s) => s.panel);
    const closePanel = useUi((s) => s.closePanel);
    const lightbox = useUi((s) => s.lightbox);
    const role = useSession((s) => s.user?.role);
    const updateDialogOpen = useUpdate((s) => s.dialogOpen);
    return (<>
      <Suspense fallback={null}>
        {panel === 'command' && <CommandPalette onClose={closePanel}/>}
        {panel === 'settings' && <SettingsPanel onClose={closePanel}/>}
        {panel === 'shortcuts' && <ShortcutsPanel onClose={closePanel}/>}
        {panel === 'graph' && <GraphPanel onClose={closePanel}/>}
        {panel === 'share' && <SharePanel onClose={closePanel}/>}
        {panel === 'versions' && <VersionsPanel onClose={closePanel}/>}
        {panel === 'ai' && <AiPanel onClose={closePanel}/>}
        {lightbox && <Lightbox />}
      </Suspense>
      {role === 'owner' && updateDialogOpen && (<Suspense fallback={null}>
        <UpdateDialog />
      </Suspense>)}
    </>);
}

function useGlobalHotkeys(): void {
    useEffect(() => {


        const ui = () => useUi.getState();
        const notes = () => useNotes.getState();
        return registerAll([
            {
                id: 'command',
                combo: 'mod+k',
                description: () => t("common.command_palette"),
                group: () => t("shell.global"),
                allowInInput: true,
                handler: () => ui().togglePanel('command'),
            },
            {
                id: 'quick-open',
                combo: 'mod+p',
                description: () => t("shell.quick_open"),
                group: () => t("shell.global"),
                allowInInput: true,
                handler: () => ui().openPanel('command'),
            },
            {
                id: 'new-note',
                combo: 'mod+n',
                description: () => t("common.new_note"),
                group: () => t("shell.global"),
                allowInInput: true,
                handler: () => void createContextualNote(),
            },
            {
                id: 'search',
                combo: 'mod+shift+f',
                description: () => t("shell.search_all_notes"),
                group: () => t("shell.global"),
                allowInInput: true,
                handler: () => ui().openPanel('command'),
            },
            {
                id: 'settings',
                combo: 'mod+,',
                description: () => t("common.open_settings"),
                group: () => t("shell.global"),
                allowInInput: true,
                handler: () => ui().openPanel('settings'),
            },
            {
                id: 'toggle-list',
                combo: 'mod+shift+b',
                description: () => t("shell.collapse_expand_list"),
                group: () => t("common.interface"),
                allowInInput: true,
                handler: () => ui().toggleList(),
            },
            {
                id: 'cycle-layout',
                combo: 'mod+\\',
                description: () => t("shell.cycle_editor_split_preview"),
                group: () => t("common.interface"),
                allowInInput: true,
                handler: () => {
                    const order = ['edit', 'split', 'preview'] as const;
                    const uiState = ui();
                    if (uiState.workspaceSecondaryNoteId) {
                        const pane = uiState.activeWorkspacePane;
                        const current = order.indexOf(uiState.workspacePaneLayouts[pane]);
                        uiState.setWorkspacePaneLayout(pane, order[(current + 1) % order.length]);
                        return;
                    }
                    const session = useSession.getState();
                    const current = order.indexOf(session.settings.preview.layout);
                    void session.updateSettings({
                        preview: { layout: order[(current + 1) % order.length] },
                    });
                },
            },
            {
                id: 'shortcuts',
                combo: 'shift+?',
                description: () => t("shell.keyboard_shortcuts"),
                group: () => t("shell.global"),
                handler: () => ui().togglePanel('shortcuts'),
            },
            {
                id: 'save',
                combo: 'mod+s',
                description: () => t("shell.save_now"),
                group: () => t("common.edit"),
                allowInInput: true,
                handler: () => void notes().flush({ immediate: true }),
            },
            {
                id: 'star',
                combo: 'mod+d',
                description: () => t("shell.add_to_remove_from_favorites"),
                group: () => t("common.note"),
                handler: () => {
                    const id = ui().activeNoteId;
                    const note = id ? notes().notes[id] : null;
                    if (id && note)
                        void notes().patchNote(id, { isStarred: !note.isStarred });
                },
            },
            {
                id: 'delete',
                combo: 'mod+backspace',
                description: () => t("common.move_to_trash"),
                group: () => t("common.note"),
                handler: () => {
                    const id = ui().activeNoteId;
                    if (id)
                        void notes().deleteNote(id);
                },
            },
            {
                id: 'outline',
                combo: 'mod+shift+o',
                description: () => t("shell.show_hide_outline"),
                group: () => t("common.interface"),
                allowInInput: true,
                handler: () => ui().toggleOutline(),
            },
            {
                id: 'graph',
                combo: 'mod+shift+g',
                description: () => t("common.graph"),
                group: () => t("shell.global"),
                handler: () => ui().togglePanel('graph'),
            },
        ]);
    }, []);
}
