import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Eye, Globe, Link2, Lock, Trash2 } from 'lucide-react';
import { LIMITS } from '@shared/constants';
import type { NoteSummary, ShareInfo } from '@shared/types';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fullTime } from '../../lib/time';
import { useRelativeTime } from '../../lib/hooks';
import { Badge, Button } from '../../components/primitives';
import { Field, Input, Segmented, Switch } from '../../components/form';
import { Modal, Tooltip, confirm } from '../../components/overlay';
import { Empty, LoadingBlock } from '../../components/feedback';
import { useUi } from '../../store/ui';
import { useActiveNote } from '../../store/notes';
import { t } from "../../lib/i18n";
import {
    expiresInForSelection,
    KEEP_CURRENT_EXPIRY,
    needsNewSharePasscode,
} from './share-form';
const EXPIRY_OPTIONS = [
    { value: '0', label: () => t("share.never_expires") },
    { value: String(24 * 3600000), label: () => t("share.1_day") },
    { value: String(7 * 24 * 3600000), label: () => t("share.7_days") },
    { value: String(30 * 24 * 3600000), label: () => t("share.30_days") },
];
export function SharePanel({ onClose, targetNote, onChanged }: {
    onClose: () => void;
    targetNote?: Pick<NoteSummary, 'id' | 'title'>;
    onChanged?: () => void;
}) {
    const { note: activeNote } = useActiveNote();
    const note = targetNote ?? activeNote;
    const toast = useUi((s) => s.toast);
    const [share, setShare] = useState<ShareInfo | null | undefined>(undefined);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [reload, setReload] = useState(0);
    const [password, setPassword] = useState('');
    const [usePassword, setUsePassword] = useState(false);
    const [expiry, setExpiry] = useState('0');
    const [busy, setBusy] = useState<'save' | 'revoke' | null>(null);
    const [copied, setCopied] = useState(false);
    const copiedTimer = useRef(0);
    const busyRef = useRef<'save' | 'revoke' | null>(null);
    const noteIdRef = useRef<string | null>(note?.id ?? null);
    const mutationEpoch = useRef(0);
    const loadEpoch = useRef(0);
    const createdTime = useRelativeTime(share?.createdAt ?? 0, Boolean(share));
    noteIdRef.current = note?.id ?? null;
    useEffect(() => {
        const epoch = ++loadEpoch.current;
        mutationEpoch.current++;
        busyRef.current = null;
        setBusy(null);
        if (!note) {
            setShare(undefined);
            return;
        }
        const noteId = note.id;
        const controller = new AbortController();
        let cancelled = false;
        setShare(undefined);
        setLoadError(null);
        setPassword('');
        setUsePassword(false);
        setExpiry('0');
        setCopied(false);
        window.clearTimeout(copiedTimer.current);
        api.share
            .get(note.id, controller.signal)
            .then((res) => {
            if (cancelled || loadEpoch.current !== epoch || noteIdRef.current !== noteId)
                return;
            setShare(res.share);
            setUsePassword(Boolean(res.share?.hasPassword));
            setExpiry(res.share?.expiresAt ? KEEP_CURRENT_EXPIRY : '0');
        })
            .catch((error) => {
            if (!cancelled && loadEpoch.current === epoch && noteIdRef.current === noteId)
                setLoadError(error instanceof Error ? error.message : String(error));
        });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [note?.id, reload]);
    useEffect(() => () => {
        noteIdRef.current = null;
        loadEpoch.current++;
        mutationEpoch.current++;
        busyRef.current = null;
        window.clearTimeout(copiedTimer.current);
    }, []);
    if (!note)
        return null;
    const create = async () => {
        if (busyRef.current || share === undefined || loadError)
            return;
        if (usePassword && password.length > 0 && password.length < 4) {
            toast({ title: t("share.passcode_too_short"), tone: 'danger' });
            return;
        }
        if (needsNewSharePasscode(usePassword, Boolean(share?.hasPassword), password)) {
            toast({ title: t("share.enter_a_passcode"), tone: 'danger' });
            return;
        }
        const noteId = note.id;
        const epoch = ++mutationEpoch.current;
        loadEpoch.current++;
        const wasShared = Boolean(share);
        busyRef.current = 'save';
        setBusy('save');
        try {
            const res = await api.share.create(noteId, {
                password: usePassword ? password || undefined : null,
                expiresIn: expiresInForSelection(expiry),
            });
            if (mutationEpoch.current !== epoch || noteIdRef.current !== noteId)
                return;
            setShare(res.share);
            setPassword('');
            setExpiry(res.share.expiresAt ? KEEP_CURRENT_EXPIRY : '0');
            onChanged?.();
            toast({ title: wasShared ? t("share.sharing_settings_updated") : t("share.public_link_created"), tone: 'success' });
        }
        catch (err) {
            if (mutationEpoch.current !== epoch || noteIdRef.current !== noteId)
                return;
            toast({
                title: t("common.action_failed"),
                description: err instanceof ApiError ? err.message : String(err),
                tone: 'danger',
            });
        }
        finally {
            if (mutationEpoch.current === epoch && noteIdRef.current === noteId) {
                busyRef.current = null;
                setBusy(null);
            }
        }
    };
    const revoke = async () => {
        if (busyRef.current)
            return;
        const noteId = note.id;
        const epoch = ++mutationEpoch.current;
        const previousShare = share;
        const previousUsePassword = usePassword;
        const previousExpiry = expiry;
        loadEpoch.current++;
        busyRef.current = 'revoke';
        setBusy('revoke');
        try {
            const ok = await confirm({
                title: t("share.revoke_this_public_link"),
                description: t("share.anyone_who_gets_the_link_will_immediately_lose_access"),
                confirmLabel: t("share.revoke_link"),
                tone: 'danger',
            });
            if (mutationEpoch.current !== epoch || noteIdRef.current !== noteId || !ok)
                return;
            setShare(null);
            setUsePassword(false);
            setExpiry('0');
            await api.share.remove(noteId);
            if (mutationEpoch.current !== epoch || noteIdRef.current !== noteId)
                return;
            onChanged?.();
            toast({ title: t("share.link_revoked") });
        }
        catch (err) {
            if (mutationEpoch.current !== epoch || noteIdRef.current !== noteId)
                return;
            setShare(previousShare);
            setUsePassword(previousUsePassword);
            setExpiry(previousExpiry);
            toast({
                title: t("common.action_failed"),
                description: err instanceof ApiError ? err.message : String(err),
                tone: 'danger',
            });
        }
        finally {
            if (mutationEpoch.current === epoch && noteIdRef.current === noteId) {
                busyRef.current = null;
                setBusy(null);
            }
        }
    };
    const copy = async () => {
        if (!share)
            return;
        const noteId = note.id;
        try {
            await navigator.clipboard.writeText(share.url);
            if (noteIdRef.current !== noteId)
                return;
            setCopied(true);
            window.clearTimeout(copiedTimer.current);
            copiedTimer.current = window.setTimeout(() => setCopied(false), 1400);
        }
        catch {
            if (noteIdRef.current !== noteId)
                return;
            toast({ title: t("preview.could_not_copy"), tone: 'danger' });
        }
    };
    return (<Modal open onClose={onClose} title={t("share.share_note")} description={`"${note.title || t("common.untitled_note")}"`} width={480} footer={share ? (<>
            <Button variant="ghost" className="mr-auto text-[var(--danger)]" icon={<Trash2 size={13}/>} loading={busy === 'revoke'} disabled={busy === 'save'} onClick={() => void revoke()}>{t("share.revoke_link")}</Button>
            <Button variant="secondary" disabled={busy !== null} onClick={onClose}>{t("share.done")}</Button>
            <Button variant="primary" loading={busy === 'save'} disabled={busy === 'revoke'} onClick={() => void create()}>{t("share.update_settings")}</Button>
          </>) : (<>
            <Button variant="ghost" disabled={busy !== null} onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" icon={<Globe size={13}/>} loading={busy === 'save'} disabled={share === undefined || busy !== null} onClick={() => void create()}>{t("share.generate_public_link")}</Button>
          </>)}>
      {loadError ? (<Empty art="notes" compact title={t("share.could_not_load_sharing_status")} description={loadError} action={<Button size="sm" variant="secondary" onClick={() => setReload((value) => value + 1)}>{t("common.retry")}</Button>}/>) : share === undefined ? (<LoadingBlock label={t("share.loading_share_status")}/>) : (<div className="space-y-4">
          {share && (<div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
              <div className="flex items-center gap-2">
                <Link2 size={13} className="shrink-0 text-[var(--accent)]"/>
                <input aria-label={t("share.public_link")} readOnly value={share.url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-[var(--text-secondary)] focus:outline-none"/>
                <Button size="sm" variant={copied ? 'ghost' : 'secondary'} icon={copied ? <Check size={12} className="text-[var(--success)]"/> : <Copy size={12}/>} onClick={() => void copy()}>
                  {copied ? t("common.copied") : t("common.copy")}
                </Button>
                <Tooltip label={t("share.open_link")} side="left">
                  <a href={share.url} target="_blank" rel="noreferrer" aria-label={t("share.open_link")} className="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-7">
                    <ExternalLink size={13}/>
                  </a>
                </Tooltip>
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-2.5 text-[11px] text-[var(--text-quaternary)]">
                <span className="flex items-center gap-1">
                  <Eye size={11}/>
                  {share.views}{t("share.visits")}</span>
                {share.hasPassword && <Badge tone="warning">{t("share.passcode_protected")}</Badge>}
                {share.expiresAt ? (<span className={cn(share.expiresAt < Date.now() && 'text-[var(--danger)]')}>
                    {share.expiresAt < Date.now()
                        ? t("share.expired") : t("share.expires_value0", { value0: fullTime(share.expiresAt) })}
                  </span>) : (<span>{t("share.never_expires_71ab34")}</span>)}
                <span className="ml-auto">{t("common.created")}{createdTime}</span>
              </div>
            </div>)}

          <div className="flex items-center justify-between gap-4 py-1">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                <Lock size={12} className="text-[var(--text-tertiary)]"/>{t("common.access_passcode")}</div>
              <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">{t("share.require_a_passcode_to_view_this_note")}</p>
            </div>
            <Switch checked={usePassword} disabled={busy !== null} onChange={setUsePassword} label={t("common.access_passcode")}/>
          </div>

          {usePassword && (<Field label={t("share.passcode")} hint={share?.hasPassword ? t("share.leave_blank_to_keep_the_current_passcode") : undefined}>
              <Input type="password" value={password} disabled={busy !== null} maxLength={LIMITS.passwordMaxLength} onChange={(e) => setPassword(e.target.value)} placeholder={share?.hasPassword ? t("share.unchanged") : t("share.set_a_passcode")} autoComplete="new-password"/>
            </Field>)}

          <Field label={t("share.expiration")}>
            <Segmented value={expiry} disabled={busy !== null} onChange={setExpiry} options={[
                ...(share?.expiresAt ? [{ value: KEEP_CURRENT_EXPIRY, label: t("share.keep_current_expiration") }] : []),
                ...EXPIRY_OPTIONS.map((option) => ({
                ...option,
                label: option.label(),
            })),
            ]}/>
          </Field>

          <p className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{t("share.public_links_are_read_only_visitors_can_see_only_the_latest_version_of_t")}</p>
        </div>)}
    </Modal>);
}
