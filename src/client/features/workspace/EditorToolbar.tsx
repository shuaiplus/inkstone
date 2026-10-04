import { useRef, useState, type ReactNode, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { Blocks, Bold, Braces, ChevronDown, Code, FileText, Heading, Highlighter, Image as ImageIcon, Italic, Link2, List, ListOrdered, ListTodo, Quote, Sigma, Strikethrough, Table } from 'lucide-react';
import { IconButton } from '../../components/primitives';
import { Menu, Tooltip, type MenuItem } from '../../components/overlay';
import { cn } from '../../lib/cn';
import { insertAdvancedCodeBlock, insertBlockId, insertCallout, insertCodeBlock, insertDetails, insertFootnote, insertFrontMatter, insertHorizontalRule, insertImage, insertLink, insertMathBlock, insertMermaid, insertTable, insertTabs, insertTag, setHeading, toggleBlockReference, toggleBold, toggleBulletList, toggleComment, toggleHighlight, toggleInlineCode, toggleInlineMath, toggleItalic, toggleNoteEmbed, toggleOrderedList, toggleQuote, toggleStrikethrough, toggleTaskList, toggleWikiLink } from '../../editor/commands';
import { t } from '../../lib/i18n';
import { editorCombo } from '../../editor/shortcuts';

type ToolbarMenu = 'heading' | 'reference' | 'image' | 'note' | 'code' | 'math' | 'block';

export function EditorToolbar({ runCommand, view, onPickImage, mobile = false }: {
    runCommand?: (command: (target: EditorView) => boolean) => void;
    view?: EditorView | null;
    onPickImage: () => void;
    mobile?: boolean;
}) {
    const headingRef = useRef<HTMLButtonElement>(null);
    const referenceRef = useRef<HTMLButtonElement>(null);
    const imageRef = useRef<HTMLButtonElement>(null);
    const noteRef = useRef<HTMLButtonElement>(null);
    const codeRef = useRef<HTMLButtonElement>(null);
    const mathRef = useRef<HTMLButtonElement>(null);
    const blockRef = useRef<HTMLButtonElement>(null);
    const [openMenu, setOpenMenu] = useState<ToolbarMenu | null>(null);
    const toggleMenu = (menu: ToolbarMenu) => setOpenMenu((current) => current === menu ? null : menu);
    const run = (command: (target: EditorView) => boolean) => () => {
        setOpenMenu(null);
        if (runCommand) {
            runCommand(command);
            return;
        }
        if (!view) return;
        command(view);
        view.focus();
    };
    const pickImage = () => {
        setOpenMenu(null);
        onPickImage();
    };
    const headingItems: MenuItem[] = [
        { id: 'paragraph', label: t('workspace.paragraph'), combo: editorCombo('paragraph'), onSelect: run(setHeading(0)) },
        ...[1, 2, 3, 4, 5, 6].map((level) => ({
            id: `h${level}`, label: t('workspace.heading_value0', { value0: level }),
            combo: editorCombo(`h${level}`), separatorBefore: level === 1, onSelect: run(setHeading(level)),
        })),
    ];
    const referenceItems: MenuItem[] = [
        { id: 'link', label: t('workspace.link'), combo: editorCombo('link'), onSelect: run(insertLink()) },
        { id: 'wiki-link', label: t('common.wiki_links'), onSelect: run(toggleWikiLink), separatorBefore: true },
        { id: 'note-embed', label: t('workspace.note_embed'), onSelect: run(toggleNoteEmbed) },
        { id: 'block-reference', label: t('workspace.block_reference'), onSelect: run(toggleBlockReference) },
        { id: 'footnote', label: t('workspace.footnote'), onSelect: run(insertFootnote), separatorBefore: true },
    ];
    const imageItems: MenuItem[] = [
        { id: 'upload-image', label: t('workspace.upload_image'), onSelect: pickImage },
        { id: 'remote-image', label: t('workspace.remote_image'), onSelect: run(insertImage()) },
    ];
    const noteItems: MenuItem[] = [
        { id: 'tag', label: t('workspace.insert_tag'), onSelect: run(insertTag) },
        { id: 'block-id', label: t('workspace.block_id'), onSelect: run(insertBlockId) },
        { id: 'front-matter', label: t('workspace.front_matter'), onSelect: run(insertFrontMatter), separatorBefore: true },
        { id: 'comment', label: t('workspace.hidden_comment'), combo: editorCombo('comment'), onSelect: run(toggleComment), separatorBefore: true },
    ];
    const codeItems: MenuItem[] = [
        { id: 'code', label: t('workspace.code_block'), onSelect: run(insertCodeBlock) },
        { id: 'advanced-code', label: t('workspace.enhanced_code_block'), onSelect: run(insertAdvancedCodeBlock) },
        { id: 'mermaid', label: t('workspace.mermaid_diagram'), onSelect: run(insertMermaid), separatorBefore: true },
    ];
    const mathItems: MenuItem[] = [
        { id: 'inline-math', label: t('workspace.inline_math'), onSelect: run(toggleInlineMath) },
        { id: 'block-math', label: t('workspace.block_math'), onSelect: run(insertMathBlock) },
    ];
    const blockItems: MenuItem[] = [
        { id: 'callout', label: t('workspace.callout'), onSelect: run(insertCallout) },
        { id: 'details', label: t('workspace.details_block'), onSelect: run(insertDetails) },
        { id: 'tabs', label: t('common.tabs'), onSelect: run(insertTabs) },
        { id: 'divider', label: t('workspace.divider'), onSelect: run(insertHorizontalRule), separatorBefore: true },
    ];
    const menus = [
        { id: 'heading', anchor: headingRef, label: t('workspace.title_level'), items: headingItems, width: 224 },
        { id: 'reference', anchor: referenceRef, label: t('workspace.links_and_references'), items: referenceItems, width: 200 },
        { id: 'image', anchor: imageRef, label: t('workspace.insert_image'), items: imageItems, width: 176 },
        { id: 'note', anchor: noteRef, label: t('workspace.note_tools'), items: noteItems, width: 224 },
        { id: 'code', anchor: codeRef, label: t('workspace.code_and_diagrams'), items: codeItems, width: 192 },
        { id: 'math', anchor: mathRef, label: t('workspace.math'), items: mathItems, width: 176 },
        { id: 'block', anchor: blockRef, label: t('workspace.content_blocks'), items: blockItems, width: 176 },
    ] as const;
    const menuButton = (id: ToolbarMenu, icon: ReactNode, primary?: { label: string; onClick: () => void; combo?: string }) => {
        const menu = menus.find((item) => item.id === id)!;
        return <div className="flex shrink-0 items-center rounded-[var(--r-md)]">
          {primary && <ToolButton label={primary.label} combo={primary.combo} onClick={primary.onClick}>{icon}</ToolButton>}
          <MenuButton buttonRef={menu.anchor} label={menu.label} mobile={mobile} open={openMenu === id} onClick={() => toggleMenu(id)}>
            {!primary && icon}
          </MenuButton>
        </div>;
    };

    return (<div aria-label={t('workspace.formatting_tools')} className={cn('editor-toolbar flex shrink-0 items-center overflow-x-auto border-b border-[var(--border-subtle)] px-2 no-scrollbar', mobile ? 'h-11 gap-1' : 'h-9 gap-0.5')}>
      {menuButton('heading', <Heading size={14}/>)}
      <Divider />
      <ToolButton label={t('common.bold')} combo={editorCombo('bold')} onClick={run(toggleBold)}><Bold size={14}/></ToolButton>
      <ToolButton label={t('common.italic')} combo={editorCombo('italic')} onClick={run(toggleItalic)}><Italic size={14}/></ToolButton>
      <ToolButton label={t('common.strikethrough')} combo={editorCombo('strikethrough')} onClick={run(toggleStrikethrough)}><Strikethrough size={14}/></ToolButton>
      <ToolButton label={t('common.highlight')} onClick={run(toggleHighlight)}><Highlighter size={14}/></ToolButton>
      <ToolButton label={t('common.inline_code')} combo={editorCombo('inline-code')} onClick={run(toggleInlineCode)}><Code size={14}/></ToolButton>
      <Divider />
      <ToolButton label={t('common.unordered_list')} combo={editorCombo('bullet-list')} onClick={run(toggleBulletList)}><List size={14}/></ToolButton>
      <ToolButton label={t('common.ordered_list')} combo={editorCombo('ordered-list')} onClick={run(toggleOrderedList)}><ListOrdered size={14}/></ToolButton>
      <ToolButton label={t('common.task_list')} combo={editorCombo('task-list')} onClick={run(toggleTaskList)}><ListTodo size={14}/></ToolButton>
      <ToolButton label={t('common.quote')} combo={editorCombo('quote')} onClick={run(toggleQuote)}><Quote size={14}/></ToolButton>
      <Divider />
      {menuButton('reference', <Link2 size={14}/>, { label: t('workspace.link'), combo: editorCombo('link'), onClick: run(insertLink()) })}
      {menuButton('image', <ImageIcon size={14}/>, { label: t('workspace.upload_image'), onClick: pickImage })}
      {menuButton('note', <FileText size={14}/>)}
      <Divider />
      {menuButton('code', <Braces size={14}/>, { label: t('workspace.code_block'), onClick: run(insertCodeBlock) })}
      <ToolButton label={t('workspace.table')} onClick={run(insertTable)}><Table size={14}/></ToolButton>
      {menuButton('math', <Sigma size={14}/>)}
      {menuButton('block', <Blocks size={14}/>)}
      {menus.map((menu) => <Menu key={menu.id} anchor={menu.anchor} open={openMenu === menu.id} onClose={() => setOpenMenu(null)} items={menu.items} width={menu.width} label={menu.label}/>)}
    </div>);
}

function MenuButton({ buttonRef, label, open, onClick, children, mobile = false }: {
    buttonRef: RefObject<HTMLButtonElement | null>;
    label: string;
    open: boolean;
    mobile?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (<Tooltip label={label}>
      <button ref={buttonRef} type="button" onClick={onClick} aria-label={label} aria-haspopup="menu" aria-expanded={open} className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-[var(--r-md)] px-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]', open && 'bg-[var(--bg-hover)] text-[var(--text-primary)]', mobile ? 'h-9' : 'h-7')}>
        {children}<ChevronDown size={10} className="opacity-60"/>
      </button>
    </Tooltip>);
}

function ToolButton({ label, combo, onClick, children }: {
    label: string;
    combo?: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (<Tooltip label={label} combo={combo}>
      <IconButton label={label} size="sm" onClick={onClick} className="size-9 shrink-0 md:size-7">{children}</IconButton>
    </Tooltip>);
}

function Divider() {
    return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-[var(--border-subtle)]"/>;
}
