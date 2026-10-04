import { APP_SHORTCUTS } from '../../lib/shortcuts'
import { Search } from 'lucide-react'
import { Tooltip } from '../../components/overlay'
import { IconButton, Kbd } from '../../components/primitives'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'

export function SearchButton({ variant = 'row' }: { variant?: 'row' | 'icon' | 'mobile' }) {
  const open = useUi((state) => state.openSearchList)
  const label = t('shell.search_all_notes')

  if (variant === 'icon') {
    return (
      <Tooltip label={label} combo={APP_SHORTCUTS.search} side="right">
        <IconButton label={label} onClick={open}><Search size={16} /></IconButton>
      </Tooltip>
    )
  }

  if (variant === 'mobile') {
    return (
      <button type="button" aria-label={label} onClick={open} className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-[var(--text-quaternary)] transition-colors active:bg-[var(--bg-active)]">
        <Search size={19} />
        <span>{t('shell.search')}</span>
      </button>
    )
  }

  return (
    <button type="button" aria-label={label} onClick={open} className="flex h-9 w-full min-w-0 shrink-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 text-[12px] text-[var(--text-tertiary)] transition-colors hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
      <Search size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">{t('shell.search')}</span>
      <Kbd combo={APP_SHORTCUTS.search} />
    </button>
  )
}
