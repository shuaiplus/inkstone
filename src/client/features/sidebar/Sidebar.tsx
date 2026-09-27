import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowDown, ArrowUp, ChevronRight, Clock, CornerUpLeft, FilePlus2, FileText, FolderClosed, FolderInput, FolderOpen, FolderPlus, Hash, Inbox, LogOut, Moon, MoreHorizontal, Palette, PanelLeft, PanelLeftClose, Pencil, Plus, Settings, Star, Sun, Trash2, Waypoints, } from 'lucide-react';
import { LIMITS } from '@shared/constants';
import type { Tag, ViewKind } from '@shared/types';
import { compareTagNames } from '@shared/markdown-utils';
import { cn } from '../../lib/cn';
import { Avatar, IconButton, Logo, SectionLabel } from '../../components/primitives';
import { Menu, Tooltip, confirm, useContextMenu, type MenuItem } from '../../components/overlay';
import { switchThemeWithTransition, useUi } from '../../store/ui';
import { useSession } from '../../store/session';
import { useUpdate } from '../../store/update';
import { createContextualNote, useFolderTree, useNavigationCounts, useNotes, type FolderNode } from '../../store/notes';
import { folderDescendantIds, folderPath, folderPathLabel, openFolderView } from '../../lib/folders';
import { FolderAppearance, FolderPicker } from '../folders/FolderPicker';
import { TagAppearance } from '../tags/TagAppearance';
import { createTag, deleteTag, renameTag, setTagColor } from '../tags/tagMutations';
import { t } from "../../lib/i18n";
import { SearchButton } from '../shell/SearchButton';
export function Sidebar({ collapsed = false, onCollapse, }: {
    collapsed?: boolean;
    onCollapse?: () => void;
}) {
    const view = useUi((s) => s.view);
    const openView = useUi((s) => s.openView);
    const counts = useNavigationCounts();
    return (<>
        {collapsed ? <SidebarRail onExpand={onCollapse}/> : (<aside className="flex h-full min-h-0 flex-col bg-[var(--bg-sunken)]">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
        <div className="flex min-w-0 items-center gap-[9px] select-none">
          <Logo size={24}/>
          <span className="min-w-0 truncate font-serif text-[15.5px] font-semibold tracking-[0.02em] text-[var(--text-primary)]">
            {t("common.product_name")}
          </span>
        </div>
        {onCollapse && (<Tooltip label={t("sidebar.collapse_navigation")}>
            <IconButton label={t("sidebar.collapse_navigation")} size="sm" onClick={onCollapse}>
              <PanelLeftClose size={15}/>
            </IconButton>
          </Tooltip>)}
      </header>

      <div className="shrink-0 px-2 pt-2"><SearchButton /></div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4">
        <div className="space-y-px">
          <ViewItem icon={<FileText size={14}/>} label={t("navigation.all_notes")} view="all" count={counts.all} active={view === 'all'} onSelect={openView}/>
          <ViewItem icon={<Clock size={14}/>} label={t("navigation.recently_edited")} view="recent" active={view === 'recent'} onSelect={openView}/>
          <ViewItem icon={<Star size={14}/>} label={t("navigation.favorites")} view="starred" count={counts.starred} active={view === 'starred'} onSelect={openView}/>
          <ViewItem icon={<Inbox size={14}/>} label={t("navigation.unfiled")} view="unfiled" count={counts.unfiled} active={view === 'unfiled'} onSelect={openView}/>
        </div>

        <FolderSection />
        <TagSection />
      </div>

      <div className="shrink-0 space-y-px border-t border-[var(--border-subtle)] px-2 py-2">
        <ViewItem icon={<Archive size={14}/>} label={t("navigation.archive")} view="archived" count={counts.archived} active={view === 'archived'} onSelect={openView}/>
        <ViewItem icon={<Trash2 size={14}/>} label={t("navigation.trash")} view="trash" count={counts.trash} active={view === 'trash'} onSelect={openView}/>
      </div>

      <div className="shrink-0 border-t border-[var(--border-subtle)] p-2">
        <SidebarAccount />
      </div>
        </aside>)}
    </>);
}
function SidebarRail({ onExpand }: {
    onExpand?: () => void;
}) {
    const view = useUi((s) => s.view);
    const openView = useUi((s) => s.openView);
    return (<aside className="flex h-full min-h-0 flex-col items-center bg-[var(--bg-sunken)]">
      <div className="flex h-11 w-full shrink-0 items-center justify-center border-b border-[var(--border-subtle)]">
        <Tooltip label={t("sidebar.expand_navigation")} side="right">
          <IconButton label={t("sidebar.expand_navigation")} onClick={onExpand}>
            <PanelLeft size={16}/>
          </IconButton>
        </Tooltip>
      </div>

      <div className="flex w-full flex-col items-center gap-1 py-2">
        <SearchButton variant="icon" />
        <RailButton label={t("navigation.all_notes")} active={view === 'all'} icon={<FileText size={16}/>} onClick={() => openView('all')}/>
        <RailButton label={t("navigation.favorites")} active={view === 'starred'} icon={<Star size={16}/>} onClick={() => openView('starred')}/>
        <RailButton label={t("navigation.trash")} active={view === 'trash'} icon={<Trash2 size={16}/>} onClick={() => openView('trash')}/>
        <div className="my-1 h-px w-6 bg-[var(--border-subtle)]"/>
        <RailButton label={t("common.new_note")} combo="mod+n" accent icon={<FilePlus2 size={16}/>} onClick={() => void createContextualNote()}/>
      </div>

      <span className="flex-1"/>

      <div className="flex w-full shrink-0 justify-center border-t border-[var(--border-subtle)] py-2">
        <SidebarAccount rail/>
      </div>
    </aside>);
}
function RailButton({ label, combo, icon, active, accent, onClick, }: {
    label: string;
    combo?: string;
    icon: React.ReactNode;
    active?: boolean;
    accent?: boolean;
    onClick: () => void;
}) {
    return (<Tooltip label={label} combo={combo} side="right">
      <IconButton label={label} active={active} onClick={onClick} className={accent ? 'text-[var(--accent)]' : undefined}>
        {icon}
      </IconButton>
    </Tooltip>);
}
function SidebarAccount({ rail = false }: {
    rail?: boolean;
}) {
    const user = useSession((s) => s.user);
    const theme = useSession((s) => s.settings.appearance.theme);
    const updateSettings = useSession((s) => s.updateSettings);
    const logout = useSession((s) => s.logout);
    const openPanel = useUi((s) => s.openPanel);
    const updateAvailable = useUpdate((s) => s.available);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    if (!user)
        return null;
    const isDark = theme === 'dark' ||
        (theme === 'system' && document.documentElement.dataset.theme === 'dark');
    const displayName = user.name || user.username;
    const items: MenuItem[] = [
        {
            id: 'settings',
            label: t("common.settings"),
            icon: <SettingsIcon size={13} showDot={user.role === 'owner' && updateAvailable}/>,
            combo: 'mod+,',
            onSelect: () => openPanel('settings'),
        },
        {
            id: 'graph',
            label: t("common.graph"),
            icon: <Waypoints size={13}/>,
            combo: 'mod+shift+g',
            onSelect: () => openPanel('graph'),
        },
        {
            id: 'theme',
            label: isDark ? t("sidebar.switch_to_light") : t("sidebar.switch_to_dark"),
            icon: isDark ? <Sun size={13}/> : <Moon size={13}/>,
            separatorBefore: true,
            onSelect: () => {
                const rect = buttonRef.current?.getBoundingClientRect();
                const next = isDark ? 'light' : 'dark';
                switchThemeWithTransition(next, rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined, () => updateSettings({ appearance: { theme: next } }));
            },
        },
        {
            id: 'logout',
            label: t("sidebar.log_out"),
            icon: <LogOut size={13}/>,
            tone: 'danger',
            separatorBefore: true,
            onSelect: () => void logout(),
        },
    ];
    return (<>
      {rail ? (<Tooltip label={`${t("sidebar.account_and_settings")} · ${displayName}`} side="right">
          <button ref={buttonRef} type="button" onClick={() => setMenuOpen(true)} aria-label={t("sidebar.account_and_settings")} className="rounded-full transition-transform duration-[var(--dur-fast)] hover:scale-105 active:scale-95">
            <Avatar src={user.avatarUrl} name={displayName} size={28}/>
          </button>
        </Tooltip>) : (<div className="group flex h-11 w-full items-center rounded-[var(--r-md)] transition-colors hover:bg-[var(--bg-hover)]">
          <button ref={buttonRef} type="button" onClick={() => setMenuOpen(true)} aria-label={t("sidebar.account_and_settings")} className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-l-[var(--r-md)] pl-2 text-left">
            <Avatar src={user.avatarUrl} name={displayName} size={28}/>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold text-[var(--text-primary)]">
                {displayName}
              </span>
              <span className="block truncate text-[10.5px] text-[var(--text-quaternary)]">
                @{user.username}
              </span>
            </span>
          </button>
          <Tooltip label={t("common.settings")} side="top">
            <IconButton label={t("common.settings")} size="sm" onClick={() => openPanel('settings')} className="mr-1 shrink-0 text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]">
              <SettingsIcon size={14} showDot={user.role === 'owner' && updateAvailable}/>
            </IconButton>
          </Tooltip>
        </div>)}

      <Menu anchor={buttonRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={252}/>
    </>);
}
function SettingsIcon({ size, showDot }: {
    size: number;
    showDot: boolean;
}) {
    return (<span className="relative inline-flex">
      <Settings size={size}/>
      {showDot && (<span data-update-dot aria-hidden="true" className="absolute -top-1 -right-1 size-2 rounded-full border border-[var(--bg-sunken)] bg-[var(--danger)]"/>)}
    </span>);
}
function ViewItem({ icon, label, view, count, active, onSelect, }: {
    icon: React.ReactNode;
    label: string;
    view: ViewKind;
    count?: number;
    active: boolean;
    onSelect: (view: ViewKind) => void;
}) {
    const [dropping, setDropping] = useState(false);
    const patchNote = useNotes((s) => s.patchNote);
    const acceptsDrop = view === 'unfiled' || view === 'starred' || view === 'archived' || view === 'trash';
    const deleteNote = useNotes((s) => s.deleteNote);
    return (<button type="button" aria-current={active ? 'page' : undefined} onClick={() => onSelect(view)} onDragOver={(e) => {
            if (!acceptsDrop || !e.dataTransfer.types.includes('application/x-inkstone-note'))
                return;
            e.preventDefault();
            setDropping(true);
        }} onDragLeave={(e) => {
            if (leftDropTarget(e))
                setDropping(false);
        }} onDrop={(e) => {
            setDropping(false);
            const id = e.dataTransfer.getData('application/x-inkstone-note');
            if (!id)
                return;
            e.preventDefault();
            if (view === 'unfiled')
                void patchNote(id, { folderId: null });
            else if (view === 'starred')
                void patchNote(id, { isStarred: true });
            else if (view === 'archived')
                void patchNote(id, { isArchived: true });
            else if (view === 'trash')
                void deleteNote(id);
        }} className={cn('group relative flex h-10 w-full items-center gap-2.5 rounded-[var(--r-md)] px-2 text-left md:h-[30px]', 'transition-colors duration-[var(--dur-fast)]', active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]', dropping && 'ring-1 ring-[var(--accent)]')}>
      <span className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{label}</span>
      {count != null && count > 0 && (<span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]">{count}</span>)}
    </button>);
}
export function FolderSection() {
    const tree = useFolderTree();
    const folders = useNotes((s) => s.folders ?? []);
    const createFolder = useNotes((s) => s.createFolder);
    const patchFolder = useNotes((s) => s.patchFolder);
    const expandFolder = useUi((s) => s.expandFolder);
    const [creating, setCreating] = useState(false);
    const creatingRef = useRef(false);
    const createdTimerRef = useRef<number>(0);
    const [createdFolderId, setCreatedFolderId] = useState<string | null>(null);
    const movingIdsRef = useRef(new Set<string>());
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [movingId, setMovingId] = useState<string | null>(null);
    const [appearanceId, setAppearanceId] = useState<string | null>(null);
    const [rootDropping, setRootDropping] = useState(false);
    useEffect(() => () => window.clearTimeout(createdTimerRef.current), []);
    const create = (parentId: string | null) => {
        if (creatingRef.current)
            return;
        creatingRef.current = true;
        setCreating(true);
        const startingUi = useUi.getState();
        const startingNavigation = {
            view: startingUi.view,
            folderId: startingUi.folderId,
            tag: startingUi.tag,
            activeNoteId: startingUi.activeNoteId,
        };
        try {
            const folderId = createFolder({ parentId });
            if (!folderId)
                return;
            window.clearTimeout(createdTimerRef.current);
            setCreatedFolderId(folderId);
            createdTimerRef.current = window.setTimeout(() => setCreatedFolderId(null), 1000);
            const currentUi = useUi.getState();
            if (currentUi.view === startingNavigation.view &&
                currentUi.folderId === startingNavigation.folderId &&
                currentUi.tag === startingNavigation.tag &&
                currentUi.activeNoteId === startingNavigation.activeNoteId) {
                if (parentId)
                    expandFolder(parentId);
                openFolderView(useNotes.getState().folders ?? [], folderId);
                setRenamingId(folderId);
            }
        }
        finally {
            queueMicrotask(() => {
                creatingRef.current = false;
                setCreating(false);
            });
        }
    };
    const move = (id: string, parentId: string | null, beforeId: string | null) => {
        if (movingIdsRef.current.has(id))
            return false;
        movingIdsRef.current.add(id);
        try {
            if (!patchFolder(id, { parentId, beforeId }))
                return false;
            if (parentId)
                expandFolder(parentId);
            return true;
        }
        catch {
            return false;
        }
        finally {
            movingIdsRef.current.delete(id);
        }
    };
    const movingFolder = movingId ? folders.find((folder) => folder.id === movingId) ?? null : null;
    const appearanceFolder = appearanceId ? folders.find((folder) => folder.id === appearanceId) ?? null : null;
    const excludedMoveTargets = useMemo(() => {
        if (!movingId)
            return undefined;
        const excluded = folderDescendantIds(folders, movingId);
        const movingDepth = Math.max(0, folderPath(folders, movingId).length - 1);
        const relativeSubtreeDepth = Math.max(0, ...[...excluded].map((id) => Math.max(0, folderPath(folders, id).length - 1 - movingDepth)));
        for (const candidate of folders) {
            const movedRootDepth = folderPath(folders, candidate.id).length;
            if (movedRootDepth + relativeSubtreeDepth >= LIMITS.folderDepthMax)
                excluded.add(candidate.id);
        }
        return excluded;
    }, [folders, movingId]);
    return (<>
      <section className={cn('mt-4 rounded-[var(--r-md)]', rootDropping && 'ring-1 ring-[var(--accent)]')} onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('application/x-inkstone-folder'))
                return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setRootDropping(true);
        }} onDragLeave={(event) => {
            if (leftDropTarget(event))
                setRootDropping(false);
        }} onDrop={(event) => {
            const folderId = event.dataTransfer.getData('application/x-inkstone-folder');
            if (!folderId)
                return;
            event.preventDefault();
            setRootDropping(false);
            void move(folderId, null, null);
        }}>
      <div className="group/head flex items-center justify-between pr-1">
        <SectionLabel>{t("navigation.folder")}</SectionLabel>
        <Tooltip label={t("common.new_folder")}>
          <IconButton label={t("common.new_folder")} size="sm" disabled={creating} onClick={() => void create(null)} className="opacity-100 transition-opacity md:opacity-0 md:group-hover/head:opacity-100 md:focus-visible:opacity-100">
            <FolderPlus size={13}/>
          </IconButton>
        </Tooltip>
      </div>

      {tree.length === 0 ? (<button type="button" disabled={creating} onClick={() => void create(null)} className="mt-0.5 flex h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-[12px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] disabled:pointer-events-none disabled:opacity-45 md:h-[30px]">
          <FolderPlus size={13}/>{t("sidebar.create_first_folder")}</button>) : (<div role="tree" aria-label={t("navigation.folder")} className="mt-0.5 space-y-px">
          {tree.map((node, index) => (<FolderRow key={node.id} node={node} siblings={tree} index={index} parentNode={null} parentSiblings={[]} onCreateChild={create} onMove={move} onChooseParent={setMovingId} onEditAppearance={setAppearanceId} createdFolderId={createdFolderId} renamingId={renamingId} onStartRename={setRenamingId} onFinishRename={() => setRenamingId(null)}/>))}
        </div>)}
      </section>
      <FolderPicker open={Boolean(movingFolder)} title={t("folders.choose_parent")} folders={folders} currentId={movingFolder?.parentId ?? null} excludedIds={excludedMoveTargets} onSelect={(parentId) => {
            if (movingId)
                void move(movingId, parentId, null);
        }} onClose={() => setMovingId(null)}/>
      <FolderAppearance open={Boolean(appearanceFolder)} folder={appearanceFolder} onChange={(patch) => {
            if (appearanceId)
                patchFolder(appearanceId, patch);
        }} onClose={() => setAppearanceId(null)}/>
    </>);
}
function FolderRow({ node, siblings, index, parentNode, parentSiblings, onCreateChild, onMove, onChooseParent, onEditAppearance, createdFolderId, renamingId, onStartRename, onFinishRename, }: {
    node: FolderNode;
    siblings: FolderNode[];
    index: number;
    parentNode: FolderNode | null;
    parentSiblings: FolderNode[];
    onCreateChild: (parentId: string | null) => void;
    onMove: (id: string, parentId: string | null, beforeId: string | null) => boolean;
    onChooseParent: (id: string) => void;
    onEditAppearance: (id: string) => void;
    createdFolderId: string | null;
    renamingId: string | null;
    onStartRename: (id: string) => void;
    onFinishRename: () => void;
}) {
    const view = useUi((s) => s.view);
    const activeFolderId = useUi((s) => s.folderId);
    const expanded = useUi((s) => s.expandedFolders.includes(node.id));
    const toggleFolder = useUi((s) => s.toggleFolder);
    const folders = useNotes((s) => s.folders ?? []);
    const patchFolder = useNotes((s) => s.patchFolder);
    const deleteFolder = useNotes((s) => s.deleteFolder);
    const patchNote = useNotes((s) => s.patchNote);
    const directNoteCount = useNotes((s) => Object.values(s.notes ?? {}).filter((note) => note.folderId === node.id).length);
    const [dropState, setDropState] = useState<'none' | 'before' | 'inside' | 'after'>('none');
    const menu = useContextMenu();
    const buttonRef = useRef<HTMLDivElement>(null);
    const removingRef = useRef(false);
    const renamingRef = useRef(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const active = view === 'folder' && activeFolderId === node.id;
    const hasChildren = node.children.length > 0;
    const justCreated = createdFolderId === node.id;
    const [childrenMounted, setChildrenMounted] = useState(expanded && hasChildren);
    const [childrenVisible, setChildrenVisible] = useState(expanded && hasChildren);
    const renaming = renamingId === node.id;
    const canCreateChild = node.depth + 1 < LIMITS.folderDepthMax;
    useEffect(() => {
        if (!hasChildren) {
            setChildrenVisible(false);
            setChildrenMounted(false);
            return;
        }
        if (expanded) {
            setChildrenMounted(true);
            const openTimer = window.setTimeout(() => setChildrenVisible(true), 0);
            return () => window.clearTimeout(openTimer);
        }
        setChildrenVisible(false);
        const closeTimer = window.setTimeout(() => setChildrenMounted(false), 340);
        return () => window.clearTimeout(closeTimer);
    }, [expanded, hasChildren]);
    const rename = (name: string) => {
        const trimmed = name.trim();
        if (!trimmed || trimmed === node.name) {
            onFinishRename();
            return;
        }
        if (renamingRef.current)
            return;
        renamingRef.current = true;
        onFinishRename();
        patchFolder(node.id, { name: trimmed });
        queueMicrotask(() => {
            renamingRef.current = false;
        });
    };
    const remove = async () => {
        if (removingRef.current)
            return;
        removingRef.current = true;
        try {
            const hasContent = directNoteCount > 0 || hasChildren;
            const ok = await confirm({
                title: t("sidebar.delete_folder_value0", { value0: node.name }),
                description: hasContent
                    ? t("folders.delete_contents_move_up", { value0: directNoteCount, value1: node.children.length }) : t("sidebar.this_folder_is_empty"),
                confirmLabel: t("common.delete"),
                tone: 'danger',
            });
            if (!ok)
                return;
            deleteFolder(node.id);
        }
        finally {
            removingRef.current = false;
        }
    };
    const moveEarlier = () => {
        const previous = siblings[index - 1];
        if (previous)
            void onMove(node.id, node.parentId, previous.id);
    };
    const moveLater = () => {
        if (index >= siblings.length - 1)
            return;
        void onMove(node.id, node.parentId, siblings[index + 2]?.id ?? null);
    };
    const moveOut = () => {
        if (!parentNode)
            return;
        const parentIndex = parentSiblings.findIndex((folder) => folder.id === parentNode.id);
        if (parentIndex < 0)
            return;
        void onMove(node.id, parentNode.parentId, parentSiblings[parentIndex + 1]?.id ?? null);
    };
    const menuItems: MenuItem[] = [
        { id: 'rename', label: t("sidebar.rename"), onSelect: () => onStartRename(node.id) },
        { id: 'new-note', label: t("sidebar.create_new_note_here"), icon: <FilePlus2 size={13}/>, onSelect: () => void useNotes.getState().createNote({ folderId: node.id }) },
        { id: 'new-child', label: t("sidebar.new_subfolder"), icon: <FolderPlus size={13}/>, disabled: !canCreateChild, onSelect: () => onCreateChild(node.id) },
        { id: 'appearance', label: t("folders.appearance"), icon: <Palette size={13}/>, onSelect: () => onEditAppearance(node.id) },
        { id: 'move-to', label: t("folders.move_to"), icon: <FolderInput size={13}/>, separatorBefore: true, onSelect: () => onChooseParent(node.id) },
        { id: 'move-earlier', label: t("sidebar.move_earlier"), icon: <ArrowUp size={13}/>, disabled: index === 0, onSelect: moveEarlier },
        { id: 'move-later', label: t("sidebar.move_later"), icon: <ArrowDown size={13}/>, disabled: index === siblings.length - 1, onSelect: moveLater },
        { id: 'move-out', label: t("sidebar.move_out_one_level"), icon: <CornerUpLeft size={13}/>, disabled: !parentNode, onSelect: moveOut },
        { id: 'delete', label: t("sidebar.delete_folder"), icon: <Trash2 size={13}/>, tone: 'danger', separatorBefore: true, onSelect: () => void remove() },
    ];
    return (<div role="treeitem" aria-level={node.depth + 1} aria-expanded={hasChildren ? expanded : undefined} className={cn(justCreated && 'anim-tree-item-enter')} data-new-folder={justCreated || undefined}>
      <div ref={buttonRef} onContextMenu={(event) => {
            setMenuOpen(false);
            menu.onContextMenu(event);
        }} onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('application/x-inkstone-note') &&
                !e.dataTransfer.types.includes('application/x-inkstone-folder'))
                return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            if (e.dataTransfer.types.includes('application/x-inkstone-note')) {
                setDropState('inside');
                return;
            }
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = rect.height ? (e.clientY - rect.top) / rect.height : 0.5;
            setDropState(ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'inside');
        }} onDragLeave={(e) => {
            if (leftDropTarget(e))
                setDropState('none');
        }} onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropState('none');
            const noteId = e.dataTransfer.getData('application/x-inkstone-note');
            if (noteId) {
                void patchNote(noteId, { folderId: node.id });
                return;
            }
            const folderId = e.dataTransfer.getData('application/x-inkstone-folder');
            if (folderId && folderId !== node.id) {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = rect.height ? (e.clientY - rect.top) / rect.height : 0.5;
                const placement = dropState === 'none'
                    ? ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'inside'
                    : dropState;
                if (placement === 'before')
                    void onMove(folderId, node.parentId, node.id);
                else if (placement === 'after')
                    void onMove(folderId, node.parentId, siblings[index + 1]?.id ?? null);
                else
                    void onMove(folderId, node.id, null);
            }
        }} draggable={!renaming} onDragStart={(e) => {
            e.dataTransfer.setData('application/x-inkstone-folder', node.id);
            e.dataTransfer.effectAllowed = 'move';
        }} className={cn('group relative flex h-10 items-center gap-1 rounded-[var(--r-md)] pr-1 md:h-[30px]', 'transition-colors duration-[var(--dur-fast)]', active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]', dropState === 'inside' && 'ring-1 ring-[var(--accent)]')} style={{ paddingLeft: 6 + node.depth * 13 }}>
        {dropState === 'before' && <span aria-hidden="true" className="pointer-events-none absolute top-0 right-1 left-1 h-px bg-[var(--accent)]"/>}
        {dropState === 'after' && <span aria-hidden="true" className="pointer-events-none absolute right-1 bottom-0 left-1 h-px bg-[var(--accent)]"/>}
        <Tooltip label={expanded ? t("sidebar.collapse") : t("sidebar.expand")} side="right">
          <button type="button" disabled={!hasChildren} aria-hidden={!hasChildren || undefined} tabIndex={hasChildren ? undefined : -1} onClick={(e) => {
                e.stopPropagation();
                toggleFolder(node.id);
            }} aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")} className={cn('flex size-8 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] md:size-4', 'transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]', expanded && 'rotate-90', !hasChildren && 'invisible')}>
            <ChevronRight size={12}/>
          </button>
        </Tooltip>

        <span className={cn('shrink-0', active && !node.color ? 'text-[var(--accent)]' : !node.color && 'text-[var(--text-tertiary)]')} style={{ color: node.color ?? undefined }}>
          {node.icon ? (<span className={cn('text-[13px] leading-none', justCreated && 'anim-mark-enter')}>{node.icon}</span>) : (<FolderMotionIcon open={expanded && hasChildren} drawing={justCreated}/>)}
        </span>

        {renaming ? (<input aria-label={t("sidebar.rename")} autoFocus defaultValue={node.name} onBlur={(e) => void rename(e.target.value)} onKeyDown={(e) => {
                if (e.key === 'Enter')
                    void rename(e.currentTarget.value);
                if (e.key === 'Escape') {
                    e.currentTarget.value = node.name;
                    onFinishRename();
                }
                e.stopPropagation();
            }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>) : (<Tooltip label={folderPathLabel(folders, node.id)} side="right">
            <button data-navigation-item type="button" aria-current={active ? 'page' : undefined} onClick={() => openFolderView(folders, node.id)} onDoubleClick={() => onStartRename(node.id)} className="min-w-0 flex-1 truncate py-1 text-left text-[12.5px] font-medium">
              {node.name}
            </button>
          </Tooltip>)}

        {!renaming && (<>
            <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)] transition-opacity group-hover:opacity-0">
              {node.totalNotes > 0 ? node.totalNotes : ''}
            </span>
            <Tooltip label={t("common.more_actions")} side="left">
              <IconButton label={t("common.more_actions")} size="sm" onClick={(e) => {
                    e.stopPropagation();
                    menu.close();
                    setMenuOpen(true);
                }} className="absolute right-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100">
                <MoreHorizontal size={13}/>
              </IconButton>
            </Tooltip>
          </>)}
      </div>

      {childrenMounted && (<div role="group" aria-hidden={!childrenVisible} inert={!childrenVisible} className={cn('folder-children-grid', childrenVisible && 'is-expanded')}>
          <div className="min-h-0 space-y-px overflow-hidden">
            {node.children.map((child, childIndex) => (<FolderRow key={child.id} node={child} siblings={node.children} index={childIndex} parentNode={node} parentSiblings={siblings} onCreateChild={onCreateChild} onMove={onMove} onChooseParent={onChooseParent} onEditAppearance={onEditAppearance} createdFolderId={createdFolderId} renamingId={renamingId} onStartRename={onStartRename} onFinishRename={onFinishRename}/>))}
          </div>
        </div>)}

      <Menu anchor={buttonRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems}/>
      {menu.point && (<Menu anchor={menu.point} open onClose={menu.close} items={menuItems}/>)}
    </div>);
}
function FolderMotionIcon({ open, drawing }: {
    open: boolean;
    drawing: boolean;
}) {
    return (<span aria-hidden="true" data-open={open || undefined} data-drawing={drawing || undefined} className="folder-motion-icon">
      <FolderClosed size={14} className="folder-motion-icon__closed"/>
      <FolderOpen size={14} className="folder-motion-icon__open"/>
    </span>);
}
export function TagSection() {
    const tags = useNotes((s) => s.tags);
    const view = useUi((s) => s.view);
    const activeTag = useUi((s) => s.tag);
    const openView = useUi((s) => s.openView);
    const [expanded, setExpanded] = useState(false);
    const [creating, setCreating] = useState(false);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [appearanceId, setAppearanceId] = useState<string | null>(null);
    const sortedTags = useMemo(() => [...tags]
            .sort((a, b) => b.count - a.count || compareTagNames(a.name, b.name)), [tags]);
    const visible = expanded ? sortedTags : sortedTags.slice(0, 8);
    const appearanceTag = appearanceId
        ? tags.find((tag) => tag.id === appearanceId) ?? null
        : null;
    const finishCreate = (value: string) => {
        setCreating(false);
        const id = createTag(value);
        if (!id)
            return;
        const tag = useNotes.getState().tags.find((candidate) => candidate.id === id);
        if (tag)
            openView('tag', { tag: tag.name });
    };
    return (<>
      <section className="mt-4">
      <div className="group/head flex items-center justify-between pr-1">
        <SectionLabel>{t("navigation.tag")}</SectionLabel>
        <Tooltip label={t("tags.new")} side="right">
          <IconButton label={t("tags.new")} size="sm" onClick={() => setCreating(true)} className="opacity-100 transition-opacity md:opacity-0 md:group-hover/head:opacity-100 md:focus-visible:opacity-100">
            <Plus size={13}/>
          </IconButton>
        </Tooltip>
      </div>
      <div className="mt-0.5 space-y-px">
        {creating && <TagDraftRow onFinish={finishCreate} onCancel={() => setCreating(false)}/>}
        {!sortedTags.length && !creating && (<button type="button" onClick={() => setCreating(true)} className="flex h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[11.5px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] md:h-[30px]">
            <Plus size={13}/>{t("tags.create_first")}
          </button>)}
        {visible.map((tag) => (<TagRow key={tag.id} tag={tag} active={view === 'tag' && activeTag === tag.name} renaming={renamingId === tag.id} onOpen={() => openView('tag', { tag: tag.name })} onStartRename={() => setRenamingId(tag.id)} onFinishRename={(value) => {
            setRenamingId(null);
            void renameTag(tag, value);
        }} onCancelRename={() => setRenamingId(null)} onEditColor={() => setAppearanceId(tag.id)}/>))}

        {sortedTags.length > 8 && (<button type="button" onClick={() => setExpanded((v) => !v)} className="h-10 w-full rounded-[var(--r-md)] px-2 text-left text-[11.5px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] md:h-[26px]">
            {expanded ? t("common.collapse") : t("sidebar.show_all_value0_tags", { value0: sortedTags.length })}
          </button>)}
      </div>
      </section>
      <TagAppearance open={Boolean(appearanceTag)} tag={appearanceTag} onChange={(color) => {
            if (appearanceTag)
                void setTagColor(appearanceTag, color);
        }} onClose={() => setAppearanceId(null)}/>
    </>);
}
function TagDraftRow({ onFinish, onCancel }: {
    onFinish: (value: string) => void;
    onCancel: () => void;
}) {
    const finishedRef = useRef(false);
    const finish = (value: string) => {
        if (finishedRef.current)
            return;
        finishedRef.current = true;
        onFinish(value);
    };
    return (<div className="flex h-10 items-center gap-2 rounded-[var(--r-md)] px-2 md:h-[30px]">
      <Hash size={13} className="shrink-0 text-[var(--text-quaternary)]"/>
      <input aria-label={t("tags.new")} autoFocus placeholder={t("tags.new_placeholder")} onBlur={(event) => {
            if (event.currentTarget.value.trim())
                finish(event.currentTarget.value);
            else
                onCancel();
        }} onKeyDown={(event) => {
            if (event.key === 'Enter')
                finish(event.currentTarget.value);
            if (event.key === 'Escape') {
                finishedRef.current = true;
                onCancel();
            }
            event.stopPropagation();
        }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>
    </div>);
}
function TagRow({ tag, active, renaming, onOpen, onStartRename, onFinishRename, onCancelRename, onEditColor, }: {
    tag: Tag;
    active: boolean;
    renaming: boolean;
    onOpen: () => void;
    onStartRename: () => void;
    onFinishRename: (value: string) => void;
    onCancelRename: () => void;
    onEditColor: () => void;
}) {
    const menu = useContextMenu();
    const rowRef = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const finishedRef = useRef(false);
    const finishRename = (value: string) => {
        if (finishedRef.current)
            return;
        finishedRef.current = true;
        onFinishRename(value);
    };
    const menuItems: MenuItem[] = [
        { id: 'rename', label: t("tags.rename"), icon: <Pencil size={13}/>, onSelect: onStartRename },
        { id: 'color', label: t("tags.color"), icon: <Palette size={13}/>, onSelect: onEditColor },
        { id: 'delete', label: t("tags.delete"), icon: <Trash2 size={13}/>, tone: 'danger', separatorBefore: true, onSelect: () => void deleteTag(tag) },
    ];
    return (<div ref={rowRef} onContextMenu={(event) => {
            setMenuOpen(false);
            menu.onContextMenu(event);
        }} className={cn('group relative flex h-10 items-center gap-2 rounded-[var(--r-md)] px-2 md:h-[30px]', 'transition-colors duration-[var(--dur-fast)]', active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
      <Hash size={13} className="shrink-0" style={{ color: tag.color ?? (active ? 'var(--accent)' : 'var(--text-quaternary)') }}/>
      {renaming ? (<input aria-label={t("tags.rename")} autoFocus defaultValue={tag.name} onFocus={() => {
            finishedRef.current = false;
        }} onBlur={(event) => finishRename(event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key === 'Enter')
                finishRename(event.currentTarget.value);
            if (event.key === 'Escape') {
                finishedRef.current = true;
                onCancelRename();
            }
            event.stopPropagation();
        }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>) : (<button data-navigation-item type="button" aria-current={active ? 'page' : undefined} onClick={onOpen} onDoubleClick={onStartRename} className="min-w-0 flex-1 truncate py-1 text-left text-[12.5px] font-medium">
          {tag.name}
        </button>)}
      {!renaming && (<>
          <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)] transition-opacity group-hover:opacity-0">
            {tag.count > 0 ? tag.count : ''}
          </span>
          <Tooltip label={t("common.more_actions")} side="left">
            <IconButton label={t("common.more_actions")} size="sm" onClick={(event) => {
                event.stopPropagation();
                menu.close();
                setMenuOpen(true);
            }} className="absolute right-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100">
              <MoreHorizontal size={13}/>
            </IconButton>
          </Tooltip>
        </>)}
      <Menu anchor={rowRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems}/>
      {menu.point && (<Menu anchor={menu.point} open onClose={menu.close} items={menuItems}/>)}
    </div>);
}
function leftDropTarget(event: React.DragEvent<HTMLElement>): boolean {
    const next = event.relatedTarget;
    return !(next instanceof Node) || !event.currentTarget.contains(next);
}
