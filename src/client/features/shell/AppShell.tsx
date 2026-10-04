import { lazy, Suspense, useEffect, useRef } from 'react';
import { Eye, FileText, PanelLeft, PencilLine, UserRound } from 'lucide-react';
import { cn } from '../../lib/cn';
import { registerAll } from '../../lib/hotkeys';
import { APP_SHORTCUTS } from '../../lib/shortcuts';
import { useBreakpoint } from '../../lib/hooks';
import { useSyncEngine } from '../../lib/sync';
import { Drawer } from '../../components/overlay';
import { IconButton } from '../../components/primitives';
import { InlineErrorBoundary } from '../../components/ErrorBoundary';
import { EditorSkeleton } from '../../components/feedback';
import { PANEL_WIDTHS, useUi } from '../../store/ui';
import { createContextualNote, useNotes } from '../../store/notes';
import { useSession } from '../../store/session';
import { useUpdate } from '../../store/update';
import { Sidebar } from '../sidebar/Sidebar';
import { NoteList } from '../list/NoteList';
import { SearchButton } from './SearchButton';
import { MobileAccount } from './MobileAccount';
import { Resizer, SplitResizer } from './Resizer';
import { t } from "../../lib/i18n";
import { SettingsPanel } from '../settings/SettingsPanel';
import { scheduleSettingsWarmup } from '../settings/sections';
const Workspace = lazy(() => import('../workspace/Workspace').then((m) => ({ default: m.Workspace })));
const CommandPalette = lazy(() => import('../command/CommandPalette').then((m) => ({ default: m.CommandPalette })));
const ShortcutsPanel = lazy(() => import('../command/ShortcutsPanel').then((m) => ({ default: m.ShortcutsPanel })));
const GraphPanel = lazy(() => import('../graph/GraphPanel').then((m) => ({ default: m.GraphPanel })));
const SharePanel = lazy(() => import('../share/SharePanel').then((m) => ({ default: m.SharePanel })));
const VersionsPanel = lazy(() => import('../workspace/VersionsPanel').then((m) => ({ default: m.VersionsPanel })));
const Lightbox = lazy(() => import('../preview/Lightbox').then((m) => ({ default: m.Lightbox })));
const UpdateDialog = lazy(() => import('../update/UpdateDialog').then((m) => ({ default: m.UpdateDialog })));
export function AppShell() {
    const breakpoint = useBreakpoint();
    const role = useSession((s) => s.user?.role);
    const userId = useSession((s) => s.user?.id);
    useEffect(() => scheduleSettingsWarmup(), [userId]);
    const checkForUpdates = useUpdate((s) => s.check);
    useSyncEngine();
    useGlobalHotkeys();
    const hydrated = useNotes((s) => s.hydrated);
    const loading = useNotes((s) => s.loading);
    const openNote = useNotes((s) => s.openNote);
    const deepLinkHandled = useRef(false);
    useEffect(() => {
        if (!hydrated || loading || deepLinkHandled.current)
            return;
        deepLinkHandled.current = true;
        const match = /^\/n\/([0-9a-hjkmnp-tv-z]{26})\/?$/.exec(location.pathname);
        if (!match)
            return;
        useUi.getState().openExplorer();
        void openNote(match[1]!);
    }, [hydrated, loading, openNote]);
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
    return (<div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-base)]">
      {isTablet && (<div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <IconButton label={t('common.navigation')} onClick={() => toggleNavDrawer(true)}><PanelLeft size={16}/></IconButton>
        <div className="w-full max-w-sm"><SearchButton /></div>
      </div>)}
      <div className="flex min-h-0 min-w-0 flex-1">
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
        if (pane === 'nav' || (!activeNoteId && notePane))
            setPane('list');
    }, [activeNoteId, notePane, pane, setPane]);
    const tabs = [
        { id: 'list' as const, icon: <FileText size={19}/>, label: t("common.note") },
        { id: 'editor' as const, icon: <PencilLine size={19}/>, label: t("common.edit") },
        { id: 'preview' as const, icon: <Eye size={19}/>, label: t('mobile.view') },
        { id: 'account' as const, icon: <UserRound size={19}/>, label: t('mobile.account') },
    ];
    return (<div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)] pt-[env(safe-area-inset-top)]">
      <div className="relative min-h-0 flex-1">
        <div aria-hidden={pane !== 'account'} inert={pane !== 'account'} data-active={pane === 'account' || undefined} className="mobile-pane-layer absolute inset-0">
          {pane === 'account' && <MobileAccount />}
        </div>
        <div aria-hidden={pane !== 'list'} inert={pane !== 'list'} data-active={pane === 'list' || undefined} className="mobile-pane-layer absolute inset-0">
          <NoteList />
        </div>
        <div aria-hidden={!notePane} inert={!notePane} data-active={notePane || undefined} data-from="right" className="mobile-pane-layer absolute inset-0">
          {notePane && activeNoteId && (<Suspense fallback={<WorkspaceFallback />}><Workspace onMobileBack={() => setPane('list')}/></Suspense>) }
        </div>
      </div>

      <nav aria-label={t("shell.mobile_navigation")} className="mobile-bottom-nav flex h-[calc(64px+env(safe-area-inset-bottom))] shrink-0 items-stretch justify-around border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] pb-[env(safe-area-inset-bottom)]">
        {tabs.map((tab) => (<button key={tab.id} type="button" disabled={!activeNoteId && (tab.id === 'editor' || tab.id === 'preview')} aria-current={pane === tab.id ? 'page' : undefined} onClick={() => setPane(tab.id)} className={cn('flex min-w-0 flex-1 items-center justify-center text-[12px] transition-colors disabled:opacity-40', pane === tab.id ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
            <span className="mobile-tab-content">{tab.icon}<span>{tab.label}</span></span>
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
    const userId = useSession((s) => s.user?.id);
    const panel = useUi((s) => s.panel);
    const closePanel = useUi((s) => s.closePanel);
    const lightbox = useUi((s) => s.lightbox);
    const role = useSession((s) => s.user?.role);
    const updateDialogOpen = useUpdate((s) => s.dialogOpen);
    return (<>
      {panel === 'settings' && <SettingsPanel key={userId} onClose={closePanel}/>}
      <Suspense fallback={null}>
        {(panel === 'command' || panel === 'search') && <CommandPalette key={panel} initialQuery={panel === 'command' ? '> ' : ''} onClose={closePanel}/>}
        {panel === 'shortcuts' && <ShortcutsPanel onClose={closePanel}/>}
        {panel === 'graph' && <GraphPanel onClose={closePanel}/>}
        {panel === 'share' && <SharePanel onClose={closePanel}/>}
        {panel === 'versions' && <VersionsPanel onClose={closePanel}/>}
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
        const hasNote = () => {
            const id = ui().activeNoteId;
            return Boolean(id && notes().notes[id] && !notes().notes[id].deletedAt);
        };
        return registerAll([
            {
                id: 'command',
                combo: APP_SHORTCUTS.command,
                description: () => t("common.command_palette"),
                group: () => t("shell.global"),
                allowInInput: true,
                allowInOverlay: true,
                handler: () => ui().togglePanel('command'),
            },
            {
                id: 'new-note',
                combo: APP_SHORTCUTS.newNote,
                description: () => t("common.new_note"),
                group: () => t("shell.global"),
                allowInInput: true,
                handler: () => void createContextualNote(),
            },
            {
                id: 'search',
                combo: APP_SHORTCUTS.search,
                description: () => t("shell.search_all_notes"),
                group: () => t("shell.global"),
                allowInInput: true,
                allowInOverlay: true,
                handler: () => ui().openSearchList(),
            },
            {
                id: 'settings',
                combo: APP_SHORTCUTS.settings,
                description: () => t("common.open_settings"),
                group: () => t("shell.global"),
                allowInInput: true,
                handler: () => ui().openPanel('settings'),
            },
            {
                id: 'toggle-list',
                combo: APP_SHORTCUTS.toggleList,
                description: () => t("shell.collapse_expand_list"),
                group: () => t("common.interface"),
                allowInInput: true,
                handler: () => ui().toggleList(),
            },
            {
                id: 'cycle-layout',
                combo: APP_SHORTCUTS.cycleLayout,
                description: () => t("shell.cycle_editor_split_preview"),
                group: () => t("common.interface"),
                allowInInput: true,
                enabled: hasNote,
                handler: () => {
                    const order = ['live', 'split', 'preview'] as const;
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
                combo: APP_SHORTCUTS.shortcuts,
                description: () => t("shell.keyboard_shortcuts"),
                group: () => t("shell.global"),
                allowInInput: true,
                allowInOverlay: true,
                handler: () => ui().togglePanel('shortcuts'),
            },
            {
                id: 'save',
                combo: APP_SHORTCUTS.save,
                description: () => t("shell.save_now"),
                group: () => t("common.edit"),
                allowInInput: true,
                allowInOverlay: true,
                handler: () => void notes().flush({ immediate: true }),
            },
            {
                id: 'star',
                combo: APP_SHORTCUTS.star,
                description: () => t("shell.add_to_remove_from_favorites"),
                group: () => t("common.note"),
                allowInInput: true,
                enabled: hasNote,
                handler: () => {
                    const id = ui().activeNoteId;
                    const note = id ? notes().notes[id] : null;
                    if (id && note)
                        void notes().patchNote(id, { isStarred: !note.isStarred });
                },
            },
            {
                id: 'outline',
                combo: APP_SHORTCUTS.outline,
                description: () => t("shell.show_hide_outline"),
                group: () => t("common.interface"),
                allowInInput: true,
                enabled: hasNote,
                handler: () => ui().toggleOutline(),
            },
        ]);
    }, []);
}
