import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject, } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button, IconButton, Kbd } from './primitives';
import { t } from "../lib/i18n";
import { getVisibleViewport } from '../lib/viewport';


const escStack: (() => void)[] = [];
export function useEscape(active: boolean, onEscape: () => void): void {
    const callbackRef = useRef(onEscape);
    callbackRef.current = onEscape;
    useEffect(() => {
        if (!active)
            return;
        const handler = () => callbackRef.current();
        escStack.push(handler);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.isComposing || event.repeat || event.defaultPrevented)
                return;
            const top = escStack[escStack.length - 1];
            if (top !== handler)
                return;
            event.preventDefault();
            event.stopPropagation();
            handler();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            const index = escStack.indexOf(handler);
            if (index >= 0)
                escStack.splice(index, 1);
        };
    }, [active]);
}
export function useClickOutside(refs: RefObject<HTMLElement | null>[], active: boolean, onOutside: () => void): void {
    const refsRef = useRef(refs);
    const callbackRef = useRef(onOutside);
    refsRef.current = refs;
    callbackRef.current = onOutside;
    useEffect(() => {
        if (!active)
            return;
        const handler = (event: MouseEvent) => {
            const target = event.target as Node;
            if (refsRef.current.some((ref) => ref.current?.contains(target)))
                return;
            callbackRef.current();
        };

        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [active]);
}
let scrollLockCount = 0;
let unlockedBodyOverflow = '';
export function useLockScroll(active: boolean): void {
    useEffect(() => {
        if (!active)
            return;
        if (scrollLockCount === 0)
            unlockedBodyOverflow = document.body.style.overflow;
        scrollLockCount++;
        document.body.style.overflow = 'hidden';
        return () => {
            scrollLockCount = Math.max(0, scrollLockCount - 1);
            if (scrollLockCount === 0)
                document.body.style.overflow = unlockedBodyOverflow;
        };
    }, [active]);
}
const dialogStack: symbol[] = [];
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"]):not([disabled])',
].join(',');

export function useDialogFocus<T extends HTMLElement>(active: boolean, panelRef: RefObject<T | null>, initialFocusRef?: RefObject<HTMLElement | null>): void {
    useEffect(() => {
        if (!active)
            return;
        const token = Symbol('dialog');
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialogStack.push(token);
        const panel = panelRef.current;
        const requestedInitial = initialFocusRef?.current ??
            panel?.querySelector<HTMLElement>('[data-autofocus]');
        const initial = requestedInitial && isAvailableFocusTarget(requestedInitial)
            ? requestedInitial
            : [...(panel?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
                .find(isAvailableFocusTarget);
        (initial ?? panel)?.focus({ preventScroll: true });
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Tab' || dialogStack[dialogStack.length - 1] !== token)
                return;
            const currentPanel = panelRef.current;
            if (!currentPanel)
                return;
            const focusable = [...currentPanel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
                .filter(isAvailableFocusTarget);
            if (focusable.length === 0) {
                event.preventDefault();
                currentPanel.focus({ preventScroll: true });
                return;
            }
            const current = document.activeElement as HTMLElement | null;
            const index = current ? focusable.indexOf(current) : -1;
            if (event.shiftKey && index <= 0) {
                event.preventDefault();
                focusable[focusable.length - 1]?.focus({ preventScroll: true });
            }
            else if (!event.shiftKey && (index < 0 || index === focusable.length - 1)) {
                event.preventDefault();
                focusable[0]?.focus({ preventScroll: true });
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            const index = dialogStack.indexOf(token);
            if (index >= 0)
                dialogStack.splice(index, 1);
            if (previousFocus?.isConnected)
                previousFocus.focus({ preventScroll: true });
        };
    }, [active, initialFocusRef, panelRef]);
}

function isAvailableFocusTarget(element: HTMLElement): boolean {
    return !element.matches(':disabled') && !element.closest('[hidden], [aria-hidden="true"]');
}

export function Modal({ open, onClose, title, description, children, footer, width = 560, className, }: {
    open: boolean;
    onClose: () => void;
    title?: ReactNode;
    description?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
    width?: number;
    className?: string;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const descriptionId = useId();
    useEscape(open, onClose);
    useLockScroll(open);
    useDialogFocus(open, panelRef);
    if (!open)
        return null;
    return createPortal(


    <div className="app-viewport-fixed fixed z-[250] flex items-end justify-center overflow-hidden md:items-start md:overflow-y-auto md:p-8">
      <div className="anim-fade absolute inset-0 bg-[var(--scrim)] backdrop-blur-[3px]" onClick={onClose} aria-hidden="true"/>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} aria-describedby={description ? descriptionId : undefined} aria-label={title ? undefined : t("overlay.dialog")} tabIndex={-1} className={cn('anim-pop relative flex max-h-[calc(var(--app-viewport-height,100dvh)-env(safe-area-inset-top))] w-full flex-col rounded-t-[var(--r-2xl)] border border-b-0 border-[var(--border-default)]', 'bg-[var(--bg-overlay)] shadow-[var(--shadow-modal)] outline-none md:my-auto md:rounded-[var(--r-2xl)] md:border-b', className)} style={{ maxWidth: width }}>
        {(title || description) && (<div className="flex shrink-0 items-start justify-between gap-4 px-4 pt-4 pb-3 md:px-5">
            <div className="min-w-0">
              {title && (<h2 id={titleId} className="text-[15px] font-semibold tracking-[-0.012em] text-[var(--text-primary)]">
                  {title}
                </h2>)}
              {description && (<p id={descriptionId} className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-tertiary)]">
                  {description}
                </p>)}
            </div>
            <Tooltip label={t("common.close")} combo="escape" side="left">
              <IconButton label={t("common.close")} size="sm" onClick={onClose} className="-mr-1 -mt-0.5">
                <X size={15}/>
              </IconButton>
            </Tooltip>
          </div>)}
        <div className="min-h-0 overflow-y-auto px-4 pb-4 md:px-5 md:pb-5">{children}</div>
        {footer && (<div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] md:px-5 md:py-3">
            {footer}
          </div>)}
      </div>
    </div>, document.body);
}

interface ConfirmOptions {
    title: string;
    description?: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'default' | 'danger';
}
interface ConfirmRequest {
    options: ConfirmOptions;
    resolve: (value: boolean) => void;
}
let enqueueConfirm: ((request: ConfirmRequest) => void) | null = null;

export function confirm(options: ConfirmOptions): Promise<boolean> {
    if (!enqueueConfirm)
        return Promise.resolve(window.confirm(options.title));
    return new Promise((resolve) => {
        enqueueConfirm?.({ options, resolve });
    });
}
export function ConfirmHost() {
    const [current, setCurrent] = useState<ConfirmRequest | null>(null);
    const currentRef = useRef<ConfirmRequest | null>(null);
    const queueRef = useRef<ConfirmRequest[]>([]);
    useEffect(() => {
        enqueueConfirm = (request) => {
            if (currentRef.current) {
                queueRef.current.push(request);
                return;
            }
            currentRef.current = request;
            setCurrent(request);
        };
        return () => {
            enqueueConfirm = null;
            currentRef.current?.resolve(false);
            for (const request of queueRef.current)
                request.resolve(false);
            currentRef.current = null;
            queueRef.current = [];
        };
    }, []);
    const finish = useCallback((request: ConfirmRequest | null, value: boolean) => {
        if (!request || currentRef.current !== request)
            return;
        request.resolve(value);
        const next = queueRef.current.shift() ?? null;
        currentRef.current = next;
        setCurrent(next);
    }, []);
    const options = current?.options;
    return (<Modal open={Boolean(current)} onClose={() => finish(current, false)} title={options?.title} description={options?.description} width={440} footer={<>
          <Button variant="ghost" onClick={() => finish(current, false)}>
            {options?.cancelLabel ?? t("common.cancel")}
          </Button>
          <Button variant={options?.tone === 'danger' ? 'danger' : 'primary'} onClick={() => finish(current, true)} data-autofocus>
            {options?.confirmLabel ?? t("overlay.confirm")}
          </Button>
        </>}>
      <div />
    </Modal>);
}

export interface MenuItem {
    id: string;
    label: string;
    icon?: ReactNode;
    combo?: string;
    tone?: 'default' | 'danger';
    disabled?: boolean;
    checked?: boolean;
    onSelect?: () => void;
    separatorBefore?: boolean;
}
export function Menu({ anchor, open, onClose, items, align = 'start', width = 208, label = t("overlay.menu"), }: {
    anchor: RefObject<HTMLElement | null> | {
        x: number;
        y: number;
    };
    open: boolean;
    onClose: () => void;
    items: MenuItem[];
    align?: 'start' | 'end';
    width?: number;
    label?: string;
}) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{
        top: number;
        left: number;
        origin: string;
    }>({
        top: 0,
        left: 0,
        origin: 'top left',
    });
    const [cursor, setCursor] = useState(0);
    const anchorRef = 'current' in anchor ? anchor : null;
    const point = 'current' in anchor ? null : anchor;
    const menuWidth = Math.min(width, Math.max(0, innerWidth - 16));
    useLayoutEffect(() => {
        if (!open)
            return;
        const margin = 8;
        const itemHeight = innerWidth < 768 ? 40 : 30;
        const height = Math.min(items.length * itemHeight + 12, 420);
        let top: number;
        let left: number;
        if (point) {
            top = point.y;
            left = point.x;
        }
        else {
            const rect = anchorRef?.current?.getBoundingClientRect();
            if (!rect)
                return;
            top = rect.bottom + 5;
            left = align === 'end' ? rect.right - menuWidth : rect.left;
        }
        const viewport = getVisibleViewport();
        const flipUp = top + height > viewport.bottom - margin;
        if (flipUp)
            top = Math.max(viewport.top + margin, (point ? point.y : (anchorRef?.current?.getBoundingClientRect().top ?? top)) - height - 5);
        left = Math.min(Math.max(viewport.left + margin, left), viewport.right - menuWidth - margin);
        setPosition({ top, left, origin: `${flipUp ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}` });
        setCursor(items.findIndex((i) => !i.disabled));
    }, [open, items, align, menuWidth, anchorRef, point]);
    useEscape(open, onClose);
    useClickOutside(anchorRef ? [menuRef, anchorRef] : [menuRef], open, onClose);
    useEffect(() => {
        if (!open)
            return;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return () => {
            if (previousFocus?.isConnected)
                previousFocus.focus({ preventScroll: true });
        };
    }, [open]);
    useEffect(() => {
        if (!open)
            return;
        if (cursor < 0) {
            menuRef.current?.focus({ preventScroll: true });
            return;
        }
        menuRef.current
            ?.querySelector<HTMLElement>(`[data-menu-index="${cursor}"]`)
            ?.focus({ preventScroll: true });
    }, [open, cursor]);
    useEffect(() => {
        if (!open)
            return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
                return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setCursor((current) => {
                    let next = current;
                    for (let i = 0; i < items.length; i++) {
                        next = (next + step + items.length) % items.length;
                        if (!items[next]?.disabled)
                            return next;
                    }
                    return current;
                });
            }
            else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                const indexes = items
                    .map((item, index) => item.disabled ? -1 : index)
                    .filter((index) => index >= 0);
                setCursor(event.key === 'Home' ? (indexes[0] ?? -1) : (indexes[indexes.length - 1] ?? -1));
            }
            else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                const item = items[cursor];
                if (item && !item.disabled) {
                    item.onSelect?.();
                    onClose();
                }
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [open, items, cursor, onClose]);
    if (!open)
        return null;
    return createPortal(<div ref={menuRef} role="menu" aria-label={label} tabIndex={-1} className="anim-pop fixed z-[260] max-h-[420px] overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)] outline-none" style={{ top: position.top, left: position.left, width: menuWidth, transformOrigin: position.origin }}>
      {items.map((item, index) => (<div key={item.id}>
          {item.separatorBefore && <div role="separator" className="my-1 h-px bg-[var(--border-subtle)]"/>}
          <button type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked === undefined ? undefined : item.checked} tabIndex={index === cursor ? 0 : -1} data-menu-index={index} disabled={item.disabled} onMouseEnter={() => {
                if (!item.disabled)
                    setCursor(index);
            }} onClick={() => {
                item.onSelect?.();
                onClose();
            }} className={cn('flex h-10 w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2 text-left text-[12.5px] md:h-[30px]', 'transition-colors duration-[80ms] disabled:pointer-events-none disabled:opacity-40', index === cursor ? 'bg-[var(--bg-hover)]' : '', item.tone === 'danger'
                ? 'text-[var(--danger)]'
                : index === cursor
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)]')}>
            {item.icon && (<span className="flex size-4 shrink-0 items-center justify-center opacity-85">
                {item.icon}
              </span>)}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.checked && <span className="text-[var(--accent)]">✓</span>}
            {item.combo && <Kbd combo={item.combo}/>}
          </button>
        </div>))}
    </div>, document.body);
}
export function useContextMenu() {
    const [point, setPoint] = useState<{
        x: number;
        y: number;
    } | null>(null);
    return {
        point,
        close: () => setPoint(null),
        onContextMenu: (event: React.MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setPoint({ x: event.clientX, y: event.clientY });
        },
    };
}
export function Tooltip({ label, combo, children, side = 'bottom', delay = 420, }: {
    label: ReactNode;
    combo?: string;
    children: ReactNode;
    side?: 'top' | 'bottom' | 'left' | 'right';
    delay?: number;
}) {
    const holderRef = useRef<HTMLSpanElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<number>(0);
    const [rect, setRect] = useState<DOMRect | null>(null);
    const [position, setPosition] = useState<TooltipPosition | null>(null);
    const measureAnchor = useCallback(() => {
        const anchor = holderRef.current?.firstElementChild;
        if (!(anchor instanceof Element))
            return null;
        const next = anchor.getBoundingClientRect();
        return next.width || next.height ? next : null;
    }, []);
    const show = () => {
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
            const next = measureAnchor();
            if (next) {
                setPosition(null);
                setRect(next);
            }
        }, delay);
    };
    const hide = () => {
        window.clearTimeout(timerRef.current);
        setPosition(null);
        setRect(null);
    };
    useEffect(() => () => window.clearTimeout(timerRef.current), []);
    useLayoutEffect(() => {
        const tooltip = tooltipRef.current;
        if (!rect || !tooltip)
            return;
        setPosition(placeTooltip(rect, tooltip.getBoundingClientRect(), side));
    }, [combo, label, rect, side]);
    useEffect(() => {
        if (!rect)
            return;
        const update = () => {
            const next = measureAnchor();
            if (next)
                setRect(next);
            else {
                setPosition(null);
                setRect(null);
            }
        };
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [measureAnchor, rect]);
    const style: React.CSSProperties = position
        ? { top: position.top, left: position.left, visibility: 'visible' }
        : { top: 0, left: 0, visibility: 'hidden' };
    return (<>
      <span ref={holderRef} onMouseEnter={() => {
            if (typeof window.matchMedia !== 'function' || window.matchMedia('(hover: hover) and (pointer: fine)').matches)
                show();
        }} onMouseLeave={hide} onFocus={(event) => {
            if ((event.target as HTMLElement).matches(':focus-visible'))
                show();
        }} onBlur={hide} className="contents">
        {children}
      </span>
      {rect &&
            createPortal(<div ref={tooltipRef} role="tooltip" data-side={position?.side} className="anim-fade pointer-events-none fixed z-[500] flex max-w-[calc(100vw-16px)] items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2 py-1 text-[11.5px] whitespace-nowrap text-[var(--text-secondary)] shadow-[var(--shadow-pop)]" style={style}>
            {label}
            {combo && <Kbd combo={combo}/>}
          </div>, document.body)}
    </>);
}
type TooltipSide = 'top' | 'bottom' | 'left' | 'right';
interface TooltipPosition {
    top: number;
    left: number;
    side: TooltipSide;
}
function placeTooltip(anchor: DOMRect, tooltip: DOMRect, preferred: TooltipSide): TooltipPosition {
    const gap = 7;
    const padding = 8;
    const viewport = getVisibleViewport();
    const viewportLeft = viewport.left;
    const viewportTop = viewport.top;
    const viewportRight = viewport.right;
    const viewportBottom = viewport.bottom;
    let side = preferred;
    if (preferred === 'bottom' && anchor.bottom + gap + tooltip.height > viewportBottom - padding &&
        (anchor.top - gap - tooltip.height >= viewportTop + padding || anchor.top - viewportTop > viewportBottom - anchor.bottom)) {
        side = 'top';
    }
    else if (preferred === 'top' && anchor.top - gap - tooltip.height < viewportTop + padding &&
        (anchor.bottom + gap + tooltip.height <= viewportBottom - padding || viewportBottom - anchor.bottom > anchor.top - viewportTop)) {
        side = 'bottom';
    }
    else if (preferred === 'right' && anchor.right + gap + tooltip.width > viewportRight - padding &&
        (anchor.left - gap - tooltip.width >= viewportLeft + padding || anchor.left - viewportLeft > viewportRight - anchor.right)) {
        side = 'left';
    }
    else if (preferred === 'left' && anchor.left - gap - tooltip.width < viewportLeft + padding &&
        (anchor.right + gap + tooltip.width <= viewportRight - padding || viewportRight - anchor.right > anchor.left - viewportLeft)) {
        side = 'right';
    }
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
    if (side === 'top' || side === 'bottom') {
        return {
            side,
            top: side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - tooltip.height,
            left: clamp(anchor.left + anchor.width / 2 - tooltip.width / 2, viewportLeft + padding, viewportRight - tooltip.width - padding),
        };
    }
    return {
        side,
        top: clamp(anchor.top + anchor.height / 2 - tooltip.height / 2, viewportTop + padding, viewportBottom - tooltip.height - padding),
        left: side === 'right' ? anchor.right + gap : anchor.left - gap - tooltip.width,
    };
}
export function Drawer({ open, onClose, side = 'right', width = 380, children, title, zIndex = 190, }: {
    open: boolean;
    onClose: () => void;
    side?: 'left' | 'right';
    width?: number;
    children: ReactNode;
    title?: ReactNode;
    zIndex?: number;
}) {
    const panelRef = useRef<HTMLElement>(null);
    const titleId = useId();
    useEscape(open, onClose);
    useLockScroll(open);
    useDialogFocus(open, panelRef);
    if (!open)
        return null;
    return createPortal(<div className="app-viewport-fixed fixed" style={{ zIndex }}>
      <div className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden="true"/>
      <aside ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : t("overlay.side_panel")} tabIndex={-1} className={cn('absolute top-0 bottom-0 flex flex-col border-[var(--border-default)] bg-[var(--bg-surface)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-modal)] outline-none md:py-0', side === 'right' ? 'right-0 border-l' : 'left-0 border-r')} style={{
            width: Math.min(width, window.innerWidth < 768 ? window.innerWidth : window.innerWidth - 32),
            animation: `ink-slide-in-${side} var(--dur-slow) var(--ease-out) both`,
        }}>
        {title && (<header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
            <span id={titleId} className="text-[13px] font-semibold">{title}</span>
            <Tooltip label={t("common.close")} combo="escape" side="left">
              <IconButton label={t("common.close")} size="sm" onClick={onClose}>
                <X size={15}/>
              </IconButton>
            </Tooltip>
          </header>)}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>, document.body);
}
