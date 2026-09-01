import { useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { Blocks, Bold, Braces, ChevronDown, Code, Heading, Highlighter, Image as ImageIcon, Italic, Link2, List, ListOrdered, ListTodo, Minus, Network, Quote, Sigma, Sparkles, Strikethrough, Table, } from 'lucide-react';
import { IconButton } from '../../components/primitives';
import { Menu, Tooltip, type MenuItem } from '../../components/overlay';
import { cn } from '../../lib/cn';
import { insertAdvancedCodeBlock, insertBlockId, insertCallout, insertCodeBlock, insertDetails, insertFootnote, insertFrontMatter, insertHorizontalRule, insertImage, insertLink, insertMermaid, insertTable, insertTabs, insertTag, insertText, setHeading, toggleBlockReference, toggleBold, toggleBulletList, toggleHighlight, toggleInlineCode, toggleInlineMath, toggleItalic, toggleNoteEmbed, toggleOrderedList, toggleQuote, toggleStrikethrough, toggleTaskList, toggleWikiLink, } from '../../editor/commands';
import { t } from "../../lib/i18n";
import { openAiTidyForActiveNote } from '../ai/open-tidy';
export function EditorToolbar({ runCommand, view, onPickImage, mobile = false, }: {
    runCommand?: (command: (target: EditorView) => boolean) => void;
    view?: EditorView | null;
    onPickImage: () => void;
    mobile?: boolean;
}) {
    const headingRef = useRef<HTMLButtonElement>(null);
    const inlineRef = useRef<HTMLButtonElement>(null);
    const noteRef = useRef<HTMLButtonElement>(null);
    const blockRef = useRef<HTMLButtonElement>(null);
    const [openMenu, setOpenMenu] = useState<'heading' | 'inline' | 'note' | 'block' | null>(null);
    const toggleMenu = (menu: 'heading' | 'inline' | 'note' | 'block') => {
        setOpenMenu((current) => current === menu ? null : menu);
    };
    const run = (command: (target: EditorView) => boolean) => () => {
        if (runCommand) {
            runCommand(command);
            return;
        }
        if (!view)
            return;
        command(view);
        view.focus();
    };
    const headingItems: MenuItem[] = [1, 2, 3, 4, 5, 6].map((level) => ({
        id: `h${level}`,
        label: t("workspace.heading_value0", { value0: level }),
        combo: `mod+${level}`,
        onSelect: run(setHeading(level)),
    }));
    const inlineItems: MenuItem[] = [
        { id: 'highlight', label: t("common.highlight"), combo: 'mod+shift+h', onSelect: run(toggleHighlight) },
        { id: 'inline-math', label: t("workspace.inline_math"), onSelect: run(toggleInlineMath), separatorBefore: true },
    ];
    const noteItems: MenuItem[] = [
        { id: 'wiki-link', label: t("common.wiki_links"), onSelect: run(toggleWikiLink) },
        { id: 'note-embed', label: t("workspace.note_embed"), onSelect: run(toggleNoteEmbed) },
        { id: 'remote-image', label: t("workspace.remote_image"), onSelect: run(insertImage()) },
        { id: 'tag', label: t("workspace.insert_tag"), onSelect: run(insertTag), separatorBefore: true },
        { id: 'block-id', label: t("workspace.block_id"), onSelect: run(insertBlockId) },
        { id: 'block-reference', label: t("workspace.block_reference"), onSelect: run(toggleBlockReference) },
        { id: 'footnote', label: t("workspace.footnote"), onSelect: run(insertFootnote), separatorBefore: true },
    ];
    const blockItems: MenuItem[] = [
        { id: 'mermaid', label: t("workspace.mermaid_diagram"), onSelect: run(insertMermaid) },
        { id: 'advanced-code', label: t("workspace.enhanced_code_block"), onSelect: run(insertAdvancedCodeBlock) },
        { id: 'callout', label: t("workspace.callout"), onSelect: run(insertCallout) },
        { id: 'details', label: t("workspace.details_block"), onSelect: run(insertDetails) },
        { id: 'tabs', label: t("common.tabs"), onSelect: run(insertTabs) },
        { id: 'front-matter', label: 'Front Matter', onSelect: run(insertFrontMatter), separatorBefore: true },
    ];
    return (<div className={cn('flex shrink-0 items-center overflow-x-auto border-b border-[var(--border-subtle)] px-2 no-scrollbar', mobile ? 'h-11 gap-1' : 'h-9 gap-0.5')}>
      <Tooltip label={t("workspace.title_748d7d")}>
        <button ref={headingRef} type="button" onClick={() => toggleMenu('heading')} aria-label={t("workspace.title_level")} aria-haspopup="menu" aria-expanded={openMenu === 'heading'} className={cn('inline-flex items-center gap-0.5 rounded-[var(--r-md)] px-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]', mobile ? 'h-9' : 'h-7')}>
          <Heading size={14}/>
          <ChevronDown size={10} className="opacity-60"/>
        </button>
      </Tooltip>

      <Divider />

      <ToolButton label={t("common.bold")} combo="mod+b" onClick={run(toggleBold)}>
        <Bold size={14}/>
      </ToolButton>
      <ToolButton label={t("common.italic")} combo="mod+i" onClick={run(toggleItalic)}>
        <Italic size={14}/>
      </ToolButton>
      <ToolButton label={t("common.strikethrough")} combo="mod+shift+x" onClick={run(toggleStrikethrough)}>
        <Strikethrough size={14}/>
      </ToolButton>
      <ToolButton label={t("common.inline_code")} combo="mod+e" onClick={run(toggleInlineCode)}>
        <Code size={14}/>
      </ToolButton>
      <MenuButton buttonRef={inlineRef} label={t("workspace.more_inline_styles")} mobile={mobile} open={openMenu === 'inline'} onClick={() => toggleMenu('inline')}>
        <Highlighter size={14}/>
      </MenuButton>

      <Divider />

      <ToolButton label={t("common.unordered_list")} combo="mod+shift+8" onClick={run(toggleBulletList)}>
        <List size={14}/>
      </ToolButton>
      <ToolButton label={t("common.ordered_list")} combo="mod+shift+7" onClick={run(toggleOrderedList)}>
        <ListOrdered size={14}/>
      </ToolButton>
      <ToolButton label={t("common.task_list")} combo="mod+shift+9" onClick={run(toggleTaskList)}>
        <ListTodo size={14}/>
      </ToolButton>
      <ToolButton label={t("common.quote")} combo="mod+shift+." onClick={run(toggleQuote)}>
        <Quote size={14}/>
      </ToolButton>

      <Divider />

      <ToolButton label={t("workspace.link")} onClick={run(insertLink())}>
        <Link2 size={14}/>
      </ToolButton>
      <ToolButton label={t("workspace.insert_image")} onClick={onPickImage}>
        <ImageIcon size={14}/>
      </ToolButton>
      <MenuButton buttonRef={noteRef} label={t("workspace.note_syntax")} mobile={mobile} open={openMenu === 'note'} onClick={() => toggleMenu('note')}>
        <Network size={14}/>
      </MenuButton>

      <Divider />

      <ToolButton label={t("workspace.code_block")} onClick={run(insertCodeBlock)}>
        <Braces size={14}/>
      </ToolButton>
      <ToolButton label={t("workspace.table")} onClick={run(insertTable)}>
        <Table size={14}/>
      </ToolButton>
      <ToolButton label={t("workspace.math")} onClick={run(insertText('$$\n\n$$\n', 3))}>
        <Sigma size={14}/>
      </ToolButton>
      <ToolButton label={t("workspace.divider")} onClick={run(insertHorizontalRule)}>
        <Minus size={14}/>
      </ToolButton>
      <MenuButton buttonRef={blockRef} label={t("workspace.more_blocks")} mobile={mobile} open={openMenu === 'block'} onClick={() => toggleMenu('block')}>
        <Blocks size={14}/>
      </MenuButton>

      <Divider />

      <ToolButton label={t("workspace.ai_tidy")} onClick={openAiTidyForActiveNote}>
        <Sparkles size={14}/>
      </ToolButton>

      <Menu anchor={headingRef} open={openMenu === 'heading'} onClose={() => setOpenMenu(null)} items={headingItems} width={168} label={t("workspace.title_level")}/>
      <Menu anchor={inlineRef} open={openMenu === 'inline'} onClose={() => setOpenMenu(null)} items={inlineItems} width={184} label={t("workspace.more_inline_styles")}/>
      <Menu anchor={noteRef} open={openMenu === 'note'} onClose={() => setOpenMenu(null)} items={noteItems} width={184} label={t("workspace.note_syntax")}/>
      <Menu anchor={blockRef} open={openMenu === 'block'} onClose={() => setOpenMenu(null)} items={blockItems} width={192} label={t("workspace.more_blocks")}/>
    </div>);
}
function MenuButton({ buttonRef, label, open, onClick, children, mobile = false, }: {
    buttonRef: React.RefObject<HTMLButtonElement | null>;
    label: string;
    open: boolean;
    mobile?: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (<Tooltip label={label}>
      <button ref={buttonRef} type="button" onClick={onClick} aria-label={label} aria-haspopup="menu" aria-expanded={open} className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-[var(--r-md)] px-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]', mobile ? 'h-9' : 'h-7')}>
        {children}
        <ChevronDown size={10} className="opacity-60"/>
      </button>
    </Tooltip>);
}
function ToolButton({ label, combo, onClick, children, }: {
    label: string;
    combo?: string;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (<Tooltip label={label} combo={combo}>
      <IconButton label={label} size="sm" onClick={onClick} className="size-9 md:size-7">
        {children}
      </IconButton>
    </Tooltip>);
}
function Divider() {
    return <span className="mx-1 h-4 w-px shrink-0 bg-[var(--border-subtle)]"/>;
}
