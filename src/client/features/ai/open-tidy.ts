import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { getEditorSelection } from './active-editor'
import { WHOLE_NOTE_RANGE, setAiPanelRequest } from './request'

export function openAiTidyForNote(noteId: string): void {
  const selection = getEditorSelection()
  const body = useNotes.getState().contents[noteId] ?? ''
  setAiPanelRequest(
    selection
      ? {
          mode: 'tidy',
          input: selection.text,
          target: { noteId, from: selection.from, to: selection.to, originalText: selection.text },
        }
      : {
          mode: 'tidy',
          input: body,
          target: { noteId, from: WHOLE_NOTE_RANGE, to: WHOLE_NOTE_RANGE, originalText: body },
        },
  )
  useUi.getState().openPanel('ai')
}

export function openAiTidyForActiveNote(): void {
  const noteId = useUi.getState().activeNoteId
  if (noteId) openAiTidyForNote(noteId)
}
