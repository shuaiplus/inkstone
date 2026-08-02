import { useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { Blocks, Bold, Braces, ChevronDown, Code, Heading, Highlighter, Image as ImageIcon, Italic, Link2, List, ListOrdered, ListTodo, Minus, Network, Quote, Sigma, Sparkles, Strikethrough, Table, } from 'lucide-react';
import { IconButton } from '../../components/primitives';
import { Menu, Tooltip, type MenuItem } from '../../components/overlay';
import { cn } from '../../lib/cn';
import { insertAdvancedCodeBlock, insertBlockId, insertCallout, insertCodeBlock, insertDefinitionList, insertDetails, insertFootnote, insertFrontMatter, insertHorizontalRule, insertImage, insertLink, insertMermaid, insertPandocAttributes, insertTable, insertTabs, insertTag, insertText, setHeading, toggleBlockReference, toggleBold, toggleBulletList, toggleHighlight, toggleInlineCode, toggleInlineMath, toggleInserted, toggleItalic, toggleNoteEmbed, toggleOrderedList, toggleQuote, toggleStrikethrough, toggleSubscript, toggleSuperscript, toggleTaskList, toggleWikiLink, } from '../../editor/commands';
import { insertMarkdownBlock, runAiIntoEditor, runAiImageIntoEditor, type AiMode, type AiRunProgress, type AiTask } from '../../lib/ai-stream';
import { useUi } from '../../store/ui';
import { t } from "../../lib/i18n";
import { AiInlinePrompt } from './AiInlinePrompt';
import { AiSelectionBubble } from './AiSelectionBubble';
import { AiGeneratingBar } from './AiGeneratingBar';
import { AiImageDialog } from './AiImageDialog';
export function EditorToolbar({ view, onPickImage, mobile = false, }: {
    view: EditorView | null;
    onPickImage: () => void;
    mobile?: boolean;
}) {
    const headingRef = useRef<HTMLButtonElement>(null);
    const inlineRef = useRef<HTMLButtonElement>(null);
    const noteRef = useRef<HTMLButtonElement>(null);
    const blockRef = useRef<HTMLButtonElement>(null);
    const aiRef = useRef<HTMLButtonElement>(null);
    const [openMenu, setOpenMenu] = useState<'heading' | 'inline' | 'note' | 'block' | 'ai' | null>(null);
    const [aiRunning, setAiRunning] = useState<{
        task: AiTask;
        controller: AbortController;
        progress: AiRunProgress;
    } | null>(null);
    const aiControllerRef = useRef<AbortController | null>(null);
    const [inlinePrompt, setInlinePrompt] = useState<{ open: boolean; mode: 'draft' | 'edit' | 'continue' }>({ open: false, mode: 'draft' });
    const [imageOpen, setImageOpen] = useState(false);
    const toast = useUi((s) => s.toast);
    const aiDrafting = aiRunning !== null;
    useEffect(() => () => aiControllerRef.current?.abort(), []);
    const toggleMenu = (menu: 'heading' | 'inline' | 'note' | 'block' | 'ai') => {
        setOpenMenu((current) => current === menu ? null : menu);
    };
    const run = (command: (target: EditorView) => boolean) => () => {
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
        { id: 'inserted', label: t("workspace.inserted_text"), onSelect: run(toggleInserted) },
        { id: 'subscript', label: t("workspace.subscript"), onSelect: run(toggleSubscript) },
        { id: 'superscript', label: t("workspace.superscript"), onSelect: run(toggleSuperscript) },
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
        { id: 'definition-list', label: t("workspace.definition_list"), onSelect: run(insertDefinitionList) },
        { id: 'mermaid', label: t("workspace.mermaid_diagram"), onSelect: run(insertMermaid) },
        { id: 'advanced-code', label: t("workspace.enhanced_code_block"), onSelect: run(insertAdvancedCodeBlock) },
        { id: 'callout', label: t("workspace.callout"), onSelect: run(insertCallout) },
        { id: 'details', label: t("workspace.details_block"), onSelect: run(insertDetails) },
        { id: 'tabs', label: t("common.tabs"), onSelect: run(insertTabs) },
        { id: 'pandoc-attributes', label: t("workspace.pandoc_attributes"), onSelect: run(insertPandocAttributes), separatorBefore: true },
        { id: 'front-matter', label: 'Front Matter', onSelect: run(insertFrontMatter) },
    ];
    const runAi = (task: AiTask, mode: AiMode, prompt?: string) => {
        if (!view || aiRunning) return;
        const controller = new AbortController();
        aiControllerRef.current = controller;
        setAiRunning({ task, controller, progress: { phase: 'connecting', characters: 0 } });
        setOpenMenu(null);
        const runner = task === 'image' ? runAiImageIntoEditor : runAiIntoEditor;
        let lastProgressAt = 0;
        let lastPhase: AiRunProgress['phase'] = 'connecting';
        runner({
            view,
            task,
            mode,
            toast,
            signal: controller.signal,
            prompt,
            onProgress: (progress) => {
                const now = performance.now();
                if (progress.phase === lastPhase && now - lastProgressAt < 120) return;
                lastProgressAt = now;
                lastPhase = progress.phase;
                setAiRunning((current) => current?.controller === controller
                    ? { ...current, progress }
                    : current);
            },
        })
            .catch(() => {})
            .finally(() => {
                if (aiControllerRef.current === controller) aiControllerRef.current = null;
                setAiRunning((current) => current?.controller === controller ? null : current);
            });
    };
    const cancelAi = () => {
        if (!aiRunning) return;
        aiRunning.controller.abort();
        toast({ title: t('ai.generation_canceled'), tone: 'default' });
    };
    const hasSelection = !!view && view.state.selection.main.from !== view.state.selection.main.to;
    const hasContent = !!view && view.state.doc.toString().trim().length > 0;
    const aiItems: MenuItem[] = [
        {
            id: 'ai-polish',
            label: t('ai.polish_selection'),
            disabled: !hasSelection,
            onSelect: () => runAi('polish', 'replace'),
        },
        {
            id: 'ai-summarize',
            label: t('ai.summarize_insert'),
            disabled: !hasContent,
            onSelect: () => runAi('summarize', 'append'),
        },
        {
            id: 'ai-continue',
            label: t('ai.continue_writing'),
            disabled: !hasContent,
            separatorBefore: true,
            onSelect: () => runAi('continue', 'append'),
        },
        {
            id: 'ai-edit',
            label: t('ai.ask_ai_to_edit'),
            disabled: !hasSelection,
            onSelect: () => {
                setOpenMenu(null);
                setInlinePrompt({ open: true, mode: 'edit' });
            },
        },
        {
            id: 'ai-draft',
            label: t('ai.draft_here'),
            onSelect: () => {
                setOpenMenu(null);
                setInlinePrompt({ open: true, mode: 'draft' });
            },
        },
        {
            id: 'ai-image',
            label: t('ai.task_image'),
            separatorBefore: true,
            onSelect: () => {
                setOpenMenu(null);
                setImageOpen(true);
            },
        },
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

      <Tooltip label={t('ai.assistant')}>
        <button ref={aiRef} type="button" onClick={() => toggleMenu('ai')} disabled={aiDrafting} aria-label={t('ai.assistant')} aria-haspopup="menu" aria-expanded={openMenu === 'ai'} className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-[var(--r-md)] px-2 text-[var(--text-secondary)] transition-all hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]', mobile ? 'h-9' : 'h-7', aiDrafting && 'text-[var(--accent)]')}>
          <Sparkles size={14} className={aiDrafting ? 'animate-pulse' : ''}/>
          <ChevronDown size={10} className="opacity-60"/>
        </button>
      </Tooltip>

      <Menu anchor={headingRef} open={openMenu === 'heading'} onClose={() => setOpenMenu(null)} items={headingItems} width={168} label={t("workspace.title_level")}/>
      <Menu anchor={inlineRef} open={openMenu === 'inline'} onClose={() => setOpenMenu(null)} items={inlineItems} width={184} label={t("workspace.more_inline_styles")}/>
      <Menu anchor={noteRef} open={openMenu === 'note'} onClose={() => setOpenMenu(null)} items={noteItems} width={184} label={t("workspace.note_syntax")}/>
      <Menu anchor={blockRef} open={openMenu === 'block'} onClose={() => setOpenMenu(null)} items={blockItems} width={192} label={t("workspace.more_blocks")}/>
      <Menu anchor={aiRef} open={openMenu === 'ai'} onClose={() => setOpenMenu(null)} items={aiItems} width={220} label={t('ai.assistant')}/>

      <AiSelectionBubble
        view={view}
        running={aiDrafting}
        onRun={runAi}
        onImage={() => setImageOpen(true)}
      />
      <AiInlinePrompt
        view={view}
        open={inlinePrompt.open}
        mode={inlinePrompt.mode}
        onClose={() => setInlinePrompt((s) => ({ ...s, open: false }))}
        onSubmit={(prompt) => {
          const mode: AiMode = inlinePrompt.mode === 'edit' ? 'replace' : 'insert';
          const task: AiTask = inlinePrompt.mode === 'edit' ? 'edit' : inlinePrompt.mode === 'continue' ? 'continue' : 'draft';
          setInlinePrompt((s) => ({ ...s, open: false }));
          runAi(task, mode, prompt);
        }}
        onImage={() => setImageOpen(true)}
      />
      <AiImageDialog
        open={imageOpen}
        onClose={() => setImageOpen(false)}
        onInsert={(url, alt) => {
          if (!view) return;
          const pos = view.state.selection.main.to;
          insertMarkdownBlock(view, pos, `![${alt}](${url})`);
        }}
      />
      {aiRunning && <AiGeneratingBar task={aiRunning.task} progress={aiRunning.progress} onCancel={cancelAi} />}
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
