import { useRef, useState } from 'react';
import { Archive, Columns2, FileText, FolderInput, MoreHorizontal, Star, Trash2 } from 'lucide-react';
import type { Folder, NoteSummary } from '@shared/types';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { IconButton } from '../../components/primitives';
import { Menu, useContextMenu, type MenuItem } from '../../components/overlay';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { FolderPicker } from '../folders/FolderPicker';

export function groupExplorerNotes(notes: Record<string, NoteSummary>, folders: Folder[], locale: string): Map<string | null, NoteSummary[]> {
    const folderIds = new Set(folders.map((folder) => folder.id));
    const groups = new Map<string | null, NoteSummary[]>();
    for (const note of Object.values(notes)) {
        if (note.deletedAt || note.isArchived) continue;
        const parent = note.folderId && folderIds.has(note.folderId) ? note.folderId : null;
        const siblings = groups.get(parent) ?? [];
        siblings.push(note);
        groups.set(parent, siblings);
    }
    for (const siblings of groups.values()) {
        siblings.sort((a, b) => a.title.localeCompare(b.title, locale, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id));
    }
    return groups;
}

export function ExplorerNote({ note, depth, canOpenToSide }: { note: NoteSummary; depth: number; canOpenToSide: boolean }) {
    const active = useUi((s) => s.activeNoteId === note.id);
    const openNote = useNotes((s) => s.openNote);
    const patchNote = useNotes((s) => s.patchNote);
    const deleteNote = useNotes((s) => s.deleteNote);
    const folders = useNotes((s) => s.folders);
    const anchor = useRef<HTMLDivElement>(null);
    const contextMenu = useContextMenu();
    const [menuOpen, setMenuOpen] = useState(false);
    const [moving, setMoving] = useState(false);
    const open = (side = false) => {
        useUi.getState().openExplorer(folders.some((folder) => folder.id === note.folderId) ? note.folderId : null);
        void openNote(note.id, side ? { pane: 'secondary' } : undefined);
    };
    const items: MenuItem[] = [
        ...(canOpenToSide ? [{ id: 'side', label: t('notes.open_to_side'), icon: <Columns2 size={13}/>, onSelect: () => open(true) }] : []),
        { id: 'star', label: note.isStarred ? t('common.remove_from_favorites') : t('navigation.favorites'), icon: <Star size={13}/>, onSelect: () => void patchNote(note.id, { isStarred: !note.isStarred }) },
        { id: 'move', label: t('notes.move_to_folder'), icon: <FolderInput size={13}/>, onSelect: () => setMoving(true) },
        { id: 'archive', label: t('navigation.archive'), icon: <Archive size={13}/>, onSelect: () => void patchNote(note.id, { isArchived: true }) },
        { id: 'delete', label: t('common.move_to_trash'), icon: <Trash2 size={13}/>, separatorBefore: true, tone: 'danger', onSelect: () => void deleteNote(note.id) },
    ];
    return <div role="treeitem" aria-level={depth + 1} aria-selected={active} data-tree-note-id={note.id}>
        <div ref={anchor} draggable onDragStart={(event) => {
            event.dataTransfer.setData('application/x-inkstone-note', note.id);
            event.dataTransfer.effectAllowed = 'move';
        }} onContextMenu={(event) => { setMenuOpen(false); contextMenu.onContextMenu(event); }} className={cn('group relative flex h-11 items-center gap-1 rounded-[var(--r-md)] pr-1 md:h-[30px]', active ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')} style={{ paddingLeft: 6 + depth * 13 }}>
            <span className="w-8 shrink-0 md:w-4"/>
            <FileText size={14} className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}/>
            <button type="button" data-tree-note-open data-navigation-item aria-current={active ? 'page' : undefined} title={note.title || t('common.untitled_note')} onClick={() => open()} className="h-full min-w-0 flex-1 truncate pl-1 text-left text-[12.5px]">
                {note.title || t('common.untitled_note')}
            </button>
            <IconButton label={t('common.more_actions')} size="sm" onClick={() => { contextMenu.close(); setMenuOpen(true); }} className="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"><MoreHorizontal size={13}/></IconButton>
        </div>
        <Menu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={items}/>
        {contextMenu.point && <Menu anchor={contextMenu.point} open onClose={contextMenu.close} items={items}/>}
        <FolderPicker open={moving} title={t('notes.move_to_folder')} folders={folders} currentId={note.folderId} onSelect={(folderId) => void patchNote(note.id, { folderId })} onClose={() => setMoving(false)}/>
    </div>;
}
