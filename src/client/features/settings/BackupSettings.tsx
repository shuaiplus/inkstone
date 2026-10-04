import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, CloudUpload, ExternalLink, HardDrive, Loader2, MoreHorizontal, Plus, Server, Trash2, Zap, } from 'lucide-react';
import type { BackupRun, BackupSchedule, BackupTarget, BackupTargetInput, BackupTargetType, TestConnectionResult, } from '@shared/types';
import { cn } from '../../lib/cn';
import { api, ApiError } from '../../lib/api';
import { formatBytes, formatDuration } from '../../lib/time';
import { useRelativeTime } from '../../lib/hooks';
import { Badge, Button, IconButton } from '../../components/primitives';
import { Checkbox, Field, Input, Select, Segmented, SettingRow, Switch } from '../../components/form';
import { Modal, Tooltip, confirm } from '../../components/overlay';
import { Empty } from '../../components/feedback';
import { SettingsLoading as LoadingBlock } from './SettingsLoading';
import { getBackupPresets, type BackupPreset } from './backupPresets';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { t, translateServiceMessage } from "../../lib/i18n";
import { useSettingsResource } from './resource';
import { backupTargetsResource, backupRunsResource } from './resources';
export function BackupSettings() {
    const settings = useSession((s) => s.settings);
    const update = useSession((s) => s.updateSettings);
    const toast = useUi((s) => s.toast);
    const [targets, setTargets] = useSettingsResource(backupTargetsResource);
    const [cachedRuns] = useSettingsResource(backupRunsResource);
    const runs = cachedRuns ?? [];
    const [editing, setEditing] = useState<BackupTarget | 'new' | null>(null);
    const [running, setRunning] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const reloadEpoch = useRef(0);
    const runningRef = useRef(false);
    const mountedRef = useRef(true);
    const reload = useCallback(async (force = true) => {
        if (!mountedRef.current)
            return;
        const epoch = ++reloadEpoch.current;
        try {
            await Promise.all([backupTargetsResource.load(force), backupRunsResource.load(force)]);
            if (!mountedRef.current || epoch !== reloadEpoch.current)
                return;
            setLoadError(null);
        }
        catch (error) {
            if (!mountedRef.current || epoch !== reloadEpoch.current)
                return;
            setLoadError(error instanceof ApiError ? error.message : String(error));
        }
    }, []);
    useEffect(() => {
        mountedRef.current = true;
        void reload(false);
        return () => {
            mountedRef.current = false;
            runningRef.current = false;
            reloadEpoch.current++;
        };
    }, [reload]);
    const runBackup = async () => {
        if (runningRef.current)
            return;
        runningRef.current = true;
        setRunning(true);
        try {
            const run = await api.backup.run();
            await reload();
            const ok = run.results.filter((r) => r.ok).length;
            const cleanupWarning = run.results.find((result) => result.warning)?.warning;
            toast({
                title: run.status === 'success'
                    ? t("settings.backup_completed_value0_targets", { value0: ok }) : run.status === 'partial'
                    ? t("settings.partially_completed_value0_value1", { value0: ok, value1: run.results.length }) : t("settings.backup_failed"),
                description: run.status === 'success'
                    ? cleanupWarning ? `${t("settings.backup_cleanup_warning")} ${translateServiceMessage(cleanupWarning)}` : t("settings.value0_notes_value1", { value0: run.noteCount, value1: formatBytes(run.bytes) }) : translateServiceMessage(run.results.find((r) => !r.ok)?.error) || t("settings.no_enabled_backup_targets"),
                tone: run.status === 'success' ? cleanupWarning ? 'warning' : 'success' : run.status === 'partial' ? 'warning' : 'danger',
                duration: 8000,
            });
        }
        catch (err) {
            toast({
                title: t("settings.backup_failed"),
                description: err instanceof ApiError ? err.message : String(err),
                tone: 'danger',
            });
        }
        finally {
            backupTargetsResource.invalidate();
            backupRunsResource.invalidate();
            runningRef.current = false;
            if (mountedRef.current)
                setRunning(false);
        }
    };
    if ((targets === null || cachedRuns === null) && loadError)
        return (<div className="rounded-[var(--r-lg)] border border-[color-mix(in_oklab,var(--danger)_28%,var(--border-subtle))] bg-[var(--bg-base)] p-4">
          <div className="flex items-start gap-3">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-[var(--danger)]"/>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-[var(--text-primary)]">{t("settings.could_not_load_backup_settings")}</div>
              <p className="mt-1 break-words text-[11.5px] text-[var(--text-tertiary)]">{loadError}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void reload()}>{t("common.retry")}</Button>
          </div>
        </div>);
    if (targets === null || cachedRuns === null)
        return <LoadingBlock label={t("settings.loading_backup_configuration")}/>;
    const enabled = targets.filter((t) => t.enabled).length;
    return (<div className="space-y-6">
      {loadError && (<div className="flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_25%,var(--border-subtle))] bg-[var(--bg-base)] px-3 py-2 text-[11.5px] text-[var(--danger)]">
          <AlertCircle size={13} className="mt-0.5 shrink-0"/>
          <span className="min-w-0 flex-1 break-words">{loadError}</span>
          <button type="button" className="shrink-0 font-medium underline underline-offset-2" onClick={() => void reload()}>{t("common.retry")}</button>
        </div>)}
      { }
      <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-[var(--accent)]">
            <CloudUpload size={18}/>
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[var(--text-primary)]">
              {enabled > 0 ? t("settings.value0_backup_targets_active", { value0: enabled }) : t("settings.no_backup_configured_yet")}
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{t("settings.each_backup_goes_independently_to_every_enabled_target_it_includes_notes")}</p>
          </div>
          <Button size="sm" variant="primary" icon={running ? undefined : <Zap size={13}/>} loading={running} disabled={!enabled} onClick={() => void runBackup()}>{t("settings.back_up_now")}</Button>
        </div>
      </section>

      { }
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.backup_target")}</h3>
          <Button size="sm" variant="secondary" icon={<Plus size={13}/>} onClick={() => setEditing('new')}>{t("settings.add_target")}</Button>
        </div>

        {targets.length === 0 ? (<div className="rounded-[var(--r-lg)] border border-dashed border-[var(--border-default)]">
            <Empty art="archive" compact title={t("settings.no_backup_target_yet")} description={t("settings.add_a_webdav_or_s3_compatible_target_or_choose_a_common_provider_preset")} action={<Button size="sm" icon={<Plus size={13}/>} onClick={() => setEditing('new')}>{t("settings.add_first_target")}</Button>}/>
          </div>) : (<div className="space-y-2">
            {targets.map((target) => (<TargetCard key={target.id} target={target} onEdit={() => setEditing(target)} onChanged={reload} onPatch={(id, patch) => setTargets((current) => current?.map((item) => item.id === id ? { ...item, ...patch } : item) ?? current)} onRemove={(id) => setTargets((current) => current?.filter((item) => item.id !== id) ?? current)} onRestore={(removed) => setTargets((current) => current && !current.some((item) => item.id === removed.id) ? [...current, removed] : current)}/>))}
          </div>)}
      </section>

      { }
      <section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.automatic_backups")}</h3>
        <SettingRow title={t("settings.frequency")} description={t("settings.runs_from_cloudflare_cron_the_page_does_not_need_to_stay_open")}>
          <Select aria-label={t("settings.frequency")} className="min-w-36" value={settings.backup.schedule} onChange={(event) => void update({ backup: { schedule: event.target.value as BackupSchedule } })}>
            <option value="off">{t("common.close")}</option>
            <option value="hourly">{t("settings.hourly")}</option>
            <option value="sixHourly">{t("settings.every_6_hours")}</option>
            <option value="daily">{t("settings.daily")}</option>
            <option value="weekly">{t("settings.weekly")}</option>
            <option value="monthly">{t("settings.monthly")}</option>
            <option value="yearly">{t("settings.yearly")}</option>
          </Select>
        </SettingRow>
        <SettingRow title={t("settings.backup_retention")} description={t("settings.backup_retention_description")}>
          <Select aria-label={t("settings.backup_retention")} className="min-w-36" value={settings.backup.retentionCount} onChange={(event) => void update({ backup: { retentionCount: Number(event.target.value) } })}>
            <option value="0">{t("settings.keep_all_backups")}</option>
            {[7, 14, 30, 90, 365].map((count) => <option key={count} value={count}>{t("settings.keep_latest_backups", { count })}</option>)}
            {settings.backup.retentionCount > 0 && ![7, 14, 30, 90, 365].includes(settings.backup.retentionCount) && <option value={settings.backup.retentionCount}>{t("settings.keep_latest_backups", { count: settings.backup.retentionCount })}</option>}
          </Select>
        </SettingRow>
      </section>

      { }
      <section>
        <h3 className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.latest_backups")}</h3>
        {runs.length === 0 ? (<p className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-4 text-center text-[12px] text-[var(--text-quaternary)]">{t("settings.no_backup_record_yet")}</p>) : (<ul className="space-y-1">
            {runs.slice(0, 12).map((run) => (<RunRow key={run.id} run={run}/>))}
          </ul>)}
      </section>

      {editing && (<TargetForm target={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => {
                setEditing(null);
                await reload();
            }}/>)}
    </div>);
}

function TargetCard({ target, onEdit, onChanged, onPatch, onRemove, onRestore, }: {
    target: BackupTarget;
    onEdit: () => void;
    onChanged: () => Promise<void>;
    onPatch: (id: string, patch: Partial<BackupTarget>) => void;
    onRemove: (id: string) => void;
    onRestore: (target: BackupTarget) => void;
}) {
    const toast = useUi((s) => s.toast);
    const [testing, setTesting] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [result, setResult] = useState<TestConnectionResult | null>(null);
    const actionRef = useRef(false);
    const busy = testing || deleting || updating;
    const lastRunTime = useRelativeTime(target.lastRunAt ?? 0, Boolean(target.lastRunAt));
    useEffect(() => setResult(null), [target.updatedAt]);
    const config = target.config as unknown as Record<string, unknown>;
    const location = target.type === 's3'
        ? `${String(config.bucket ?? '')}${config.prefix ? `/${config.prefix}` : ''}`
        : String(config.url ?? '');
    return (<div className={cn('rounded-[var(--r-lg)] border bg-[var(--bg-base)] p-3 transition-colors', target.enabled ? 'border-[var(--border-subtle)]' : 'border-[var(--border-subtle)] opacity-60')}>
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)]', 'bg-[var(--bg-raised)] text-[var(--text-tertiary)]')}>
          {target.type === 's3' ? <HardDrive size={15}/> : <Server size={15}/>}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
              {target.name}
            </span>
            <Badge tone="neutral">{target.type === 's3' ? 'S3' : 'WebDAV'}</Badge>
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-[var(--text-quaternary)]">{location}</div>

          {target.lastRunAt && (<div className={cn('mt-1.5 flex items-center gap-1.5 text-[11px]', target.lastStatus === 'success' ? 'text-[var(--success)]' : 'text-[var(--danger)]')}>
              {target.lastStatus === 'success' ? (<CheckCircle2 size={11}/>) : (<AlertCircle size={11}/>)}
              {target.lastStatus === 'success' ? t("settings.last_backup_succeeded") : translateServiceMessage(target.lastError) || t("settings.last_backup_failed")}
              <span className="text-[var(--text-quaternary)]">· {lastRunTime}</span>
            </div>)}

          {result && (<div className={cn('mt-1.5 flex items-start gap-1.5 rounded-[var(--r-sm)] px-2 py-1.5 text-[11px]', result.ok
                ? 'bg-[color-mix(in_oklab,var(--success)_12%,transparent)] text-[var(--success)]'
                : 'bg-[color-mix(in_oklab,var(--danger)_11%,transparent)] text-[var(--danger)]')}>
              {result.ok ? <CheckCircle2 size={11} className="mt-px"/> : <AlertCircle size={11} className="mt-px"/>}
              <span className="min-w-0 flex-1">
                {translateServiceMessage(result.message)}
                {result.latencyMs ? ` · ${result.latencyMs}ms` : ''}
              </span>
            </div>)}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Switch checked={target.enabled} disabled={busy} label={t("settings.enabled")} onChange={async (enabled) => {
            if (actionRef.current)
                return;
            actionRef.current = true;
            setUpdating(true);
            onPatch(target.id, { enabled });
            try {
                await api.backup.patch(target.id, { enabled, expectedUpdatedAt: target.updatedAt });
                await onChanged();
            }
            catch (error) {
                onPatch(target.id, { enabled: target.enabled });
                toast({ title: t("settings.update_failed"), description: error instanceof ApiError ? error.message : String(error), tone: 'danger' });
            }
            finally {
                actionRef.current = false;
                setUpdating(false);
            }
        }}/>
          <Button size="sm" variant="ghost" loading={testing} disabled={updating || deleting} onClick={async () => {
            if (actionRef.current)
                return;
            actionRef.current = true;
            setTesting(true);
            setResult(null);
            try {
                setResult(await api.backup.test(target.id));
            }
            catch (err) {
                setResult({ ok: false, message: err instanceof ApiError ? err.message : String(err) });
            }
            finally {
                actionRef.current = false;
                setTesting(false);
            }
        }}>
            {testing ? <Loader2 size={12} className="animate-[ink-spin_.7s_linear_infinite]"/> : t("settings.test")}
          </Button>
          <Tooltip label={t("common.edit")}>
            <IconButton label={t("common.edit")} size="sm" disabled={busy} onClick={onEdit}>
              <MoreHorizontal size={14}/>
            </IconButton>
          </Tooltip>
          <Tooltip label={t("common.delete")} side="left">
            <IconButton label={t("common.delete")} size="sm" disabled={busy} className="text-[var(--text-quaternary)] hover:text-[var(--danger)]" onClick={async () => {
            if (actionRef.current)
                return;
            actionRef.current = true;
            setDeleting(true);
            try {
                const ok = await confirm({
                    title: t("settings.delete_backup_target_value0", { value0: target.name }),
                    description: t("settings.files_that_have_been_backed_up_there_will_not_be_deleted"),
                    confirmLabel: t("common.delete"),
                    tone: 'danger',
                });
                if (!ok)
                    return;
                onRemove(target.id);
                await api.backup.remove(target.id);
                toast({ title: t("settings.backup_target_deleted") });
                await onChanged();
            }
            catch (error) {
                onRestore(target);
                toast({ title: t("common.delete_failed"), description: error instanceof ApiError ? error.message : String(error), tone: 'danger' });
            }
            finally {
                actionRef.current = false;
                setDeleting(false);
            }
        }}>
            {deleting ? <Loader2 size={12} className="animate-[ink-spin_.7s_linear_infinite]"/> : <Trash2 size={13}/>}
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </div>);
}
function TargetForm({ target, onClose, onSaved, }: {
    target: BackupTarget | null;
    onClose: () => void;
    onSaved: () => Promise<void>;
}) {
    const backupPresets = getBackupPresets();
    const config = (target?.config ?? {}) as unknown as Record<string, unknown>;
    const [type, setType] = useState<BackupTargetType>(target?.type ?? 's3');
    const [name, setName] = useState(target?.name ?? '');
    const [form, setForm] = useState({
        endpoint: String(config.endpoint ?? ''),
        region: String(config.region ?? 'auto'),
        bucket: String(config.bucket ?? ''),
        prefix: String(config.prefix ?? 'inkstone'),
        pathStyle: config.pathStyle !== false,
        url: String(config.url ?? ''),
        username: String(config.username ?? ''),
    });
    const [secret, setSecret] = useState({ accessKeyId: '', secretAccessKey: '', password: '' });
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [result, setResult] = useState<TestConnectionResult | null>(null);
    const [activePreset, setActivePreset] = useState<string | null>(null);
    const actionRef = useRef(false);
    const toast = useUi((s) => s.toast);
    const canKeepSecret = Boolean(target?.hasSecret && type === target.type);
    useEffect(() => setResult(null), [type, form, secret]);
    const applyFields = (fields: BackupPreset['fields']) => {
        setForm((f) => ({
            ...f,
            endpoint: fields.endpoint !== undefined ? fields.endpoint : f.endpoint,
            region: fields.region !== undefined ? fields.region : f.region,
            pathStyle: fields.pathStyle ?? f.pathStyle,
            url: fields.url !== undefined ? fields.url : f.url,
        }));
    };
    const applyBackupPreset = (preset: BackupPreset) => {
        setActivePreset(preset.id);
        setType(preset.type);
        setName(preset.name);
        applyFields(preset.fields);
    };
    const selectType = (nextType: BackupTargetType) => {
        if (nextType === type)
            return;
        setType(nextType);
        if (activePreset)
            setName('');
        setActivePreset(null);
    };
    const guide = backupPresets.find((p) => p.id === activePreset) ?? null;
    const recommendedPresets = backupPresets.filter((preset) => preset.type === type);
    const buildPayload = (): BackupTargetInput => ({
        type,
        name: name || (type === 's3' ? t("settings.s3_backup") : t("settings.webdav_backup")),
        config: type === 's3'
            ? {
                endpoint: form.endpoint,
                region: form.region,
                bucket: form.bucket,
                prefix: form.prefix,
                pathStyle: form.pathStyle,
                mode: 'archive',
            }
            : { url: form.url, username: form.username, prefix: form.prefix, mode: 'archive' },
        secret: type === 's3'
            ? { accessKeyId: secret.accessKeyId, secretAccessKey: secret.secretAccessKey }
            : { password: secret.password },
    });
    const save = async () => {
        if (actionRef.current)
            return;
        actionRef.current = true;
        setSaving(true);
        try {
            if (target)
                await api.backup.patch(target.id, { ...buildPayload(), expectedUpdatedAt: target.updatedAt });
            else
                await api.backup.create(buildPayload());
            toast({ title: target ? t("settings.backup_target_updated") : t("settings.backup_target_added"), tone: 'success' });
            await onSaved();
        }
        catch (err) {
            toast({
                title: t("common.save_failed"),
                description: err instanceof ApiError ? err.message : String(err),
                tone: 'danger',
            });
        }
        finally {
            actionRef.current = false;
            setSaving(false);
        }
    };
    const test = async () => {
        if (actionRef.current)
            return;
        actionRef.current = true;
        setTesting(true);
        setResult(null);
        try {
            const payload = buildPayload();
            setResult(target
                ? await api.backup.test(target.id, payload)
                : await api.backup.testDraft(payload));
        }
        catch (err) {
            setResult({ ok: false, message: err instanceof ApiError ? err.message : String(err) });
        }
        finally {
            actionRef.current = false;
            setTesting(false);
        }
    };
    const close = () => {
        if (!actionRef.current)
            onClose();
    };
    return (<Modal open onClose={close} title={target ? t("settings.edit_backup_target") : t("settings.add_backup_target")} description={canKeepSecret ? t("settings.leave_the_key_blank_to_leave_it_unchanged") : undefined} width={520} footer={<>
          <Button variant="ghost" onClick={close} disabled={saving || testing}>{t("common.cancel")}</Button>
          <Button variant="secondary" loading={testing} disabled={saving} onClick={() => void test()}>{t("settings.test_connection")}</Button>
          <Button variant="primary" loading={saving} disabled={testing} onClick={() => void save()}>{t("common.save")}</Button>
        </>}>
      <fieldset disabled={saving || testing} aria-busy={saving || testing} className="min-w-0 space-y-3.5 border-0 p-0">
        {target && type !== target.type && (<div className="flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--warning)_28%,var(--border-subtle))] bg-[var(--bg-inset)] px-3 py-2 text-[11.5px] text-[var(--warning)]">
            <AlertCircle size={13} className="mt-0.5 shrink-0"/>
            <span>{t("settings.enter_the_complete_credentials_for_the_new_backup_type_after_switching_t")}</span>
          </div>)}
        <Field label={t("settings.type")}>
          <Segmented<BackupTargetType> value={type} onChange={selectType} options={[
            { value: 's3', label: t("settings.s3_compatible") },
            { value: 'webdav', label: 'WebDAV' },
        ]}/>
        </Field>

        {!target && (<div className="space-y-2.5">
            <p className="text-[11px] font-medium tracking-[0.04em] text-[var(--text-quaternary)]">
              {type === 'webdav' ? 'WebDAV' : 'S3'} · {t("settings.common_provider_presets_optional_click_to_autofill")}</p>
            <div className="grid grid-cols-3 gap-1.5">
              {recommendedPresets.map((preset) => (<button key={preset.id} type="button" onClick={() => applyBackupPreset(preset)} className={cn('flex flex-col gap-0.5 rounded-[var(--r-md)] border px-2.5 py-2 text-left', 'transition-colors duration-[var(--dur-fast)]', activePreset === preset.id
                    ? 'border-[var(--accent)] bg-[var(--accent-softer)]'
                    : 'border-[var(--border-default)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]')}>
                  <span className="flex w-full items-center justify-between gap-1">
                    <span className={cn('truncate text-[12px] font-medium', activePreset === preset.id ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]')}>
                      {preset.name}
                    </span>
                    <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-[var(--text-quaternary)]">
                      {preset.type === 'webdav' ? 'DAV' : 'S3'}
                    </span>
                  </span>
                  <span className="text-[10.5px] text-[var(--success)]">{preset.quota}</span>
                </button>))}
            </div>

            {guide && (<div className="anim-rise rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--accent)_28%,transparent)] bg-[var(--accent-softer)] px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-[var(--text-primary)]">
                    {guide.name} · {guide.tagline}
                  </span>
                  <a href={guide.signupUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
                    {guide.signupLabel ?? t("settings.sign_up")}
                    <ExternalLink size={10}/>
                  </a>
                </div>
                <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-[var(--text-secondary)] marker:text-[var(--accent)]">
                  {guide.steps.map((step, index) => (<li key={index}>
                      {step.map((part, partIndex) => part.href ? (<a key={partIndex} href={part.href} target="_blank" rel="noopener noreferrer" className="font-medium text-[var(--accent)] underline decoration-[color-mix(in_oklab,var(--accent)_35%,transparent)] underline-offset-2 hover:decoration-[var(--accent)]">
                          {part.text}
                        </a>) : (<span key={partIndex}>{part.text}</span>))}
                    </li>))}
                </ol>
                {guide.addressIntro && guide.addresses && (<div className="mt-2 border-t border-[color-mix(in_oklab,var(--accent)_18%,transparent)] pt-2">
                    <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">{guide.addressIntro}</p>
                    <dl className="mt-1.5 grid gap-1 sm:grid-cols-2">
                      {guide.addresses.map((address) => (<div key={address.label} className="min-w-0 rounded-[var(--r-sm)] bg-[var(--bg-surface)] px-2 py-1.5">
                          <dt className="text-[10.5px] font-medium text-[var(--text-secondary)]">{address.label}</dt>
                          <dd className="mt-0.5 overflow-x-auto whitespace-nowrap font-mono text-[10px] text-[var(--text-quaternary)]">{address.url}</dd>
                        </div>))}
                    </dl>
                  </div>)}
              </div>)}
          </div>)}

        <Field label={t("settings.name")} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("settings.for_example_primary_r2_backup")}/>
        </Field>

        {type === 's3' ? (<>
            <Field label={t("settings.endpoint")} hint={t("settings.leave_blank_unless_the_provider_requires_it_for_r2_use_url")}>
              <Input value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="https://…"/>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("settings.bucket")} required>
                <Input value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })} placeholder="my-notes-backup"/>
              </Field>
              <Field label={t("settings.region")}>
                <Input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} placeholder="auto"/>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("settings.access_key_id")} required={!canKeepSecret}>
                <Input value={secret.accessKeyId} onChange={(e) => setSecret({ ...secret, accessKeyId: e.target.value })} placeholder={canKeepSecret ? t("settings.unchanged") : ''} autoComplete="off"/>
              </Field>
              <Field label={t("settings.secret_access_key")} required={!canKeepSecret}>
                <Input type="password" value={secret.secretAccessKey} onChange={(e) => setSecret({ ...secret, secretAccessKey: e.target.value })} placeholder={canKeepSecret ? t("settings.unchanged") : ''} autoComplete="new-password"/>
              </Field>
            </div>
            <Checkbox checked={form.pathStyle} onChange={(pathStyle) => setForm({ ...form, pathStyle })} label={t("settings.use_path_style_access_recommended_for_most_compatible_services")}/>
          </>) : (<>
            <Field label={t("settings.webdav_address")} required hint={t("settings.https_only_redirects_within_the_same_site_are_handled_automatically")}>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://dav.example.com/dav/"/>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("common.username")} required>
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off"/>
              </Field>
              <Field label={t("common.password")} required={!canKeepSecret} hint={t("settings.use_an_app_specific_password_when_possible")}>
                <Input type="password" value={secret.password} onChange={(e) => setSecret({ ...secret, password: e.target.value })} placeholder={canKeepSecret ? t("settings.unchanged") : ''} autoComplete="new-password"/>
              </Field>
            </div>
          </>)}

        <Field label={t("settings.subdirectory")} hint={t("settings.store_backups_in_this_directory_or_leave_blank_to_use_the_root_directory")}>
          <Input value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} placeholder="inkstone"/>
        </Field>

        {result && (<div role={result.ok ? 'status' : 'alert'} className={cn('flex items-start gap-2 rounded-[var(--r-md)] px-3 py-2.5 text-[12px] leading-relaxed', result.ok
                ? 'bg-[color-mix(in_oklab,var(--success)_12%,transparent)] text-[var(--success)]'
                : 'bg-[color-mix(in_oklab,var(--danger)_11%,transparent)] text-[var(--danger)]')}>
            {result.ok ? (<CheckCircle2 size={13} className="mt-px shrink-0"/>) : (<AlertCircle size={13} className="mt-px shrink-0"/>)}
            <span>{translateServiceMessage(result.message)}</span>
          </div>)}
      </fieldset>
    </Modal>);
}
function RunRow({ run }: {
    run: BackupRun;
}) {
    const [open, setOpen] = useState(false);
    const tone = run.status === 'success' ? 'success' : run.status === 'partial' ? 'warning' : 'danger';
    const startedTime = useRelativeTime(run.startedAt);
    return (<li className="overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]">
        <span className={cn('size-1.5 shrink-0 rounded-full', tone === 'success'
            ? 'bg-[var(--success)]'
            : tone === 'warning'
                ? 'bg-[var(--warning)]'
                : 'bg-[var(--danger)]')}/>
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">
          {startedTime} · {run.trigger === 'cron' ? t("settings.scheduled") : t("settings.manual")}
        </span>
        <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]">
          {run.noteCount}{t("settings.notes")}{formatBytes(run.bytes)}
          {run.finishedAt ? ` · ${formatDuration(run.finishedAt - run.startedAt)}` : ''}
        </span>
      </button>

      {open && run.results.length > 0 && (<ul className="border-t border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2">
          {run.results.map((result, index) => (<li key={`${result.targetId}-${index}`} className="flex items-start gap-2 py-1 text-[11.5px]">
              {result.ok ? (<CheckCircle2 size={11} className="mt-0.5 shrink-0 text-[var(--success)]"/>) : (<AlertCircle size={11} className="mt-0.5 shrink-0 text-[var(--danger)]"/>)}
              <span className="shrink-0 text-[var(--text-secondary)]">{result.targetName}</span>
              <span className="min-w-0 flex-1 text-[var(--text-quaternary)]">
                {result.ok
                    ? t("settings.value0_files_value1_value2", { value0: result.files, value1: formatBytes(result.bytes), value2: formatDuration(result.ms) }) : translateServiceMessage(result.error)}
                {result.warning && <span className="mt-1 block text-[var(--warning)]">{t("settings.backup_cleanup_warning")} {translateServiceMessage(result.warning)}</span>}
              </span>
            </li>))}
        </ul>)}
    </li>);
}
