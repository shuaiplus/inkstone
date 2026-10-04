import type { Command, KeyBinding } from '@codemirror/view';
import { redo, undo, moveLineUp, moveLineDown, deleteLine, indentMore, indentLess } from '@codemirror/commands';
import { openSearchPanel, selectNextOccurrence } from '@codemirror/search';
import type { MessageKey } from '../lib/i18n';
import { IS_MAC } from '../lib/hotkeys';
import { codeMirrorKey } from '../lib/shortcuts';
import { insertLink, setHeading, toggleBold, toggleComment, toggleBulletList, toggleInlineCode, toggleItalic, toggleOrderedList, toggleQuote, toggleStrikethrough, toggleTaskDone, toggleTaskList } from './commands';

interface EditorShortcut {
    id: string;
    combo: string;
    label: MessageKey;
    run: Command;
    level?: number;
}

export const EDITOR_SHORTCUTS: EditorShortcut[] = [
    { id: 'bold', combo: 'mod+b', label: 'common.bold', run: toggleBold },
    { id: 'italic', combo: 'mod+i', label: 'common.italic', run: toggleItalic },
    { id: 'inline-code', combo: 'mod+e', label: 'common.inline_code', run: toggleInlineCode },
    { id: 'strikethrough', combo: 'mod+shift+x', label: 'common.strikethrough', run: toggleStrikethrough },
    { id: 'link', combo: 'mod+k', label: 'workspace.link', run: insertLink() },
    { id: 'comment', combo: 'mod+/', label: 'workspace.hidden_comment', run: toggleComment },
    { id: 'paragraph', combo: 'mod+alt+0', label: 'workspace.paragraph', run: setHeading(0) },
    ...[1, 2, 3, 4, 5, 6].map((level): EditorShortcut => ({
        id: `h${level}`, combo: `mod+alt+${level}`, label: 'workspace.heading_value0', level, run: setHeading(level),
    })),
    { id: 'bullet-list', combo: 'mod+shift+8', label: 'common.unordered_list', run: toggleBulletList },
    { id: 'ordered-list', combo: 'mod+shift+7', label: 'common.ordered_list', run: toggleOrderedList },
    { id: 'task-list', combo: 'mod+shift+9', label: 'common.task_list', run: toggleTaskList },
    { id: 'quote', combo: 'mod+shift+.', label: 'common.quote', run: toggleQuote },
    { id: 'task-done', combo: 'mod+shift+enter', label: 'command.check_uncheck_tasks', run: toggleTaskDone },
    { id: 'move-line-up', combo: 'alt+arrowup', label: 'command.move_line_up', run: moveLineUp },
    { id: 'move-line-down', combo: 'alt+arrowdown', label: 'command.move_line_down', run: moveLineDown },
    { id: 'delete-line', combo: 'mod+shift+k', label: 'command.delete_line', run: deleteLine },
    { id: 'indent', combo: 'mod+]', label: 'command.indent', run: indentMore },
    { id: 'outdent', combo: 'mod+[', label: 'command.outdent', run: indentLess },
    { id: 'find', combo: 'mod+f', label: 'command.find_and_replace_in_this_note', run: openSearchPanel },
    { id: 'select-next', combo: 'mod+d', label: 'command.select_next_occurrence', run: selectNextOccurrence },
    { id: 'undo', combo: 'mod+z', label: 'common.undo', run: undo },
    { id: 'redo', combo: IS_MAC ? 'mod+shift+z' : 'mod+y', label: 'command.redo', run: redo },
    ...(!IS_MAC ? [{ id: 'redo-alternative', combo: 'mod+shift+z', label: 'command.redo' as const, run: redo }] : []),
];

export const editorKeymap: KeyBinding[] = EDITOR_SHORTCUTS.map(({ combo, run }) => ({
    key: codeMirrorKey(combo), run, preventDefault: true,
}));

export function editorCombo(id: string): string | undefined {
    return EDITOR_SHORTCUTS.find((shortcut) => shortcut.id === id)?.combo;
}
