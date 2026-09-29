import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

function useEscape(active: boolean, onEscape: () => void) {
  const ref = useRef(onEscape)
  ref.current = onEscape
  useEffect(() => {
    if (!active)
      return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        ref.current()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active])
}

function useLockScroll(active: boolean) {
  useEffect(() => {
    if (!active)
      return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [active])
}

export function BlogLightbox({ images, index, onClose, onNavigate }: {
  images: string[]
  index: number
  onClose: () => void
  onNavigate: (index: number) => void
}) {
  const src = images[index] ?? ''
  const [scale, setScale] = useState(1)
  const [failed, setFailed] = useState(false)

  useEscape(true, onClose)
  useLockScroll(true)

  useLayoutEffect(() => {
    setScale(1)
    setFailed(false)
  }, [src])

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setScale((s) => Math.min(6, Math.max(0.3, s - e.deltaY * 0.002)))
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  const hasPrev = index > 0
  const hasNext = index < images.length - 1

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && hasPrev) {
        e.preventDefault()
        onNavigate(index - 1)
      } else if (e.key === 'ArrowRight' && hasNext) {
        e.preventDefault()
        onNavigate(index + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hasPrev, hasNext, index, onNavigate])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      className="blog-lightbox"
      onClick={onClose}
    >
      {failed ? (
        <div className="blog-lightbox-failed">
          <p>Image failed to load</p>
        </div>
      ) : (
        <img
          src={src}
          alt=""
          onError={() => setFailed(true)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={() => setScale((s) => (s === 1 ? 2 : 1))}
          style={{ transform: `scale(${scale})` }}
          className="blog-lightbox-img"
        />
      )}
      <button
        type="button"
        className="blog-lightbox-close"
        onClick={(e) => { e.stopPropagation(); onClose() }}
        aria-label="Close"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M6 6l12 12M6 18L18 6" />
        </svg>
      </button>
      {images.length > 1 && (
        <>
          <button
            type="button"
            className="blog-lightbox-arrow blog-lightbox-arrow--prev"
            disabled={!hasPrev}
            onClick={(e) => { e.stopPropagation(); if (hasPrev) onNavigate(index - 1) }}
            aria-label="Previous"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <button
            type="button"
            className="blog-lightbox-arrow blog-lightbox-arrow--next"
            disabled={!hasNext}
            onClick={(e) => { e.stopPropagation(); if (hasNext) onNavigate(index + 1) }}
            aria-label="Next"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </button>
          <div className="blog-lightbox-counter">{index + 1} / {images.length}</div>
        </>
      )}
      <div className="blog-lightbox-controls" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="blog-lightbox-btn"
          disabled={failed || scale <= 0.3}
          onClick={() => setScale((s) => Math.max(0.3, s - 0.25))}
          aria-label="Zoom out"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M8 11h6M20 20l-3.5-3.5" /></svg>
        </button>
        <span className="blog-lightbox-zoom">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className="blog-lightbox-btn"
          disabled={failed || scale >= 6}
          onClick={() => setScale((s) => Math.min(6, s + 0.25))}
          aria-label="Zoom in"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M11 8v6M8 11h6M20 20l-3.5-3.5" /></svg>
        </button>
        <a
          href={src}
          download
          target="_blank"
          rel="noreferrer"
          className="blog-lightbox-btn"
          aria-label="Download"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
        </a>
      </div>
    </div>,
    document.body,
  )
}
