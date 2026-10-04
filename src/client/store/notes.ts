/** Coordinates the note cache, offline write-ahead log, optimistic updates, and server synchronization. */
import { create, type StoreApi } from 'zustand';
import { useMemo } from 'react';
import { countText, deriveExcerpt, extractTags, normalizeLinkKey, sortTagNames } from '@shared/markdown-utils';
import { duplicateNoteTitle } from '@shared/text-utils';
import { LIMITS } from '@shared/constants';
import type { AppLocale, Folder, Note, NoteSummary, SortKey, SortOrder, SyncResponse, Tag, ViewKind, } from '@shared/types';
import { api, ApiError, CLIENT_ID } from '../lib/api';
import { localDb, publishBroadcast, type BroadcastPayload, type OutboxItem } from '../lib/db';
import { folderDescendantIds } from '../lib/folders';
import { useSession } from './session';
import { useUi, type WorkspacePane } from './ui';
import { getLocale, t, useLocale } from "../lib/i18n";
export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'synced' | 'offline';
interface NotesState {
    notes: Record<string, NoteSummary>;
    contents: Record<string, string>;
    noteLoadErrors: Record<string, string>;
    folders: Folder[];
    tags: Tag[];
    cursor: number;
    hydrated: boolean;
    loading: boolean;
    saveStatus: SaveStatus;
    lastSavedAt: number;
    pendingCount: number;
    online: boolean;
    bootstrap: () => Promise<void>;
    pull: (options?: {
        force?: boolean;
    }) => Promise<void>;
    openNote: (id: string, options?: {
        pane?: WorkspacePane;
        activate?: boolean;
        revealOnMobile?: boolean;
    }) => Promise<void>;
    editTitle: (id: string, title: string) => void;
    editContent: (id: string, content: string) => void;
    flush: (options?: {
        immediate?: boolean;
    }) => Promise<void>;
    createNote: (input?: {
        id?: string;
        title?: string;
        content?: string;
        folderId?: string | null;
        isStarred?: boolean;
        open?: boolean;
    }) => Promise<string | null>;
    patchNote: (id: string, patch: Partial<Pick<NoteSummary, 'isPinned' | 'isStarred' | 'isArchived'>> & {
        folderId?: string | null;
    }) => Promise<void>;
    deleteNote: (id: string) => Promise<void>;
    restoreNote: (id: string) => Promise<void>;
    restoreVersion: (id: string, versionId: string, content: string, title?: string) => Promise<boolean>;
    purgeNote: (id: string) => Promise<void>;
    emptyTrash: () => Promise<number | null>;
    duplicateNote: (id: string) => Promise<void>;
    createFolder: (input?: {
        name?: string;
        parentId?: string | null;
        icon?: string | null;
        color?: string | null;
    }) => string | null;
    patchFolder: (id: string, patch: {
        name?: string;
        parentId?: string | null;
        beforeId?: string | null;
        icon?: string | null;
        color?: string | null;
    }) => boolean;
    deleteFolder: (id: string) => boolean;
    refreshFolders: () => Promise<void>;
    refreshTags: () => Promise<void>;
    replayPending: () => Promise<void>;
    setOnline: (online: boolean) => void;
    applySync: (payload: SyncResponse) => void;
}
type SetNotesState = StoreApi<NotesState>['setState'];
let saveTimer: number | undefined;
const SUMMARY_DERIVE_DELAY_MS = 70;
const NOTE_SWITCH_FEEDBACK_DELAY_MS = 180;
interface PendingSummaryDerivation {
    content: string;
    updatedAt: number;
    timer: number;
    set: SetNotesState;
    get: () => NotesState;
}
const pendingSummaryDerivations = new Map<string, PendingSummaryDerivation>();
let bootstrapPromise: Promise<void> | null = null;
let pullPromise: Promise<void> | null = null;
let forcePullQueued = false;
let outboxReplayPromise: Promise<void> | null = null;
let folderStateGeneration = 0;
let tagStateGeneration = 0;
let folderRefreshSequence = 0;
let tagRefreshSequence = 0;
const openSequences: Record<WorkspacePane, number> = { primary: 0, secondary: 0 };
const latestRequestedNoteIds: Record<WorkspacePane, string | null> = { primary: null, secondary: null };

const noteWriteTails = new Map<string, Promise<void>>();
type OptimisticNotePatch = Partial<Pick<NoteSummary, 'folderId' | 'isPinned' | 'isStarred' | 'isArchived' | 'deletedAt' | 'updatedAt'>>;
interface PendingNoteMutation {
    patch: OptimisticNotePatch;
    before: NoteSummary;
}

const pendingNoteMutations = new Map<string, PendingNoteMutation[]>();
const pendingNoteCreates = new Map<string, Promise<Note>>();

interface PendingFolderMutation {
    entityId: string;
    restoreMissingEntity: boolean;
    before: Folder[];
    apply: (folders: Folder[]) => Folder[];
}
const pendingFolderMutations: PendingFolderMutation[] = [];
const folderWriteTails = new Map<string, Promise<void>>();

interface DirtyNoteWrite {
    title?: string;
    content: string;
    contentDirty: boolean;
    rev: number;
    writeId: string;
    queueId: string;
    dependsOnWriteId?: string;
    updatedAt: number;
    persisted: Promise<boolean>;
}
const dirty = new Map<string, DirtyNoteWrite>();

const inheritedOutboxWrites = new Map<string, string>();
type RecoveryResult = Pick<
    Extract<BroadcastPayload, { type: 'outbox-result' }>,
    'outcome' | 'recoveryReason' | 'rev' | 'updatedAt' | 'copyId'
>;

const recoveredOutboxWrites = new Map<string, RecoveryResult>();

const noteRequests = new Map<string, Promise<Note>>();

const validatedRevisions = new Map<string, number>();

const purgedNoteIds = new Map<string, number | null>();
const noteRequestEpochs = new Map<string, number>();
const STALE_NOTE_REQUEST = Symbol('stale-note-request');
export const useNotes = create<NotesState>((set, get) => ({
    notes: {},
    contents: {},
    noteLoadErrors: {},
    folders: [],
    tags: [],
    cursor: 0,
    hydrated: false,
    loading: false,
    saveStatus: 'idle',
    lastSavedAt: 0,
    pendingCount: 0,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    bootstrap() {

        if (bootstrapPromise)
            return bootstrapPromise;
        const run = async () => {
            set({ loading: true });
            try {
                const userId = useSession.getState().user?.id;
                if (!userId)
                    return;
                await localDb.bindUser(userId);

                const cached = await localDb.loadShell();
                if (cached) {
                    set({
                        notes: Object.fromEntries(cached.notes.map((note) => {
                            const normalized = normalizeNoteSummaryTags(note);
                            return [normalized.id, normalized];
                        })),
                        folders: cached.folders.map(normalizeFolder),
                        tags: cached.tags,
                        cursor: cached.cursor,
                        hydrated: true,
                    });
                    const initialId = pickInitialNoteId(get().notes, get().folders);
                    if (initialId)
                        await get().openNote(initialId, { revealOnMobile: false });
                }
                let pullError: unknown;
                try {
                    await get().pull({ force: !cached });
                }
                catch (err) {
                    pullError = err;
                }

                await replayOutbox(get, set);
                if (pullError)
                    throw pullError;

                const state = get();
                const notes = state.notes;
                let workspace = useUi.getState();
                for (const openId of [workspace.workspacePrimaryNoteId, workspace.workspaceSecondaryNoteId]) {
                    if (openId && !notes[openId])
                        workspace.removeWorkspaceNote(openId);
                }
                workspace = useUi.getState();
                const activePane = workspace.workspaceSecondaryNoteId
                    ? workspace.activeWorkspacePane
                    : 'primary';
                const activeId = workspace.activeNoteId;
                const latestRequestedNoteId = latestRequestedNoteIds[activePane];
                const targetId = (latestRequestedNoteId && notes[latestRequestedNoteId]
                    ? latestRequestedNoteId
                    : null) ??
                    (activeId && notes[activeId] ? activeId : pickInitialNoteId(notes, state.folders));
                if (targetId) {
                    if (activeId !== targetId || !hasOwnContent(state.contents, targetId)) {
                        await get().openNote(targetId, { pane: activePane, revealOnMobile: false });
                    }
                    else {
                        revalidateNote(targetId, notes[targetId]!.rev, set, get);
                    }
                }
                else if (activeId) {
                    useUi.getState().setActiveNote(null);
                }
                workspace = useUi.getState();
                if (workspace.workspaceSecondaryNoteId) {
                    const backgroundPane: WorkspacePane = workspace.activeWorkspacePane === 'primary'
                        ? 'secondary'
                        : 'primary';
                    const backgroundId = backgroundPane === 'primary'
                        ? workspace.workspacePrimaryNoteId
                        : workspace.workspaceSecondaryNoteId;
                    if (backgroundId && notes[backgroundId] && !hasOwnContent(get().contents, backgroundId)) {
                        await get().openNote(backgroundId, { pane: backgroundPane, activate: false });
                    }
                }
            }
            finally {
                set({ loading: false, hydrated: true });
            }
        };
        bootstrapPromise = run().catch((err) => {

            bootstrapPromise = null;
            throw err;
        });
        return bootstrapPromise;
    },
    pull(options) {
        if (options?.force)
            forcePullQueued = true;
        if (pullPromise)
            return pullPromise;
        const run = async () => {
            do {
                const force = forcePullQueued;
                forcePullQueued = false;
                const since = force ? 0 : get().cursor;
                try {
                    let payload: SyncResponse | null = await api.sync(since);
                    let fullRounds = 0;
                    while (payload?.full) {
                        if (fullRounds++ >= 2)
                            throw new Error(t("notes.data_kept_changing_during_the_full_sync_try_again_later"));
                        const snapshot = await collectFullSync(payload);


                        let catchup = snapshot.cursor > 0 ? await api.sync(snapshot.cursor) : null;
                        const increments: SyncResponse[] = [];
                        const catchupCursors = new Set<number>();
                        while (catchup && !catchup.full) {
                            increments.push(catchup);
                            if (!catchup.hasMore)
                                break;
                            if (catchupCursors.has(catchup.cursor))
                                throw new Error(t("notes.sync_pagination_data_is_incomplete"));
                            catchupCursors.add(catchup.cursor);
                            catchup = await api.sync(catchup.cursor);
                        }
                        if (catchup?.full) {
                            payload = catchup;
                            continue;
                        }
                        const consolidated = consolidateFullSync(snapshot, increments);
                        get().applySync(consolidated);
                        payload = catchup?.hasMore ? await api.sync(consolidated.cursor) : null;
                    }
                    if (!payload) {
                        set({ online: true });
                        continue;
                    }
                    get().applySync(payload);

                    const incrementalCursors = new Set<number>();
                    while (payload.hasMore) {
                        if (incrementalCursors.has(payload.cursor))
                            throw new Error(t("notes.sync_pagination_data_is_incomplete"));
                        incrementalCursors.add(payload.cursor);
                        const next = await api.sync(payload.cursor);
                        if (next.full) {
                            forcePullQueued = true;
                            break;
                        }
                        payload = next;
                        get().applySync(payload);
                    }
                    set({ online: true });
                }
                catch (err) {
                    if (err instanceof ApiError && err.isOffline)
                        set({ online: false });
                    else if (err instanceof ApiError && err.isAuth)
                        location.reload();
                    else
                        throw err;
                }
            } while (forcePullQueued);
        };
        const tracked = run().finally(() => {
            if (pullPromise === tracked)
                pullPromise = null;
        });
        pullPromise = tracked;
        return tracked;
    },
    applySync(payload) {
        if (payload.settingsChanged)
            void useSession.getState().refreshSettings().catch(() => { });
        if (payload.profileChanged || payload.siteChanged)
            void useSession.getState().refresh().catch(() => { });
        const deletionIds = payload.deletions
            .filter((item) => item.entity === 'note')
            .map((item) => item.id);
        const deletedByPayload = new Set(deletionIds);
        const incomingIds = payload.full ? new Set(payload.notes.map((note) => note.id)) : null;
        for (const [id, cursor] of purgedNoteIds) {


            if (cursor !== null && payload.cursor > cursor) {
                purgedNoteIds.delete(id);
            }
            else if (cursor === null &&
                (deletedByPayload.has(id) || (incomingIds && !incomingIds.has(id)))) {


                purgedNoteIds.set(id, payload.cursor);
            }
        }
        const previousNoteIds = payload.full ? Object.keys(get().notes) : [];
        set((state) => {
            const notes = reconcileNotes(state.notes, payload.notes, payload.deletions, payload.full);
            const replaceFacets = payload.full || payload.facetsFull;
            const remoteFolders = replaceFacets
                ? reconcileList(state.folders, payload.folders, folderEqual)
                : mergeById(state.folders, payload.folders, payload.deletions, 'folder', folderEqual);
            const folders = applyPendingFolderMutations(remoteFolders);
            const tags = replaceFacets
                ? reconcileList(state.tags, payload.tags, tagEqual)
                : mergeById(state.tags, payload.tags, payload.deletions, 'tag', tagEqual);
            if (notes === state.notes &&
                folders === state.folders &&
                tags === state.tags &&
                payload.cursor === state.cursor) {
                return state;
            }
            if (folders !== state.folders)
                folderStateGeneration++;
            if (tags !== state.tags)
                tagStateGeneration++;
            localDb.scheduleShellSave({
                notes: Object.values(notes),
                folders,
                tags,
                cursor: payload.cursor,
            });
            return { notes, folders, tags, cursor: payload.cursor };
        });
        reconcileFolderUi(get().folders);
        for (const remote of payload.notes) {
            if (hasOwnContent(get().contents, remote.id) && !dirty.has(remote.id))
                revalidateNote(remote.id, remote.rev, set, get);
        }
        const candidates = payload.full ? [...previousNoteIds, ...deletionIds] : deletionIds;
        for (const id of new Set(candidates)) {
            if (get().notes[id])
                continue;
            discardNoteRuntimeState(id);
            useUi.getState().removeWorkspaceNote(id);
            void localDb.dropContent(id);
        }
    },
    async openNote(id, options) {
        const uiAtRequest = useUi.getState();
        const targetPane = options?.pane ?? (uiAtRequest.workspaceSecondaryNoteId
            ? uiAtRequest.activeWorkspacePane
            : 'primary');
        const activate = options?.activate !== false;
        latestRequestedNoteIds[targetPane] = id;
        const requestSequence = ++openSequences[targetPane];
        const requestEpoch = noteRequestEpochs.get(id) ?? 0;
        const state = get();
        const summary = state.notes[id];
        if (!summary)
            return;
        if (hasOwnContent(state.contents, id)) {
            useUi.getState().setWorkspaceNote(targetPane, id, activate, options?.revealOnMobile);
            revalidateNote(id, summary.rev, set, get);
            return;
        }
        set((s) => {
            const noteLoadErrors = { ...s.noteLoadErrors };
            delete noteLoadErrors[id];
            return { noteLoadErrors };
        });
        // Keep the current document for fast reads; only slow reads need a loading page.
        let selected = false;
        let navigationChanged = false;
        const paneNoteId = (ui: ReturnType<typeof useUi.getState>) => targetPane === 'secondary'
            ? ui.workspaceSecondaryNoteId
            : ui.workspaceSecondaryNoteId ? ui.workspacePrimaryNoteId : ui.activeNoteId;
        const stopWatchingNavigation = useUi.subscribe((ui, previous) => {
            if (!selected && (paneNoteId(ui) !== paneNoteId(previous) ||
                ui.mobilePane !== previous.mobilePane || ui.view !== previous.view ||
                ui.folderId !== previous.folderId || ui.tag !== previous.tag ||
                (activate && ui.activeWorkspacePane !== previous.activeWorkspacePane)))
                navigationChanged = true;
        });
        const selectTarget = () => {
            if (selected || navigationChanged || requestSequence !== openSequences[targetPane] ||
                (noteRequestEpochs.get(id) ?? 0) !== requestEpoch || !get().notes[id])
                return;
            selected = true;
            useUi.getState().setWorkspaceNote(targetPane, id, activate, options?.revealOnMobile);
        };
        const feedbackTimer = window.setTimeout(selectTarget, NOTE_SWITCH_FEEDBACK_DELAY_MS);
        try {
            const cached = await localDb.getContent(id);
            let currentSummary = get().notes[id];
            if (requestSequence !== openSequences[targetPane] ||
                (noteRequestEpochs.get(id) ?? 0) !== requestEpoch ||
                !currentSummary)
                return;
            if (cached) {
                let restoredPending = false;
                let foreignPending = false;
                let visibleContent = cached.content;
                let visibleTitle: string | undefined;
                let visibleRev = cached.rev;
                if (cached.writeId) {
                    const outbox = await localDb.getOutbox();
                    currentSummary = get().notes[id];
                    if (requestSequence !== openSequences[targetPane] ||
                        (noteRequestEpochs.get(id) ?? 0) !== requestEpoch ||
                        !currentSummary)
                        return;
                    const existing = outbox.find((item) => item.writeId === cached.writeId && item.noteId === id);
                    const currentId = outboxId(id);
                    const existingContent = existing?.payload.content;
                    const existingTitle = existing?.payload.title;
                    const existingRev = existing?.payload.rev;
                    const validExisting = existing &&
                        typeof existingContent === 'string' &&
                        Number.isInteger(existingRev) &&
                        (existingRev as number) >= 1;
                    if (validExisting) {


                        visibleContent = existingContent as string;
                        visibleRev = existingRev as number;
                        visibleTitle = typeof existingTitle === 'string' ? existingTitle : undefined;
                        if (existing.clientId === CLIENT_ID) {
                            inheritedOutboxWrites.delete(id);
                            dirty.set(id, {
                                ...(typeof existingTitle === 'string' ? { title: existingTitle } : {}),
                                content: visibleContent,
                                contentDirty: existing.payload.contentDirty !== false,
                                rev: existingRev as number,
                                writeId: existing.writeId,
                                queueId: existing.id,
                                dependsOnWriteId: existing.dependsOnWriteId,
                                updatedAt: cached.updatedAt,
                                persisted: Promise.resolve(true),
                            });
                        }
                        else {
                            inheritedOutboxWrites.set(id, existing.writeId);
                            foreignPending = true;
                        }
                        restoredPending = true;
                    }
                    else {
                        inheritedOutboxWrites.delete(id);
                        const recoveredTitle = cached.pendingTitle;
                        const recoveredContentDirty = cached.contentDirty !== false;
                        visibleTitle = recoveredTitle;
                        const queueId = outbox.some((item) => item.id === currentId)
                            ? `patch-recovery:${CLIENT_ID}:${id}:${cached.writeId}`
                            : currentId;
                        const persisted = localDb.enqueueOutbox({
                            id: queueId,
                            clientId: CLIENT_ID,
                            writeId: cached.writeId,
                            noteId: id,
                            payload: {
                                content: cached.content,
                                contentDirty: recoveredContentDirty,
                                rev: cached.rev,
                                ...(recoveredTitle !== undefined ? { title: recoveredTitle } : {}),
                            },
                            attempts: 0,
                            createdAt: cached.updatedAt,
                        }).then(async () => {
                            if (existing)
                                await localDb.completeOutboxItem(existing.id, existing.writeId).catch(() => { });
                            return true;
                        }, () => false);
                        dirty.set(id, {
                            ...(recoveredTitle !== undefined ? { title: recoveredTitle } : {}),
                            content: cached.content,
                            contentDirty: recoveredContentDirty,
                            rev: cached.rev,
                            writeId: cached.writeId,
                            queueId,
                            updatedAt: cached.updatedAt,
                            persisted,
                        });
                        restoredPending = true;
                        void persisted.then((durable) => {
                            if (!durable) {
                                useUi.getState().toast({
                                    title: t("notes.the_browser_could_not_save_your_offline_changes"),
                                    description: t("notes.keep_this_page_open_and_reconnect_as_soon_as_possible_closing_it_may_mak"),
                                    tone: 'danger',
                                    duration: 12_000,
                                });
                            }
                        });
                    }
                    if (restoredPending) {
                        const pendingIds = new Set(outbox.map((item) => item.noteId));
                        for (const noteId of dirty.keys())
                            pendingIds.add(noteId);
                        set({ pendingCount: pendingIds.size });
                    }
                }
                set((s) => ({
                    notes: s.notes[id] && (s.notes[id]!.rev !== visibleRev ||
                        (visibleTitle !== undefined && s.notes[id]!.title !== visibleTitle))
                        ? { ...s.notes, [id]: { ...s.notes[id]!, rev: visibleRev,
                            ...(visibleTitle !== undefined ? { title: visibleTitle } : {}) } }
                        : s.notes,
                    contents: { ...s.contents, [id]: visibleContent },
                    ...(restoredPending
                        ? { saveStatus: s.online ? 'dirty' as const : 'offline' as const }
                        : {}),
                }));
                if (visibleTitle !== undefined)
                    scheduleShellSave(get);
                if (restoredPending) {
                    if (foreignPending && get().online)
                        void replayOutbox(get, set);
                    return;
                }
                if (cached.rev === currentSummary.rev)
                    validatedRevisions.set(id, currentSummary.rev);
                else
                    revalidateNote(id, currentSummary.rev, set, get);
                return;
            }
            const note = await requestNote(id);
            adoptNote(note, set, get);
            validatedRevisions.set(id, note.rev);
        }
        catch (err) {
            if (err === STALE_NOTE_REQUEST || requestSequence !== openSequences[targetPane] ||
                (noteRequestEpochs.get(id) ?? 0) !== requestEpoch || !get().notes[id])
                return;
            const message = err instanceof ApiError && err.isOffline
                ? t("notes.this_note_cannot_be_opened_offline")
                : t("notes.failed_to_open_note");
            set((s) => ({ noteLoadErrors: { ...s.noteLoadErrors, [id]: message } }));
            if (err instanceof ApiError && err.isOffline) {
                useUi.getState().toast({ title: t("notes.this_note_cannot_be_opened_offline"), tone: 'warning' });
                return;
            }
            if (err instanceof ApiError && err.status === 404) {
                useUi.getState().toast({ title: t("notes.this_note_no_longer_exists"), tone: 'danger' });
                if (latestRequestedNoteIds[targetPane] === id)
                    latestRequestedNoteIds[targetPane] = null;
                useUi.getState().removeWorkspaceNote(id);
                set((s) => {
                    const notes = { ...s.notes };
                    delete notes[id];
                    return { notes };
                });
                return;
            }
            toastError(err, t("notes.failed_to_open_note"));
        }
        finally {
            window.clearTimeout(feedbackTimer);
            stopWatchingNavigation();
            selectTarget();
        }
    },
    editTitle(id, title) {
        const state = get();
        const summary = state.notes[id];
        const content = state.contents[id];
        if (!summary || content === undefined)
            return;
        const nextTitle = title.slice(0, LIMITS.titleMaxLength);
        if (summary.title === nextTitle)
            return;
        stageNoteTextWrite(id, content, nextTitle, set, get);
    },
    editContent(id, content) {
        const state = get();
        const summary = state.notes[id];
        if (!summary || !hasOwnContent(state.contents, id) || state.contents[id] === content)
            return;
        stageNoteTextWrite(id, content, dirty.get(id)?.title, set, get);
    },
    async flush(options) {
        commitAllPendingSummaryDerivations();
        if (options?.immediate)
            window.clearTimeout(saveTimer);
        if (dirty.size)
            set((state) => ({ saveStatus: state.online ? 'saving' : 'offline' }));
        await replayOutbox(get, set);
        commitAllPendingSummaryDerivations();
        const remaining = await localDb.getOutbox();
        const pendingCount = pendingNoteCount(remaining);
        set((state) => ({
            saveStatus: pendingCount ? (state.online ? 'dirty' : 'offline') : 'synced',
            pendingCount,
        }));
    },
    async createNote(input) {
        const id = input?.id ?? newLocalEntityId();
        const existing = get().notes[id];
        const content = input?.content ?? '';
        const title = (input?.title ?? '').trim().slice(0, LIMITS.titleMaxLength);
        const folderId = input?.folderId ?? currentFolderId();
        const isStarred = input?.isStarred ?? false;
        if (existing) {
            const request = api.notes.create({ id, title, content, folderId, ...(isStarred ? { isStarred: true } : {}) });
            pendingNoteCreates.set(id, request);
            try {
                const note = await request;
                adoptNote(note, set, get);
                if (isStarred && !note.isStarred)
                    await get().patchNote(note.id, { isStarred: true });
                return note.id;
            }
            catch (err) {
                toastError(err, t("notes.could_not_create_note"));
                return null;
            }
            finally {
                if (pendingNoteCreates.get(id) === request)
                    pendingNoteCreates.delete(id);
            }
        }
        const now = Date.now();
        const { words, chars } = countText(content);
        const optimistic: Note = {
            id,
            title,
            excerpt: deriveExcerpt(content),
            content,
            folderId,
            tags: extractTags(content),
            isPinned: false,
            isStarred,
            isArchived: false,
            wordCount: words,
            charCount: chars,
            rev: 1,
            position: now,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        };
        const previousWorkspace = captureWorkspaceState();
        adoptNote(optimistic, set, get);
        if (input?.open !== false) {
            useUi.getState().setActiveNote(id);
            useUi.getState().setMobilePane('editor');
        }
        const request = api.notes.create({ id, title, content, folderId, ...(isStarred ? { isStarred: true } : {}) });
        pendingNoteCreates.set(id, request);
        try {
            const note = await request;
            adoptNote(note, set, get);
            if (isStarred && !note.isStarred)
                await get().patchNote(note.id, { isStarred: true });
            return note.id;
        }
        catch (err) {
            if (!dirty.has(id)) {
                set((state) => {
                    const notes = { ...state.notes };
                    const contents = { ...state.contents };
                    delete notes[id];
                    delete contents[id];
                    return { notes, contents };
                });
                void localDb.dropContent(id);
                if (workspaceContainsNote(id))
                    restoreWorkspaceState(previousWorkspace);
                scheduleShellSave(get);
            }
            toastError(err, t("notes.could_not_create_note"));
            return null;
        }
        finally {
            if (pendingNoteCreates.get(id) === request)
                pendingNoteCreates.delete(id);
        }
    },
    async patchNote(id, patch) {
        commitPendingSummaryDerivation(id);
        const mutation = beginNoteMutation(id, compactOptimisticPatch(patch), set, get);
        if (!mutation)
            return;
        await enqueueNoteWrite(id, async () => {
            const summary = get().notes[id];
            if (!summary) {
                finishNoteMutation(id, mutation);
                return;
            }
            let rev = dirty.get(id)?.rev ?? summary.rev;
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    const saved = await api.notes.patch(id, { rev, ...patch });
                    finishNoteMutation(id, mutation);
                    advanceDirtyRevision(id, rev, saved.rev, get);
                    adoptNote(saved, set, get);
                    return;
                }
                catch (err) {
                    const server = err instanceof ApiError && err.isConflict
                        ? (err.details as { server?: Note } | undefined)?.server
                        : undefined;
                    if (server?.id === id && server.rev > rev && attempt < 3) {
                        adoptNote(server, set, get);
                        rev = server.rev;
                        continue;
                    }
                    await recoverNoteMutation(id, mutation, err, set, get);
                    toastError(err, t("common.action_failed"));
                    return;
                }
            }
        });
    },
    async deleteNote(id) {
        commitPendingSummaryDerivation(id);
        const before = get().notes[id];
        if (!before)
            return;
        const workspaceBefore = captureWorkspaceState();
        const wasOpen = workspaceContainsNote(id);
        const deletedAt = Date.now();
        const mutation = beginNoteMutation(id, { deletedAt, updatedAt: deletedAt }, set, get);
        if (!mutation)
            return;
        if (wasOpen)
            useUi.getState().removeWorkspaceNote(id);
        await enqueueNoteWrite(id, async () => {
            if (!(await saveDirtyBeforeDestructiveMutation(id, set, get))) {
                finishNoteMutation(id, mutation);
                rollbackNoteMutation(id, mutation, set, get);
                if (wasOpen && get().notes[id])
                    restoreWorkspaceState(workspaceBefore);
                useUi.getState().toast({
                    title: t("notes.deletion_was_canceled_because_the_note_body_is_not_safely_synced"),
                    tone: 'warning',
                });
                return;
            }
            try {
                const removed = await api.notes.remove(id);
                finishNoteMutation(id, mutation);
                adoptNote(removed, set, get);
                useUi.getState().toast({
                    title: t("notes.moved_to_trash"),
                    action: {
                        label: t("common.undo"),
                        run: () => void get().restoreNote(id),
                    },
                });
            }
            catch (err) {
                await recoverNoteMutation(id, mutation, err, set, get);
                if (wasOpen && get().notes[id]?.deletedAt === null)
                    restoreWorkspaceState(workspaceBefore);
                toastError(err, t("common.delete_failed"));
            }
        });
    },
    async restoreNote(id) {
        const mutation = beginNoteMutation(id, { deletedAt: null }, set, get);
        if (!mutation)
            return;
        await enqueueNoteWrite(id, async () => {
            try {
                const note = await api.notes.restore(id);
                finishNoteMutation(id, mutation);
                adoptNote(note, set, get);
                useUi.getState().toast({ title: t("notes.restored"), tone: 'success' });
            }
            catch (err) {
                await recoverNoteMutation(id, mutation, err, set, get);
                toastError(err, t("common.restore_failed"));
            }
        });
    },
    async restoreVersion(id, versionId, content, title) {
        commitPendingSummaryDerivation(id);
        const before = get().notes[id];
        if (!before || !hasOwnContent(get().contents, id))
            return false;
        const beforeContent = get().contents[id]!;
        const updatedAt = Math.max(Date.now(), before.updatedAt + 1);
        const { words, chars } = countText(content);
        const optimistic: NoteSummary = {
            ...before,
            ...(title !== undefined ? { title: title.slice(0, LIMITS.titleMaxLength) } : {}),
            excerpt: deriveExcerpt(content),
            tags: extractTags(content),
            wordCount: words,
            charCount: chars,
            updatedAt,
        };
        set((state) => ({
            notes: { ...state.notes, [id]: optimistic },
            contents: { ...state.contents, [id]: content },
        }));
        scheduleShellSave(get);
        void localDb.setContent(id, { content, rev: before.rev, updatedAt });
        return enqueueNoteWrite(id, async () => {
            if (!(await saveDirtyBeforeDestructiveMutation(id, set, get))) {
                restoreVersionSnapshot(id, optimistic, before, content, beforeContent, set, get);
                return false;
            }
            try {
                const saved = await api.notes.restoreVersion(id, versionId);
                adoptNote(saved, set, get);
                useUi.getState().toast({ title: t("workspace.restored_to_selected_version"), tone: 'success' });
                return true;
            }
            catch (err) {
                restoreVersionSnapshot(id, optimistic, before, content, beforeContent, set, get);
                toastError(err, t("common.restore_failed"));
                return false;
            }
        });
    },
    async purgeNote(id) {
        const before = get().notes[id];
        if (!before)
            return;
        const hadContent = hasOwnContent(get().contents, id);
        const beforeContent = get().contents[id];
        const workspaceBefore = captureWorkspaceState();
        const wasOpen = workspaceContainsNote(id);
        markNotesOptimisticallyPurged([id], set, get);
        await enqueueNoteWrite(id, async () => {
            if (!(await saveDirtyBeforeDestructiveMutation(id, set, get))) {
                restoreOptimisticallyPurgedNotes([{ note: before, content: beforeContent, hadContent }], set, get);
                if (wasOpen)
                    restoreWorkspaceState(workspaceBefore);
                useUi.getState().toast({
                    title: t("notes.permanent_deletion_was_canceled_because_the_note_body_is_not_safely_sync"),
                    tone: 'warning',
                });
                return;
            }
            try {
                const result = await api.notes.purge(id);
                discardNoteRuntimeState(id, result.cursor);
                set((s) => {
                    const notes = { ...s.notes };
                    const contents = { ...s.contents };
                    delete notes[id];
                    delete contents[id];
                    return { notes, contents };
                });
                scheduleShellSave(get);
                void localDb.dropContent(id);
            }
            catch (err) {
                restoreOptimisticallyPurgedNotes([{ note: before, content: beforeContent, hadContent }], set, get);
                if (wasOpen)
                    restoreWorkspaceState(workspaceBefore);
                toastError(err, t("notes.permanent_deletion_failed"));
            }
        });
    },
    async emptyTrash() {
        const snapshots = Object.values(get().notes)
            .filter((note) => note.deletedAt !== null)
            .map((note) => ({
            note,
            content: get().contents[note.id],
            hadContent: hasOwnContent(get().contents, note.id),
        }));
        if (!snapshots.length)
            return 0;
        const workspaceBefore = captureWorkspaceState();
        const ids = snapshots.map((snapshot) => snapshot.note.id);
        markNotesOptimisticallyPurged(ids, set, get);
        for (const id of ids) {
            if (!(await saveDirtyBeforeDestructiveMutation(id, set, get))) {
                restoreOptimisticallyPurgedNotes(snapshots, set, get);
                restoreWorkspaceState(workspaceBefore);
                useUi.getState().toast({
                    title: t("notes.permanent_deletion_was_canceled_because_the_note_body_is_not_safely_sync"),
                    tone: 'warning',
                });
                return null;
            }
        }
        try {
            const result = await api.notes.emptyTrash();
            for (const id of ids) {
                discardNoteRuntimeState(id);
                void localDb.dropContent(id);
            }
            void get().pull().catch(() => { });
            return result.purged;
        }
        catch (err) {
            restoreOptimisticallyPurgedNotes(snapshots, set, get);
            restoreWorkspaceState(workspaceBefore);
            toastError(err, t("notes.clearing_failed"));
            return null;
        }
    },
    async duplicateNote(id) {
        const source = get().notes[id];
        if (!source)
            return;
        const copyId = newLocalEntityId();
        const now = Date.now();
        const hasContent = hasOwnContent(get().contents, id);
        const optimistic: NoteSummary = {
            ...source,
            id: copyId,
            title: duplicateNoteTitle(source.title, LIMITS.titleMaxLength),
            isPinned: false,
            isStarred: false,
            rev: 1,
            position: now,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        };
        set((state) => ({
            notes: { ...state.notes, [copyId]: optimistic },
            contents: hasContent ? { ...state.contents, [copyId]: state.contents[id]! } : state.contents,
        }));
        scheduleShellSave(get);
        if (hasContent) {
            void localDb.setContent(copyId, {
                content: get().contents[id]!,
                rev: 1,
                updatedAt: now,
            });
            useUi.getState().setActiveNote(copyId);
        }
        const request = enqueueNoteWrite(id, async () => {
            if (!(await saveDirtyBeforeDestructiveMutation(id, set, get))) {
                throw new Error(t("notes.the_note_body_is_not_safely_synced_so_a_complete_copy_cannot_be_created"));
            }
            return api.notes.duplicate(id, { id: copyId });
        });
        pendingNoteCreates.set(copyId, request);
        try {
            const note = await request;
            adoptNote(note, set, get);
            useUi.getState().setActiveNote(note.id);
        }
        catch (err) {
            if (!dirty.has(copyId)) {
                set((state) => {
                    const notes = { ...state.notes };
                    const contents = { ...state.contents };
                    delete notes[copyId];
                    delete contents[copyId];
                    return { notes, contents };
                });
                void localDb.dropContent(copyId);
                if (useUi.getState().activeNoteId === copyId)
                    useUi.getState().setActiveNote(id);
                scheduleShellSave(get);
            }
            toastError(err, t("notes.failed_to_create_copy"));
        }
        finally {
            if (pendingNoteCreates.get(copyId) === request)
                pendingNoteCreates.delete(copyId);
        }
    },
    createFolder(input) {
        const parentId = input?.parentId ?? null;
        const current = get().folders;
        if (parentId && !current.some((folder) => folder.id === parentId))
            return null;
        const id = newLocalEntityId();
        const now = Date.now();
        const name = availableLocalFolderName(current, parentId, input?.name?.trim() || t("common.new_folder"));
        const folder: Folder = {
            id,
            parentId,
            name,
            icon: input?.icon ?? null,
            color: input?.color ?? null,
            position: insertionPositionForFolders(current, id, parentId, null),
            createdAt: now,
            updatedAt: now,
            noteCount: 0,
        };
        const mutation = beginFolderMutation(id, false, (folders) => folders.some((item) => item.id === id) ? folders : [...folders, folder], set, get);
        void enqueueFolderWrite(id, () => api.folders.create({
            id,
            name,
            parentId,
            icon: folder.icon,
            ...(folder.color ? { color: folder.color } : {}),
        })).then((saved) => {
            commitFolderMutation(mutation, saved, set, get);
        }).catch((err) => {
            rollbackFolderMutation(mutation, set, get);
            toastError(err, t("sidebar.failed_to_create_folder"));
        });
        return id;
    },
    patchFolder(id, patch) {
        const current = get().folders.find((folder) => folder.id === id);
        if (!current)
            return false;
        const normalized = {
            ...patch,
            ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        };
        if (normalized.name === '' || normalized.parentId === id)
            return false;
        const mutation = beginFolderMutation(id, false, (folders) => applyOptimisticFolderPatch(folders, id, normalized), set, get);
        void enqueueFolderWrite(id, () => api.folders.patch(id, normalized)).then((saved) => {
            commitFolderMutation(mutation, saved, set, get);
        }).catch((err) => {
            rollbackFolderMutation(mutation, set, get);
            toastError(err, normalized.name !== undefined ? t("sidebar.rename_failed") : t("sidebar.move_failed"));
        });
        return true;
    },
    deleteFolder(id) {
        const folder = get().folders.find((item) => item.id === id);
        if (!folder)
            return false;
        const noteMutations: Array<[string, PendingNoteMutation]> = [];
        const movedAt = Date.now();
        for (const note of Object.values(get().notes)) {
            if (note.folderId !== id)
                continue;
            const mutation = beginNoteMutation(note.id, { folderId: folder.parentId, updatedAt: movedAt }, set, get);
            if (mutation)
                noteMutations.push([note.id, mutation]);
        }
        const mutation = beginFolderMutation(id, true, (folders) => removeFolderAndPromoteChildren(folders, id), set, get);
        reconcileFolderUi(get().folders);
        void enqueueFolderWrite(id, () => api.folders.remove(id, 'move-up')).then(() => {
            finishFolderMutation(mutation);
            for (const [noteId, noteMutation] of noteMutations)
                finishNoteMutation(noteId, noteMutation);
            scheduleShellSave(get);
            void get().pull().catch(() => { });
        }).catch((err) => {
            rollbackFolderMutation(mutation, set, get);
            for (const [noteId, noteMutation] of noteMutations) {
                finishNoteMutation(noteId, noteMutation);
                rollbackNoteMutation(noteId, noteMutation, set, get);
            }
            toastError(err, t("common.delete_failed"));
        });
        return true;
    },
    async refreshFolders() {
        const sequence = ++folderRefreshSequence;
        const generation = folderStateGeneration;
        try {
            const { folders } = await api.folders.list();
            let changed = false;
            set((state) => {
                if (sequence !== folderRefreshSequence || generation !== folderStateGeneration)
                    return state;
                const next = applyPendingFolderMutations(reconcileList(state.folders, folders, folderEqual));
                if (next === state.folders)
                    return state;
                folderStateGeneration++;
                changed = true;
                return { folders: next };
            });
            if (changed)
                scheduleShellSave(get);
            reconcileFolderUi(get().folders);
        }
        catch {
        }
    },
    async refreshTags() {
        const sequence = ++tagRefreshSequence;
        const generation = tagStateGeneration;
        try {
            const { tags } = await api.tags.list();
            let changed = false;
            set((state) => {
                if (sequence !== tagRefreshSequence || generation !== tagStateGeneration)
                    return state;
                const next = reconcileList(state.tags, tags, tagEqual);
                if (next === state.tags)
                    return state;
                tagStateGeneration++;
                changed = true;
                return { tags: next };
            });
            if (changed)
                scheduleShellSave(get);
        }
        catch (error) {
            throw error;
        }
    },
    replayPending() {
        return replayOutbox(get, set);
    },
    setOnline(online) {
        set({ online });
        if (online) {
            void get()
                .pull()
                .catch(() => { })
                .then(() => replayOutbox(get, set))
                .catch(() => { });
        }
    },
}));

type TagCacheState = Pick<NotesState, 'notes' | 'tags'>;

export function setOptimisticTagCache(update: (state: NotesState) => Partial<TagCacheState>) {
    tagStateGeneration++;
    useNotes.setState((state) => update(state));
}

async function collectFullSync(first: SyncResponse): Promise<SyncResponse> {
    const notes = new Map(first.notes.map((note) => [note.id, note]));
    let page = first;
    const requestedKeys = new Set<string>();
    while (page.hasMore) {
        if (page.nextKey === null)
            throw new Error(t("notes.full_sync_pagination_data_is_incomplete"));
        if (requestedKeys.has(page.nextKey))
            throw new Error(t("notes.full_sync_pagination_data_is_incomplete"));
        requestedKeys.add(page.nextKey);
        page = await api.sync(0, {
            after: page.nextKey,
            snapshot: first.cursor,
        });
        if (!page.full || page.cursor !== first.cursor) {
            throw new Error(t("notes.the_full_sync_snapshot_expired_try_again"));
        }
        for (const note of page.notes)
            notes.set(note.id, note);
    }
    return {
        ...first,
        notes: [...notes.values()],
        hasMore: false,
        nextKey: null,
        serverTime: page.serverTime,
    };
}
function consolidateFullSync(snapshot: SyncResponse, increments: SyncResponse[]): SyncResponse {
    const notes = new Map(snapshot.notes.map((note) => [note.id, note]));
    let folders = new Map(snapshot.folders.map((folder) => [folder.id, folder]));
    let tags = new Map(snapshot.tags.map((tag) => [tag.id, tag]));
    let cursor = snapshot.cursor;
    let serverTime = snapshot.serverTime;
    let settingsChanged = snapshot.settingsChanged;
    let profileChanged = snapshot.profileChanged;
    let siteChanged = snapshot.siteChanged;
    for (const update of increments) {
        settingsChanged ||= update.settingsChanged;
        profileChanged ||= update.profileChanged;
        siteChanged ||= update.siteChanged;
        for (const note of update.notes)
            notes.set(note.id, note);
        if (update.facetsFull) {
            folders = new Map(update.folders.map((folder) => [folder.id, folder]));
            tags = new Map(update.tags.map((tag) => [tag.id, tag]));
        }
        else {
            for (const folder of update.folders)
                folders.set(folder.id, folder);
            for (const tag of update.tags)
                tags.set(tag.id, tag);
        }
        for (const deletion of update.deletions) {
            if (deletion.entity === 'note')
                notes.delete(deletion.id);
            else if (deletion.entity === 'folder')
                folders.delete(deletion.id);
            else if (deletion.entity === 'tag')
                tags.delete(deletion.id);
        }
        cursor = update.cursor;
        serverTime = update.serverTime;
    }
    return {
        ...snapshot,
        cursor,
        hasMore: false,
        nextKey: null,
        facetsFull: true,
        settingsChanged,
        profileChanged,
        siteChanged,
        notes: [...notes.values()],
        folders: [...folders.values()],
        tags: [...tags.values()],
        deletions: [],
        serverTime,
    };
}
function scheduleSummaryDerivation(id: string, content: string, updatedAt: number, set: SetNotesState, get: () => NotesState): void {
    const existing = pendingSummaryDerivations.get(id);
    if (existing)
        window.clearTimeout(existing.timer);
    const pending: PendingSummaryDerivation = {
        content,
        updatedAt,
        set,
        get,
        timer: 0,
    };
    pending.timer = window.setTimeout(() => commitPendingSummaryDerivation(id), SUMMARY_DERIVE_DELAY_MS);
    pendingSummaryDerivations.set(id, pending);
}
function commitAllPendingSummaryDerivations(): void {
    for (const id of [...pendingSummaryDerivations.keys()])
        commitPendingSummaryDerivation(id);
}
function commitPendingSummaryDerivation(id: string): void {
    const pending = pendingSummaryDerivations.get(id);
    if (!pending)
        return;
    window.clearTimeout(pending.timer);
    pendingSummaryDerivations.delete(id);
    let shellChanged = false;
    pending.set((state) => {
        const summary = state.notes[id];
        if (!summary || state.contents[id] !== pending.content)
            return state;
        const excerpt = deriveExcerpt(pending.content);
        const { words, chars } = countText(pending.content);
        const extractedTags = extractTags(pending.content);
        const tags = equalStringArrays(summary.tags, extractedTags) ? summary.tags : extractedTags;
        if (summary.excerpt === excerpt &&
            summary.wordCount === words &&
            summary.charCount === chars &&
            summary.tags === tags &&
            summary.updatedAt === pending.updatedAt) {
            return state;
        }
        shellChanged = true;
        return {
            notes: {
                ...state.notes,
                [id]: {
                    ...summary,
                    excerpt,
                    wordCount: words,
                    charCount: chars,
                    tags,
                    updatedAt: pending.updatedAt,
                },
            },
        };
    });
    if (shellChanged)
        scheduleShellSave(pending.get);
}
function equalStringArrays(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}
function stageNoteTextWrite(id: string, content: string, title: string | undefined, set: SetNotesState, get: () => NotesState): void {
    const state = get();
    const summary = state.notes[id];
    if (!summary || !hasOwnContent(state.contents, id))
        return;
    const previousDirty = dirty.get(id);
    const writeId = newLocalWriteId();
    const queueId = previousDirty?.queueId ?? outboxId(id);
    const dependsOnWriteId = previousDirty?.dependsOnWriteId ?? inheritedOutboxWrites.get(id);
    const updatedAt = previousDirty?.updatedAt ?? Math.max(Date.now(), summary.updatedAt + 1);
    const contentChanged = state.contents[id] !== content;
    const contentDirty = previousDirty?.contentDirty === true || contentChanged;
    const payload = {
        content,
        contentDirty,
        rev: previousDirty?.rev ?? summary.rev,
        ...(title !== undefined ? { title } : {}),
    };
    const persisted = localDb.enqueueOutbox({
        id: queueId,
        clientId: CLIENT_ID,
        writeId,
        dependsOnWriteId,
        noteId: id,
        payload,
        attempts: 0,
        createdAt: Date.now(),
    }).then(() => true, () => false);
    dirty.set(id, { content, contentDirty, ...(title !== undefined ? { title } : {}), rev: payload.rev, writeId, queueId, dependsOnWriteId, updatedAt, persisted });
    const titleChanged = title !== undefined && summary.title !== title;
    set((current) => ({
        notes: titleChanged
            ? { ...current.notes, [id]: { ...current.notes[id]!, title, updatedAt } }
            : current.notes,
        contents: contentChanged ? { ...current.contents, [id]: content } : current.contents,
        saveStatus: 'dirty',
        pendingCount: Math.max(current.pendingCount, dirty.size),
    }));
    if (contentChanged)
        scheduleSummaryDerivation(id, content, updatedAt, set, get);
    if (titleChanged)
        scheduleShellSave(get);
    void localDb.setContent(id, {
        content,
        contentDirty,
        ...(title !== undefined ? { pendingTitle: title } : {}),
        rev: payload.rev,
        updatedAt,
        writeId,
    });
    const delay = Math.max(100, useSession.getState().settings.editor.autoSaveDelay);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().flush(), delay);
}
function normalizeNoteSummaryTags(note: NoteSummary): NoteSummary {
    const tags = sortTagNames(note.tags);
    return equalStringArrays(note.tags, tags) ? note : { ...note, tags };
}
function enqueueNoteWrite<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = noteWriteTails.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    noteWriteTails.set(id, tail);
    void tail.then(() => {
        if (noteWriteTails.get(id) === tail)
            noteWriteTails.delete(id);
    });
    return result;
}
function beginFolderMutation(entityId: string, restoreMissingEntity: boolean, apply: (folders: Folder[]) => Folder[], set: SetNotesState, get: () => NotesState): PendingFolderMutation {
    const mutation: PendingFolderMutation = { entityId, restoreMissingEntity, before: get().folders, apply };
    pendingFolderMutations.push(mutation);
    folderStateGeneration++;
    set((state) => ({ folders: apply(state.folders) }));
    scheduleShellSave(get);
    return mutation;
}
function enqueueFolderWrite<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = folderWriteTails.get(id);
    const result = previous ? previous.then(operation) : operation();
    const tail = result.then(() => undefined, () => undefined);
    folderWriteTails.set(id, tail);
    void tail.then(() => {
        if (folderWriteTails.get(id) === tail)
            folderWriteTails.delete(id);
    });
    return result;
}
function finishFolderMutation(mutation: PendingFolderMutation): PendingFolderMutation[] {
    const index = pendingFolderMutations.indexOf(mutation);
    if (index < 0)
        return [];
    const later = pendingFolderMutations.slice(index + 1);
    pendingFolderMutations.splice(index, 1);
    return later;
}
function commitFolderMutation(mutation: PendingFolderMutation, saved: Folder, set: SetNotesState, get: () => NotesState): void {
    const later = finishFolderMutation(mutation);
    for (const pending of later)
        pending.before = replaceFolder(pending.before, saved);
    folderStateGeneration++;
    set((state) => {
        const base = replaceFolder(state.folders, saved);
        return { folders: later.reduce((folders, pending) => pending.apply(folders), base) };
    });
    scheduleShellSave(get);
}
function rollbackFolderMutation(mutation: PendingFolderMutation, set: SetNotesState, get: () => NotesState): void {
    const index = pendingFolderMutations.indexOf(mutation);
    if (index < 0)
        return;
    const later = pendingFolderMutations.slice(index + 1);
    pendingFolderMutations.splice(index, 1);
    folderStateGeneration++;
    const currentHasEntity = get().folders.some((folder) => folder.id === mutation.entityId);
    const before = !mutation.restoreMissingEntity && !currentHasEntity
        ? mutation.before.filter((folder) => folder.id !== mutation.entityId)
        : mutation.before;
    let next = before;
    for (const pending of later) {
        pending.before = next;
        next = pending.apply(next);
    }
    set({ folders: next });
    scheduleShellSave(get);
    reconcileFolderUi(get().folders);
}
function replaceFolder(folders: Folder[], saved: Folder): Folder[] {
    const index = folders.findIndex((folder) => folder.id === saved.id);
    if (index < 0)
        return [...folders, saved];
    const next = [...folders];
    next[index] = saved;
    return next;
}
function applyPendingFolderMutations(folders: Folder[]): Folder[] {
    return pendingFolderMutations.reduce((current, mutation) => mutation.apply(current), folders);
}
type FolderMutationPatch = {
    name?: string;
    parentId?: string | null;
    beforeId?: string | null;
    icon?: string | null;
    color?: string | null;
};
function applyOptimisticFolderPatch(folders: Folder[], id: string, patch: FolderMutationPatch): Folder[] {
    const current = folders.find((folder) => folder.id === id);
    if (!current)
        return folders;
    const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
    const shouldPlace = patch.beforeId !== undefined || parentId !== current.parentId;
    const updated: Folder = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.parentId !== undefined ? { parentId } : {}),
        ...(shouldPlace ? { position: insertionPositionForFolders(folders, id, parentId, patch.beforeId ?? null) } : {}),
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    return folders.map((folder) => folder.id === id ? updated : folder);
}
function insertionPositionForFolders(folders: Folder[], id: string, parentId: string | null, beforeId: string | null): number {
    const siblings = folders
        .filter((folder) => folder.id !== id && folder.parentId === parentId)
        .sort(compareFolders);
    const index = beforeId === null ? siblings.length : siblings.findIndex((folder) => folder.id === beforeId);
    const target = index < 0 ? siblings.length : index;
    const previous = siblings[target - 1]?.position;
    const next = siblings[target]?.position;
    if (previous === undefined && next === undefined)
        return 1000;
    if (previous === undefined)
        return next! - 1000;
    if (next === undefined)
        return previous + 1000;
    return previous + (next - previous) / 2;
}
function removeFolderAndPromoteChildren(folders: Folder[], id: string): Folder[] {
    const removed = folders.find((folder) => folder.id === id);
    if (!removed)
        return folders;
    const siblings = folders.filter((folder) => folder.parentId === removed.parentId).sort(compareFolders);
    const children = folders.filter((folder) => folder.parentId === id).sort(compareFolders);
    const removedIndex = siblings.findIndex((folder) => folder.id === id);
    const previous = siblings[removedIndex - 1]?.position;
    const next = siblings[removedIndex + 1]?.position;
    const positions = positionsForPromotedFolders(previous, next, children.length);
    if (positions) {
        const promoted = new Map(children.map((child, index) => [child.id, positions[index]!]));
        return folders.flatMap((folder) => {
            if (folder.id === id)
                return [];
            const position = promoted.get(folder.id);
            return position === undefined ? [folder] : [{ ...folder, parentId: removed.parentId, position, updatedAt: Date.now() }];
        });
    }
    const desired = [...siblings];
    desired.splice(removedIndex, 1, ...children);
    const normalized = new Map(desired.map((folder, index) => [folder.id, (index + 1) * 1000]));
    return folders.flatMap((folder) => {
        if (folder.id === id)
            return [];
        const position = normalized.get(folder.id);
        if (position === undefined)
            return [folder];
        return [{
                ...folder,
                ...(folder.parentId === id ? { parentId: removed.parentId, updatedAt: Date.now() } : {}),
                position,
            }];
    });
}
function positionsForPromotedFolders(previous: number | undefined, next: number | undefined, count: number): number[] | null {
    if (!count)
        return [];
    if (previous === undefined && next === undefined)
        return Array.from({ length: count }, (_, index) => (index + 1) * 1000);
    if (previous === undefined)
        return Array.from({ length: count }, (_, index) => next! - (count - index) * 1000);
    if (next === undefined)
        return Array.from({ length: count }, (_, index) => previous + (index + 1) * 1000);
    const step = (next - previous) / (count + 1);
    return Number.isFinite(step) && step > 0
        ? Array.from({ length: count }, (_, index) => previous + step * (index + 1))
        : null;
}
function compareFolders(left: Folder, right: Folder): number {
    return left.position - right.position || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}
function availableLocalFolderName(folders: Folder[], parentId: string | null, base: string): string {
    const names = new Set(folders
        .filter((folder) => folder.parentId === parentId)
        .map((folder) => folder.name.toLocaleLowerCase()));
    if (!names.has(base.toLocaleLowerCase()))
        return base;
    let suffix = 2;
    while (names.has(`${base} ${suffix}`.toLocaleLowerCase()))
        suffix++;
    return `${base} ${suffix}`;
}
function compactOptimisticPatch(patch: OptimisticNotePatch): OptimisticNotePatch {
    const compact: OptimisticNotePatch = {};
    for (const key of ['folderId', 'isPinned', 'isStarred', 'isArchived', 'deletedAt', 'updatedAt'] as const) {
        if (patch[key] !== undefined)
            Object.assign(compact, { [key]: patch[key] });
    }
    return compact;
}
function beginNoteMutation(id: string, patch: OptimisticNotePatch, set: SetNotesState, get: () => NotesState): PendingNoteMutation | null {
    const before = get().notes[id];
    if (!before || !Object.keys(patch).length)
        return null;
    const mutation: PendingNoteMutation = { patch, before };
    const pending = pendingNoteMutations.get(id);
    if (pending)
        pending.push(mutation);
    else
        pendingNoteMutations.set(id, [mutation]);
    set((state) => {
        const current = state.notes[id];
        return current
            ? { notes: { ...state.notes, [id]: { ...current, ...patch } } }
            : state;
    });
    scheduleShellSave(get);
    return mutation;
}
function finishNoteMutation(id: string, mutation: PendingNoteMutation): void {
    const pending = pendingNoteMutations.get(id);
    if (!pending)
        return;
    const index = pending.indexOf(mutation);
    if (index >= 0)
        pending.splice(index, 1);
    if (!pending.length)
        pendingNoteMutations.delete(id);
}
function applyPendingNoteMutations(id: string, summary: NoteSummary): NoteSummary {
    const pending = pendingNoteMutations.get(id);
    if (!pending?.length)
        return summary;
    return pending.reduce<NoteSummary>((current, mutation) => ({ ...current, ...mutation.patch }), summary);
}
function rollbackNoteMutation(id: string, mutation: PendingNoteMutation, set: SetNotesState, get: () => NotesState): void {
    let changed = false;
    set((state) => {
        const current = state.notes[id];
        if (!current)
            return state;
        const reverted: NoteSummary = { ...current };
        for (const key of Object.keys(mutation.patch) as (keyof OptimisticNotePatch)[]) {
            Object.assign(reverted, { [key]: mutation.before[key] });
        }
        const next = applyPendingNoteMutations(id, reverted);
        if (noteSummaryEqual(current, next))
            return state;
        changed = true;
        return { notes: { ...state.notes, [id]: next } };
    });
    if (changed)
        scheduleShellSave(get);
}
async function recoverNoteMutation(id: string, mutation: PendingNoteMutation, err: unknown, set: SetNotesState, get: () => NotesState): Promise<void> {
    finishNoteMutation(id, mutation);
    const server = err instanceof ApiError && err.isConflict
        ? (err.details as { server?: Note } | undefined)?.server
        : undefined;
    if (server) {
        adoptNote(server, set, get);
        return;
    }
    if (err instanceof ApiError && err.isAuth) {
        rollbackNoteMutation(id, mutation, set, get);
        location.reload();
        return;
    }
    if (!(err instanceof ApiError && err.isOffline)) {
        try {
            adoptNote(await api.notes.get(id), set, get);
            return;
        }
        catch {
        }
    }
    else {
        set({ online: false });
    }
    rollbackNoteMutation(id, mutation, set, get);
}
function advanceDirtyRevision(id: string, expectedRev: number, nextRev: number, get: () => NotesState): void {
    const pending = dirty.get(id);
    if (!pending || pending.rev !== expectedRev)
        return;
    const persisted = pending.persisted.then(async (durable) => {
        if (!durable)
            return false;
        try {
            await localDb.updateOutboxRevision(pending.queueId, pending.writeId, nextRev);
            return true;
        }
        catch {
            return false;
        }
    });
    dirty.set(id, { ...pending, rev: nextRev, dependsOnWriteId: undefined, persisted });
    const summary = get().notes[id];
    void localDb.setContent(id, {
        content: pending.content,
        contentDirty: pending.contentDirty,
        ...(pending.title !== undefined ? { pendingTitle: pending.title } : {}),
        rev: nextRev,
        updatedAt: summary?.updatedAt ?? Date.now(),
        writeId: pending.writeId,
    });
}
async function advanceDependentOutboxWrites(
    id: string,
    sourceWriteId: string,
    expectedRev: number,
    nextRev: number,
    get: () => NotesState,
    notifyTabs: boolean,
    visibleBatch?: OutboxItem[],
): Promise<void> {
    if (!Number.isInteger(expectedRev) || !Number.isInteger(nextRev) || nextRev <= expectedRev)
        return;
    if (inheritedOutboxWrites.get(id) === sourceWriteId)
        inheritedOutboxWrites.delete(id);
    await localDb.advanceOutboxDependents(id, sourceWriteId, expectedRev, nextRev).catch(() => { });
    if (visibleBatch) {
        for (const item of visibleBatch) {
            if (item.noteId !== id ||
                item.dependsOnWriteId !== sourceWriteId ||
                item.payload.rev !== expectedRev)
                continue;
            item.dependsOnWriteId = undefined;
            item.payload = { ...item.payload, rev: nextRev };
        }
    }
    const pending = dirty.get(id);
    if (pending?.dependsOnWriteId === sourceWriteId && pending.rev === expectedRev)
        advanceDirtyRevision(id, expectedRev, nextRev, get);
    if (notifyTabs) {
        publishBroadcast({
            type: 'outbox-base-advanced',
            clientId: CLIENT_ID,
            noteId: id,
            writeId: sourceWriteId,
            expectedRev,
            nextRev,
        });
    }
}
async function saveDirtyBeforeDestructiveMutation(id: string, set: SetNotesState, get: () => NotesState): Promise<boolean> {
    await get().flush({ immediate: true });
    if (dirty.has(id)) {
        set((state) => ({ saveStatus: state.online ? 'dirty' : 'offline' }));
        return false;
    }
    const remaining = await localDb.getOutbox();
    return !remaining.some((item) => item.noteId === id);
}
function markNotesOptimisticallyPurged(ids: string[], set: SetNotesState, get: () => NotesState): void {
    const idSet = new Set(ids);
    for (const id of ids) {
        purgedNoteIds.set(id, null);
        noteRequestEpochs.set(id, (noteRequestEpochs.get(id) ?? 0) + 1);
    }
    set((state) => {
        const notes = { ...state.notes };
        const contents = { ...state.contents };
        for (const id of ids) {
            delete notes[id];
            delete contents[id];
        }
        return { notes, contents };
    });
    for (const id of idSet)
        useUi.getState().removeWorkspaceNote(id);
    scheduleShellSave(get);
}
function restoreOptimisticallyPurgedNotes(snapshots: Array<{
    note: NoteSummary;
    content: string | undefined;
    hadContent: boolean;
}>, set: SetNotesState, get: () => NotesState): void {
    for (const snapshot of snapshots)
        purgedNoteIds.delete(snapshot.note.id);
    set((state) => {
        const notes = { ...state.notes };
        const contents = { ...state.contents };
        for (const snapshot of snapshots) {
            notes[snapshot.note.id] = applyPendingNoteMutations(snapshot.note.id, snapshot.note);
            if (snapshot.hadContent)
                contents[snapshot.note.id] = snapshot.content!;
        }
        return { notes, contents };
    });
    scheduleShellSave(get);
}
function restoreVersionSnapshot(id: string, optimistic: NoteSummary, before: NoteSummary, optimisticContent: string, beforeContent: string, set: SetNotesState, get: () => NotesState): void {
    let restored = false;
    set((state) => {
        const current = state.notes[id];
        if (!current || !noteSummaryEqual(current, optimistic) || state.contents[id] !== optimisticContent)
            return state;
        restored = true;
        return {
            notes: { ...state.notes, [id]: applyPendingNoteMutations(id, before) },
            contents: { ...state.contents, [id]: beforeContent },
        };
    });
    if (!restored)
        return;
    scheduleShellSave(get);
    void localDb.setContent(id, { content: beforeContent, rev: before.rev, updatedAt: before.updatedAt });
}
function discardNoteRuntimeState(id: string, tombstoneCursor?: number | null): void {
    noteRequestEpochs.set(id, (noteRequestEpochs.get(id) ?? 0) + 1);
    if (tombstoneCursor !== undefined)
        purgedNoteIds.set(id, tombstoneCursor);
    if (purgedNoteIds.size > 1000) {
        const oldest = purgedNoteIds.keys().next().value as string | undefined;
        if (oldest)
            purgedNoteIds.delete(oldest);
    }
    dirty.delete(id);
    inheritedOutboxWrites.delete(id);
    validatedRevisions.delete(id);
    noteRequests.delete(id);
    pendingNoteMutations.delete(id);
    const pendingDerivation = pendingSummaryDerivations.get(id);
    if (pendingDerivation)
        window.clearTimeout(pendingDerivation.timer);
    pendingSummaryDerivations.delete(id);
    for (const pane of ['primary', 'secondary'] as const) {
        if (latestRequestedNoteIds[pane] === id)
            latestRequestedNoteIds[pane] = null;
    }
}
function adoptNote(note: Note | NoteSummary, set: SetNotesState, get: () => NotesState): void {
    if (purgedNoteIds.has(note.id))
        return;
    if ((get().notes[note.id]?.rev ?? 0) > note.rev)
        return;
    const hasContent = 'content' in note;
    const incomingSummary = stripContent(note);
    const acceptContent = hasContent && !dirty.has(note.id);
    let shellChanged = false;
    set((state) => {
        const currentSummary = state.notes[note.id];
        const reconciled = applyPendingNoteMutations(note.id, mergeDirtySummary(currentSummary, incomingSummary));
        const nextSummary = currentSummary && noteSummaryEqual(currentSummary, reconciled)
            ? currentSummary
            : reconciled;
        const nextContent = acceptContent ? (note as Note).content : state.contents[note.id];
        const summaryChanged = currentSummary !== nextSummary;
        const contentChanged = acceptContent && state.contents[note.id] !== nextContent;
        const nextSaveStatus = dirty.size ? state.saveStatus : 'synced';
        const statusChanged = state.saveStatus !== nextSaveStatus;
        shellChanged = summaryChanged;
        if (!summaryChanged && !contentChanged && !statusChanged)
            return state;
        return {
            notes: summaryChanged ? { ...state.notes, [note.id]: nextSummary } : state.notes,
            contents: contentChanged ? { ...state.contents, [note.id]: nextContent! } : state.contents,
            saveStatus: nextSaveStatus,
        };
    });
    if (acceptContent) {
        void localDb.setContent(note.id, {
            content: (note as Note).content,
            rev: note.rev,
            updatedAt: note.updatedAt,
        });
    }
    if (shellChanged)
        scheduleShellSave(get);
}
function stripContent(note: Note | NoteSummary): NoteSummary {
    const { content: _content, ...summary } = note as Note;
    return summary;
}
function hasOwnContent(contents: Record<string, string>, id: string): boolean {
    return Object.prototype.hasOwnProperty.call(contents, id);
}
function requestNote(id: string): Promise<Note> {
    const pending = noteRequests.get(id);
    if (pending)
        return pending;
    const epoch = noteRequestEpochs.get(id) ?? 0;
    const request = api.notes.get(id).then((note) => {
        if ((noteRequestEpochs.get(id) ?? 0) !== epoch)
            throw STALE_NOTE_REQUEST;
        return note;
    }).finally(() => {
        if (noteRequests.get(id) === request)
            noteRequests.delete(id);
    });
    noteRequests.set(id, request);
    return request;
}
function revalidateNote(id: string, rev: number, set: SetNotesState, get: () => NotesState): void {
    if (dirty.has(id) || validatedRevisions.get(id) === rev)
        return;
    validatedRevisions.set(id, rev);
    void requestNote(id)
        .then((note) => {
        validatedRevisions.set(id, note.rev);
        adoptNote(note, set, get);
    })
        .catch(() => {
        if (validatedRevisions.get(id) === rev)
            validatedRevisions.delete(id);
    });
}
async function settleSavedPatch(id: string, submitted: Pick<DirtyNoteWrite, 'content' | 'writeId'>, saved: Note, set: SetNotesState, get: () => NotesState): Promise<void> {
    const latest = dirty.get(id);
    if (latest && latest.writeId !== submitted.writeId) {
        advanceDirtyRevision(id, latest.rev, saved.rev, get);
        await dirty.get(id)?.persisted;
        adoptNote(saved, set, get);
        return;
    }
    dirty.delete(id);
    adoptNote(saved, set, get);
}
function noteSummaryEqual(a: NoteSummary, b: NoteSummary): boolean {
    return (a.id === b.id &&
        a.title === b.title &&
        a.excerpt === b.excerpt &&
        a.folderId === b.folderId &&
        a.isPinned === b.isPinned &&
        a.isStarred === b.isStarred &&
        a.isArchived === b.isArchived &&
        a.wordCount === b.wordCount &&
        a.charCount === b.charCount &&
        a.rev === b.rev &&
        a.position === b.position &&
        a.createdAt === b.createdAt &&
        a.updatedAt === b.updatedAt &&
        a.deletedAt === b.deletedAt &&
        a.tags.length === b.tags.length &&
        a.tags.every((tag, index) => tag === b.tags[index]));
}
function scheduleShellSave(get: () => NotesState): void {
    const state = get();
    localDb.scheduleShellSave({
        notes: Object.values(state.notes),
        folders: state.folders,
        tags: state.tags,
        cursor: state.cursor,
    });
}
function deletionCursorFrom(err: ApiError): number | null {
    const value = (err.details as { deletionCursor?: unknown } | undefined)?.deletionCursor;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function outboxId(noteId: string): string {
    return `patch:${CLIENT_ID}:${noteId}`;
}
function newLocalWriteId(): string {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
const NOTE_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
function newLocalEntityId(): string {
    let timestamp = '';
    let value = Date.now();
    for (let index = 0; index < 10; index++) {
        timestamp = NOTE_ID_ALPHABET[value % 32] + timestamp;
        value = Math.floor(value / 32);
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let random = '';
    for (const byte of bytes)
        random += NOTE_ID_ALPHABET[byte & 31];
    return timestamp + random;
}
function newRecoveryNoteId(): string {
    return newLocalEntityId();
}
function outboxAttemptKey(item: OutboxItem): string {
    return `${item.id}\u0000${item.writeId}`;
}
function replayAttemptKey(item: OutboxItem): string {
    return `${outboxAttemptKey(item)}\u0000${String(item.payload.rev)}`;
}
function dirtyOutboxItem(noteId: string, pending: DirtyNoteWrite): OutboxItem {
    return {
        id: pending.queueId,
        clientId: CLIENT_ID,
        writeId: pending.writeId,
        dependsOnWriteId: pending.dependsOnWriteId,
        noteId,
        payload: {
            content: pending.content,
            contentDirty: pending.contentDirty,
            rev: pending.rev,
            ...(pending.title !== undefined ? { title: pending.title } : {}),
        },
        attempts: 0,
        createdAt: pending.updatedAt,
    };
}
async function loadReplayOutbox(): Promise<OutboxItem[]> {
    for (let round = 0; round < 4; round++) {
        const snapshot = [...dirty.entries()];
        const durable = await Promise.all(snapshot.map(([, pending]) => pending.persisted));
        let retried = false;
        snapshot.forEach(([noteId, pending], index) => {
            if (durable[index] || dirty.get(noteId)?.writeId !== pending.writeId)
                return;
            const persisted = localDb.enqueueOutbox(dirtyOutboxItem(noteId, pending)).then(() => true, () => false);
            dirty.set(noteId, { ...pending, persisted });
            retried = true;
        });
        if (!retried)
            break;
    }
    const outbox = await localDb.getOutbox();
    const latestSlots = new Map([...dirty.values()].map((pending) => [pending.queueId, pending.writeId]));
    return sortOutboxForReplay(outbox.filter((item) => {
        const latestWriteId = latestSlots.get(item.id);
        return !latestWriteId || latestWriteId === item.writeId;
    }));
}
function sortOutboxForReplay(items: OutboxItem[]): OutboxItem[] {
    const stable = items
        .slice()
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const byWriteId = new Map(stable.map((item) => [item.writeId, item]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const result: OutboxItem[] = [];
    const visit = (item: OutboxItem): void => {
        if (visited.has(item.writeId))
            return;
        if (visiting.has(item.writeId)) {
            return;
        }
        visiting.add(item.writeId);
        const dependency = item.dependsOnWriteId ? byWriteId.get(item.dependsOnWriteId) : undefined;
        if (dependency)
            visit(dependency);
        visiting.delete(item.writeId);
        if (!visited.has(item.writeId)) {
            visited.add(item.writeId);
            result.push(item);
        }
    };
    for (const item of stable)
        visit(item);
    return result;
}
async function completeOutboxQuietly(id: string, writeId: string): Promise<boolean> {
    try {
        await localDb.completeOutboxItem(id, writeId);
        return true;
    }
    catch {
        useUi.getState().toast({
            title: t("notes.could_not_update_the_offline_queue_state"),
            description: t("notes.the_server_received_your_content_but_the_browser_could_not_update_its_lo"),
            tone: 'warning',
            duration: 12_000,
        });
        return false;
    }
}
function rememberRecoveredOutbox(id: string, writeId: string, result: RecoveryResult): void {
    const key = `${id}\u0000${writeId}`;
    recoveredOutboxWrites.set(key, result);
    if (recoveredOutboxWrites.size > 200) {
        const oldest = recoveredOutboxWrites.keys().next().value as string | undefined;
        if (oldest)
            recoveredOutboxWrites.delete(oldest);
    }
}
async function settleRecoveredOutbox(id: string, writeId: string, result: RecoveryResult): Promise<boolean> {
    rememberRecoveredOutbox(id, writeId, result);
    const completed = await completeOutboxQuietly(id, writeId);
    if (completed)
        recoveredOutboxWrites.delete(`${id}\u0000${writeId}`);
    return completed;
}
async function retryRecoveredOutbox(item: OutboxItem): Promise<boolean> {
    const key = outboxAttemptKey(item);
    const result = recoveredOutboxWrites.get(key);
    if (!result)
        return false;
    try {
        await localDb.completeOutboxItem(item.id, item.writeId);
        recoveredOutboxWrites.delete(key);
        publishOutboxResult(item, result);
    }
    catch {
    }
    return true;
}
type OutboxResult = Extract<BroadcastPayload, { type: 'outbox-result' }>;
function publishOutboxResult(item: OutboxItem, result: Pick<OutboxResult, 'outcome' | 'recoveryReason' | 'rev' | 'updatedAt' | 'savedTitle' | 'savedNote' | 'copyId'>): void {
    if (!item.clientId || item.clientId === CLIENT_ID)
        return;
    publishBroadcast({
        type: 'outbox-result',
        clientId: CLIENT_ID,
        targetClientId: item.clientId,
        noteId: item.noteId,
        writeId: item.writeId,
        ...result,
    });
}
function showOfflineRecoveryToast(copyId: string, conflict: boolean): void {
    useUi.getState().toast({
        title: conflict
            ? t("notes.offline_changes_conflict_with_the_remote_version")
            : t("notes.the_original_note_has_been_deleted"),
        description: conflict
            ? t("notes.your_offline_changes_were_saved_as_a_copy_the_original_note_keeps_the_re")
            : t("notes.offline_modifications_have_been_restored_as_a_new_note"),
        tone: 'warning',
        duration: 9000,
        action: {
            label: conflict ? t("notes.open_a_copy") : t("common.open"),
            run: () => void useNotes.getState().openNote(copyId),
        },
    });
}
function replayOutbox(get: () => NotesState, set: SetNotesState): Promise<void> {
    if (outboxReplayPromise)
        return outboxReplayPromise;
    outboxReplayPromise = localDb.withOutboxReplayLock(CLIENT_ID, async () => {
        await replayOutboxNow(get, set);
    }).then(async (acquired) => {
        if (acquired)
            return;
        const pending = await localDb.getOutbox();
        set({ pendingCount: pendingNoteCount(pending) });
    }).finally(() => {
        outboxReplayPromise = null;
    });
    return outboxReplayPromise;
}
async function replayOutboxNow(get: () => NotesState, set: SetNotesState): Promise<void> {
    const attempted = new Set<string>();
    let stoppedOffline = false;
    for (let round = 0; round < 20 && !stoppedOffline; round++) {
        const outbox = await loadReplayOutbox();
        const batch = outbox.filter((item) => !attempted.has(replayAttemptKey(item)));
        if (!batch.length)
            break;
        for (const item of batch) {
            attempted.add(replayAttemptKey(item));
            const pendingCreate = pendingNoteCreates.get(item.noteId);
            if (pendingCreate) {
                try {
                    await pendingCreate;
                }
                catch {
                    continue;
                }
            }
            if (await retryRecoveredOutbox(item))
                continue;
            const currentLocal = item.clientId === CLIENT_ID ? dirty.get(item.noteId) : undefined;
            if (currentLocal?.queueId === item.id && currentLocal.writeId !== item.writeId) {
                await currentLocal.persisted;
                continue;
            }
            let latestLocal = item.clientId === CLIENT_ID && dirty.get(item.noteId)?.writeId === item.writeId
                ? dirty.get(item.noteId)
                : undefined;
            if (latestLocal)
                await latestLocal.persisted;
            const durableRev = item.payload.rev;
            if (latestLocal && Number.isInteger(durableRev) && (durableRev as number) > latestLocal.rev) {
                advanceDirtyRevision(item.noteId, latestLocal.rev, durableRev as number, get);
                latestLocal = dirty.get(item.noteId);
            }
            const content = latestLocal?.content ?? item.payload.content;
            const contentDirty = latestLocal?.contentDirty ?? item.payload.contentDirty !== false;
            const queuedTitle = latestLocal?.title ?? item.payload.title;
            const title = typeof queuedTitle === 'string' ? queuedTitle : undefined;
            const rev = latestLocal?.rev ?? item.payload.rev;
            if (typeof content !== 'string' || !Number.isInteger(rev) || (rev as number) < 1) {
                await localDb.markOutboxFailure(item.id, item.writeId, 'invalid offline journal payload').catch(() => { });
                continue;
            }
            try {
                const saved = await api.notes.patch(item.noteId, {
                    rev: rev as number,
                    ...(contentDirty ? { content } : {}),
                    ...(typeof title === 'string' ? { title } : {}),
                    ...(item.payload.preserveVersion === true ? { preserveVersion: true } : {}),
                });
                if (item.clientId === CLIENT_ID)
                    await settleSavedPatch(item.noteId, { content, writeId: item.writeId }, saved, set, get);
                else
                    adoptNote(saved, set, get);
                if (typeof title === 'string')
                    void get().pull({ force: true });
                await advanceDependentOutboxWrites(
                    item.noteId,
                    item.writeId,
                    rev as number,
                    saved.rev,
                    get,
                    true,
                    batch,
                );
                const completed = await completeOutboxQuietly(item.id, item.writeId);
                if (completed) {
                    publishOutboxResult(item, {
                        outcome: 'saved',
                        rev: saved.rev,
                        updatedAt: saved.updatedAt,
                        savedTitle: saved.title,
                        ...(!contentDirty && saved.content !== content ? { savedNote: saved } : {}),
                    });
                    set({ lastSavedAt: Date.now(), online: true });
                }
            }
            catch (err) {
                if (err instanceof ApiError && err.isConflict) {
                    const localPending = item.clientId === CLIENT_ID ? dirty.get(item.noteId) : undefined;
                    const localContent = localPending?.content ?? content;
                    const localContentDirty = localPending?.contentDirty ?? contentDirty;
                    const localTitle = localPending?.title ?? title;
                    const server = (err.details as { server?: Note } | undefined)?.server;
                    const acknowledged = server && (!localContentDirty || server.content === localContent) &&
                        (typeof localTitle !== 'string' || server.title === localTitle)
                        ? (localPending ?? { content, writeId: item.writeId })
                        : server && (!contentDirty || server.content === content) &&
                            (typeof title !== 'string' || server.title === title)
                            ? { content, writeId: item.writeId }
                            : null;
                    if (server && acknowledged) {
                        if (item.clientId === CLIENT_ID)
                            await settleSavedPatch(item.noteId, acknowledged, server, set, get);
                        else
                            adoptNote(server, set, get);
                        await advanceDependentOutboxWrites(
                            item.noteId,
                            item.writeId,
                            rev as number,
                            server.rev,
                            get,
                            true,
                            batch,
                        );
                        const completed = await completeOutboxQuietly(item.id, acknowledged.writeId);
                        if (completed) {
                            publishOutboxResult(item, {
                                outcome: 'saved',
                                rev: server.rev,
                                updatedAt: server.updatedAt,
                                savedTitle: server.title,
                                ...(!localContentDirty && server.content !== localContent ? { savedNote: server } : {}),
                            });
                            set({ lastSavedAt: Date.now(), online: true });
                        }
                        continue;
                    }
                    if (!server) {
                        await localDb.markOutboxFailure(item.id, item.writeId, 'conflict response did not include the server note').catch(() => { });
                        continue;
                    }
                }
                if (err instanceof ApiError && (err.status === 404 || err.isConflict)) {
                    const server = err.isConflict
                        ? (err.details as { server: Note }).server
                        : undefined;
                    const localPending = item.clientId === CLIENT_ID ? dirty.get(item.noteId) : undefined;
                    const localContent = server && !(localPending?.contentDirty ?? contentDirty)
                        ? server.content : localPending?.content ?? content;
                    const localTitle = localPending?.title ?? title ?? server?.title ?? get().notes[item.noteId]?.title ?? '';
                    const recoveredWriteId = localPending?.writeId ?? item.writeId;
                    if (localPending)
                        await localPending.persisted;
                    let recoveryId = typeof item.payload.recoveryId === 'string'
                        ? item.payload.recoveryId
                        : '';
                    if (!recoveryId) {
                        recoveryId = newRecoveryNoteId();
                        try {
                            await localDb.setOutboxRecoveryId(item.id, recoveredWriteId, recoveryId);
                            item.payload = { ...item.payload, recoveryId };
                        }
                        catch {
                            await localDb.markOutboxFailure(item.id, recoveredWriteId, 'could not persist the recovery note id').catch(() => { });
                            continue;
                        }
                    }
                    const copyId = await get().createNote({
                        id: recoveryId,
                        title: server ? duplicateNoteTitle(localTitle, LIMITS.titleMaxLength) : localTitle,
                        content: localContent,
                        folderId: server?.folderId ?? get().notes[item.noteId]?.folderId ?? null,
                        open: false,
                    });
                    if (!copyId)
                        continue;
                    const recoveredLatest = !localPending || dirty.get(item.noteId)?.writeId === localPending.writeId;
                    if (localPending && recoveredLatest)
                        dirty.delete(item.noteId);
                    const recoveryResult = { outcome: 'recovered' as const,
                        recoveryReason: server ? 'conflict' as const : 'deleted' as const, copyId };
                    const completed = await settleRecoveredOutbox(item.id, recoveredWriteId, recoveryResult);
                    if (completed)
                        publishOutboxResult(item, recoveryResult);
                    if (item.clientId === CLIENT_ID) {
                        if (recoveredLatest && !server) {
                            const openPane = workspacePaneForNote(item.noteId);
                            const wasActive = useUi.getState().activeNoteId === item.noteId;
                            const deletionCursor = deletionCursorFrom(err);
                            discardNoteRuntimeState(item.noteId, deletionCursor);
                            set((state) => {
                                const notes = { ...state.notes };
                                const contents = { ...state.contents };
                                delete notes[item.noteId];
                                delete contents[item.noteId];
                                return { notes, contents, saveStatus: dirty.size ? 'dirty' : 'synced' };
                            });
                            scheduleShellSave(get);
                            void localDb.dropContent(item.noteId);
                            if (openPane)
                                useUi.getState().setWorkspaceNote(openPane, copyId, wasActive);
                            if (deletionCursor === null)
                                void get().pull({ force: true }).catch(() => { });
                        }
                        showOfflineRecoveryToast(copyId, Boolean(server));
                    }
                    if (server) {
                        adoptNote(server, set, get);
                        set({ online: true });
                    }
                    continue;
                }
                if (err instanceof ApiError && err.isOffline) {
                    stoppedOffline = true;
                    set({ online: false, saveStatus: 'offline' });
                    break;
                }
                if (err instanceof ApiError && err.isAuth) {
                    location.reload();
                    return;
                }
                await localDb.markOutboxFailure(
                    item.id,
                    item.writeId,
                    err instanceof Error ? err.message : String(err),
                ).catch(() => {});
            }
        }
    }
    const remaining = await localDb.getOutbox();
    set({ pendingCount: pendingNoteCount(remaining) });
}
function pendingNoteCount(outbox: OutboxItem[]): number {
    const ids = new Set(outbox.map((item) => item.noteId));
    for (const id of dirty.keys())
        ids.add(id);
    return ids.size;
}
function refreshPendingCount(): void {
    void localDb.getOutbox()
        .then((outbox) => useNotes.setState({ pendingCount: pendingNoteCount(outbox) }))
        .catch(() => { });
}
export function acknowledgeOutboxBaseAdvanced(
    result: Extract<BroadcastPayload, { type: 'outbox-base-advanced' }>,
): Promise<void> {
    return advanceDependentOutboxWrites(
        result.noteId,
        result.writeId,
        result.expectedRev,
        result.nextRev,
        () => useNotes.getState(),
        false,
    );
}
export function acknowledgeOutboxResult(result: OutboxResult): void {
    if (result.targetClientId !== CLIENT_ID)
        return;
    const pending = dirty.get(result.noteId);
    if (!pending)
        return;
    const state = useNotes.getState();
    if (result.outcome === 'saved') {
        if (pending.writeId !== result.writeId) {
            if (result.rev !== undefined && result.rev > pending.rev) {
                advanceDirtyRevision(result.noteId, pending.rev, result.rev, () => useNotes.getState());
                void useNotes.getState().flush({ immediate: true });
            }
            return;
        }
        dirty.delete(result.noteId);
        if (result.savedNote?.id === result.noteId) {
            adoptNote(result.savedNote, useNotes.setState, () => useNotes.getState());
            useNotes.setState({ lastSavedAt: Date.now() });
            refreshPendingCount();
            return;
        }
        useNotes.setState((current) => {
            const note = current.notes[result.noteId];
            const nextRev = note && result.rev !== undefined && result.rev > note.rev
                ? result.rev
                : note?.rev;
            const nextTitle = note && typeof result.savedTitle === 'string'
                ? result.savedTitle
                : note?.title;
            const notes = note && (nextRev !== note.rev || nextTitle !== note.title)
                ? {
                    ...current.notes,
                    [result.noteId]: {
                        ...note,
                        title: nextTitle!,
                        rev: nextRev!,
                        updatedAt: result.updatedAt ?? note.updatedAt,
                    },
                }
                : current.notes;
            return {
                notes,
                saveStatus: dirty.size ? current.saveStatus : 'synced',
                lastSavedAt: Date.now(),
            };
        });
        const content = state.contents[result.noteId];
        if (content !== undefined && result.rev !== undefined) {
            void localDb.setContent(result.noteId, {
                content,
                rev: result.rev,
                updatedAt: result.updatedAt ?? Date.now(),
            });
        }
        scheduleShellSave(() => useNotes.getState());
        refreshPendingCount();
        return;
    }
    if (pending.writeId !== result.writeId)
        return;
    dirty.delete(result.noteId);
    validatedRevisions.delete(result.noteId);
    const openPane = workspacePaneForNote(result.noteId);
    const wasActive = useUi.getState().activeNoteId === result.noteId;
    useNotes.setState((current) => {
        const contents = { ...current.contents };
        delete contents[result.noteId];
        return {
            contents,
            saveStatus: dirty.size ? current.saveStatus : 'synced',
        };
    });
    void localDb.dropContent(result.noteId);
    refreshPendingCount();
    void useNotes.getState().pull().then(() => {
        if (openPane && useNotes.getState().notes[result.noteId])
            return useNotes.getState().openNote(result.noteId, { pane: openPane, activate: wasActive });
    });
    if (result.copyId)
        showOfflineRecoveryToast(result.copyId, result.recoveryReason !== 'deleted');
}
function reconcileNotes(current: Record<string, NoteSummary>, incoming: NoteSummary[], deletions: {
    entity: string;
    id: string;
}[], full: boolean): Record<string, NoteSummary> {
    if (full) {
        const next: Record<string, NoteSummary> = {};
        let unchanged = Object.keys(current).length === incoming.length;
        for (const remote of incoming) {
            if (purgedNoteIds.has(remote.id)) {
                unchanged = false;
                continue;
            }
            const candidate = reconcileRemoteSummary(current[remote.id], remote);
            const existing = current[remote.id];
            const note = existing && noteSummaryEqual(existing, candidate) ? existing : candidate;
            next[note.id] = note;
            if (existing !== note)
                unchanged = false;
        }
        for (const [id, note] of Object.entries(current)) {
            if ((dirty.has(id) || pendingNoteMutations.has(id) || pendingNoteCreates.has(id)) && !next[id])
                next[id] = note;
        }
        return unchanged ? current : next;
    }
    let next = current;
    const ensureCopy = () => {
        if (next === current)
            next = { ...current };
    };
    for (const remote of incoming) {
        if (purgedNoteIds.has(remote.id))
            continue;
        const candidate = reconcileRemoteSummary(current[remote.id], remote);
        const existing = current[remote.id];
        if (existing && noteSummaryEqual(existing, candidate))
            continue;
        ensureCopy();
        next[remote.id] = candidate;
    }
    for (const deletion of deletions) {
        if (deletion.entity !== 'note' || !next[deletion.id] || dirty.has(deletion.id) || pendingNoteMutations.has(deletion.id) || pendingNoteCreates.has(deletion.id))
            continue;
        ensureCopy();
        delete next[deletion.id];
    }
    return next;
}
function reconcileRemoteSummary(current: NoteSummary | undefined, incoming: NoteSummary): NoteSummary {
    // Loaded content keeps its revision until the full note arrives.
    if (current && incoming.rev > current.rev && !dirty.has(incoming.id) &&
        hasOwnContent(useNotes.getState().contents, incoming.id))
        return applyPendingNoteMutations(incoming.id, current);
    const base = current && current.rev > incoming.rev
        ? current
        : mergeDirtySummary(current, incoming);
    return applyPendingNoteMutations(incoming.id, base);
}
function mergeDirtySummary(current: NoteSummary | undefined, incoming: NoteSummary): NoteSummary {
    const pending = dirty.get(incoming.id);
    if (!current || !pending)
        return incoming;
    return {
        ...incoming,
        title: current.title,
        excerpt: current.excerpt,
        tags: current.tags,
        wordCount: current.wordCount,
        charCount: current.charCount,
        rev: pending.rev,
        updatedAt: current.updatedAt,
    };
}
function reconcileList<T extends {
    id: string;
}>(current: T[], incoming: T[], equal: (a: T, b: T) => boolean): T[] {
    const byId = new Map(current.map((item) => [item.id, item]));
    const next = incoming.map((item) => {
        const existing = byId.get(item.id);
        return existing && equal(existing, item) ? existing : item;
    });
    return next.length === current.length && next.every((item, index) => item === current[index])
        ? current
        : next;
}
function mergeById<T extends {
    id: string;
}>(current: T[], incoming: T[], deletions: {
    entity: string;
    id: string;
}[], entity: string, equal: (a: T, b: T) => boolean): T[] {
    const currentMap = new Map(current.map((item) => [item.id, item]));
    let map: Map<string, T> | null = null;
    for (const item of incoming) {
        const existing = currentMap.get(item.id);
        if (existing && equal(existing, item))
            continue;
        if (!map)
            map = new Map(currentMap);
        map.set(item.id, item);
    }
    for (const deletion of deletions) {
        if (deletion.entity !== entity || !currentMap.has(deletion.id))
            continue;
        if (!map)
            map = new Map(currentMap);
        map.delete(deletion.id);
    }
    return map ? [...map.values()] : current;
}
function folderEqual(a: Folder, b: Folder): boolean {
    return (a.id === b.id &&
        a.parentId === b.parentId &&
        a.name === b.name &&
        a.icon === b.icon &&
        a.color === b.color &&
        a.position === b.position &&
        a.createdAt === b.createdAt &&
        a.updatedAt === b.updatedAt &&
        a.noteCount === b.noteCount);
}
function normalizeFolder(folder: Folder): Folder {
    return folder.color === undefined ? { ...folder, color: null } : folder;
}
function reconcileFolderUi(folders: Folder[]): void {
    const validIds = new Set(folders.map((folder) => folder.id));
    const ui = useUi.getState();
    const expandedFolders = ui.expandedFolders.filter((id) => validIds.has(id));
    if (expandedFolders.length !== ui.expandedFolders.length)
        useUi.setState({ expandedFolders });
    if (ui.view === 'folder' && (!ui.folderId || !validIds.has(ui.folderId)))
        ui.openView('all');
}
function tagEqual(a: Tag, b: Tag): boolean {
    return (a.id === b.id &&
        a.name === b.name &&
        a.color === b.color &&
        a.count === b.count &&
        a.createdAt === b.createdAt);
}
function currentFolderId(): string | null {
    const ui = useUi.getState();
    return ui.view === 'folder' ? ui.folderId : null;
}
export function createContextualNote(input?: {
    title?: string;
    content?: string;
    open?: boolean;
}): Promise<string | null> {
    const ui = useUi.getState();
    if (ui.view === 'trash' || ui.view === 'archived') {
        ui.openView('all');
        return useNotes.getState().createNote(input);
    }
    return useNotes.getState().createNote({
        ...input,
        ...(ui.view === 'folder' ? { folderId: ui.folderId } : {}),
        ...(ui.view === 'tag' && ui.tag && input?.content === undefined ? { content: `#${ui.tag}\n\n` } : {}),
        ...(ui.view === 'starred' ? { isStarred: true } : {}),
    });
}
function toastError(err: unknown, fallback: string): void {
    useUi.getState().toast({
        title: fallback,
        description: err instanceof ApiError ? err.message : String(err),
        tone: 'danger',
    });
}
export interface NoteGroup {
    key: string;
    label: string;
    notes: NoteSummary[];
}
export interface NavigationCounts {
    all: number;
    starred: number;
    unfiled: number;
    archived: number;
    trash: number;
}
interface NavigationProjection {
    counts: NavigationCounts;
    folderCounts: ReadonlyMap<string, number>;
}
let navigationProjectionNotes: Record<string, NoteSummary> | null = null;
let navigationProjectionCache: NavigationProjection = {
    counts: { all: 0, starred: 0, unfiled: 0, archived: 0, trash: 0 },
    folderCounts: new Map(),
};
function selectNavigationProjection(notes: Record<string, NoteSummary>): NavigationProjection {
    if (notes === navigationProjectionNotes)
        return navigationProjectionCache;
    navigationProjectionNotes = notes;
    const counts: NavigationCounts = { all: 0, starred: 0, unfiled: 0, archived: 0, trash: 0 };
    const folderCounts = new Map<string, number>();
    for (const note of Object.values(notes)) {
        if (note.deletedAt) {
            counts.trash++;
            continue;
        }
        if (note.isArchived) {
            counts.archived++;
            continue;
        }
        counts.all++;
        if (note.isStarred)
            counts.starred++;
        if (!note.folderId) {
            counts.unfiled++;
        }
        else {
            folderCounts.set(note.folderId, (folderCounts.get(note.folderId) ?? 0) + 1);
        }
    }
    const stableCounts = navigationCountsEqual(navigationProjectionCache.counts, counts)
        ? navigationProjectionCache.counts
        : counts;
    const stableFolderCounts = numberMapEqual(navigationProjectionCache.folderCounts, folderCounts)
        ? navigationProjectionCache.folderCounts
        : folderCounts;
    if (stableCounts === navigationProjectionCache.counts &&
        stableFolderCounts === navigationProjectionCache.folderCounts) {
        return navigationProjectionCache;
    }
    navigationProjectionCache = { counts: stableCounts, folderCounts: stableFolderCounts };
    return navigationProjectionCache;
}
function navigationCountsEqual(a: NavigationCounts, b: NavigationCounts): boolean {
    return a.all === b.all &&
        a.starred === b.starred &&
        a.unfiled === b.unfiled &&
        a.archived === b.archived &&
        a.trash === b.trash;
}
function numberMapEqual(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
    if (a.size !== b.size)
        return false;
    for (const [key, value] of a) {
        if (b.get(key) !== value)
            return false;
    }
    return true;
}
export function useNavigationCounts(): NavigationCounts {
    return useNotes((state) => selectNavigationProjection(state.notes).counts);
}
function matchesView(note: NoteSummary, view: ViewKind, folderId: string | null, tag: string | null, folderScope?: ReadonlySet<string>): boolean {
    if (view === 'trash')
        return Boolean(note.deletedAt);
    if (note.deletedAt)
        return false;
    if (view === 'archived')
        return note.isArchived;
    if (note.isArchived)
        return false;
    switch (view) {
        case 'starred':
            return note.isStarred;
        case 'unfiled':
            return !note.folderId;
        case 'folder':
            return Boolean(note.folderId && (folderScope?.has(note.folderId) ?? note.folderId === folderId));
        case 'tag':
            return Boolean(tag && note.tags.includes(tag));
        case 'recent':
        case 'all':
        default:
            return true;
    }
}
function compare(a: NoteSummary, b: NoteSummary, sort: SortKey, order: SortOrder, locale: AppLocale): number {
    if (a.isPinned !== b.isPinned)
        return a.isPinned ? -1 : 1;
    const dir = order === 'asc' ? 1 : -1;
    let result: number;
    switch (sort) {
        case 'created':
            result = (a.createdAt - b.createdAt) * dir;
            break;
        case 'title':
            result = a.title.localeCompare(b.title, locale, { numeric: true, sensitivity: 'base' }) * dir;
            break;
        case 'updated':
        default:
            result = (a.updatedAt - b.updatedAt) * dir;
            break;
    }
    return result || a.id.localeCompare(b.id);
}
function compareTrash(a: NoteSummary, b: NoteSummary): number {
    return (b.deletedAt ?? b.updatedAt) - (a.deletedAt ?? a.updatedAt) || a.id.localeCompare(b.id);
}
function pickInitialNoteId(notes: Record<string, NoteSummary>, folders: Folder[]): string | null {
    const ui = useUi.getState();
    const folderScope = ui.view === 'folder' && ui.folderId ? folderDescendantIds(folders, ui.folderId) : undefined;
    const active = ui.activeNoteId ? notes[ui.activeNoteId] : undefined;
    if (active && matchesView(active, ui.view, ui.folderId, ui.tag, folderScope))
        return active.id;
    const visible = Object.values(notes).filter((note) => matchesView(note, ui.view, ui.folderId, ui.tag, folderScope));
    if (ui.view === 'recent') {
        visible.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    }
    else if (ui.view === 'trash') {
        visible.sort(compareTrash);
    }
    else {
        visible.sort((a, b) => compare(a, b, ui.sort, ui.order, getLocale()));
    }
    return visible[0]?.id ?? null;
}
export function useVisibleNotes(): NoteSummary[] {
    const locale = useLocale();
    const notes = useNotes((s) => s.notes);
    const folders = useNotes((s) => s.folders);
    const view = useUi((s) => s.view);
    const folderId = useUi((s) => s.folderId);
    const tag = useUi((s) => s.tag);
    const sort = useUi((s) => s.sort);
    const order = useUi((s) => s.order);
    return useMemo(() => {
        const folderScope = view === 'folder' && folderId ? folderDescendantIds(folders, folderId) : undefined;
        const list = Object.values(notes).filter((n) => matchesView(n, view, folderId, tag, folderScope));
        if (view === 'recent') {
            return list
                .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
                .slice(0, 60);
        }
        if (view === 'trash')
            return list.sort(compareTrash);
        return list.sort((a, b) => compare(a, b, sort, order, locale));
    }, [notes, folders, view, folderId, tag, sort, order, locale]);
}
export interface FolderNode extends Folder {
    children: FolderNode[];
    depth: number;
    directNotes: number;
    totalNotes: number;
}
export function useFolderTree(): FolderNode[] {
    const folders = useNotes((s) => s.folders);
    const direct = useNotes((state) => selectNavigationProjection(state.notes).folderCounts);
    return useMemo(() => buildFolderTree(folders, direct), [folders, direct]);
}
export function buildFolderTree(folders: Folder[], direct: ReadonlyMap<string, number>): FolderNode[] {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const byParent = new Map<string, Folder[]>();
    const compare = (a: Folder, b: Folder) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    for (const folder of folders) {
        const key = folder.parentId ?? '';
        const list = byParent.get(key) ?? [];
        list.push(folder);
        byParent.set(key, list);
    }
    for (const list of byParent.values())
        list.sort(compare);
    const visited = new Set<string>();
    const build = (folder: Folder, depth: number, parentId: string | null): FolderNode | null => {
        if (visited.has(folder.id))
            return null;
        visited.add(folder.id);
        const children = depth + 1 < LIMITS.folderDepthMax
            ? (byParent.get(folder.id) ?? []).flatMap((child) => {
                const node = build(child, depth + 1, folder.id);
                return node ? [node] : [];
            })
            : [];
        const directNotes = direct.get(folder.id) ?? 0;
        const totalNotes = directNotes + children.reduce((sum, child) => sum + child.totalNotes, 0);
        return { ...folder, parentId, children, depth, directNotes, totalNotes };
    };
    const roots = folders
        .filter((folder) => folder.parentId === null || !byId.has(folder.parentId))
        .sort(compare)
        .flatMap((folder) => {
        const node = build(folder, 0, null);
        return node ? [node] : [];
    });
    for (const folder of [...folders].sort(compare)) {
        if (visited.has(folder.id))
            continue;
        const node = build(folder, 0, null);
        if (node)
            roots.push(node);
    }
    return roots.sort(compare);
}
export function useActiveNote(pane: WorkspacePane | 'active' = 'active'): {
    note: NoteSummary | null;
    content: string;
    loaded: boolean;
} {
    const activeId = useUi((state) => {
        if (pane === 'active')
            return state.activeNoteId;
        if (!state.workspaceSecondaryNoteId)
            return pane === 'primary' ? state.activeNoteId : null;
        return pane === 'primary' ? state.workspacePrimaryNoteId : state.workspaceSecondaryNoteId;
    });
    const note = useNotes((s) => (activeId ? (s.notes[activeId] ?? null) : null));
    const storedContent = useNotes((s) => (activeId ? s.contents[activeId] : undefined));
    return {
        note,
        content: storedContent ?? '',
        loaded: !activeId || storedContent !== undefined,
    };
}
export function noteById(id: string): NoteSummary | undefined {
    return useNotes.getState().notes[id];
}

function captureWorkspaceState() {
    const ui = useUi.getState();
    return {
        activeNoteId: ui.activeNoteId,
        workspacePrimaryNoteId: ui.workspacePrimaryNoteId,
        workspaceSecondaryNoteId: ui.workspaceSecondaryNoteId,
        activeWorkspacePane: ui.activeWorkspacePane,
        selectedIds: ui.selectedIds,
        recentNoteIds: ui.recentNoteIds,
        mobilePane: ui.mobilePane,
    };
}

function workspaceContainsNote(id: string): boolean {
    const ui = useUi.getState();
    return ui.activeNoteId === id ||
        ui.workspacePrimaryNoteId === id ||
        ui.workspaceSecondaryNoteId === id;
}

function workspacePaneForNote(id: string): WorkspacePane | null {
    const ui = useUi.getState();
    if (ui.workspaceSecondaryNoteId) {
        if (ui.workspacePrimaryNoteId === id && ui.workspaceSecondaryNoteId === id)
            return ui.activeWorkspacePane;
        if (ui.workspacePrimaryNoteId === id)
            return 'primary';
        if (ui.workspaceSecondaryNoteId === id)
            return 'secondary';
    }
    return ui.activeNoteId === id ? 'primary' : null;
}

function restoreWorkspaceState(snapshot: ReturnType<typeof captureWorkspaceState>): void {
    useUi.setState(snapshot);
}
export function findNoteByTitle(title: string): NoteSummary | undefined {
    const key = normalizeLinkKey(title);
    return Object.values(useNotes.getState().notes).find((n) => !n.deletedAt && normalizeLinkKey(n.title) === key);
}
