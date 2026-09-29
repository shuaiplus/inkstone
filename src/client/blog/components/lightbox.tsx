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
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const swipeRef = useRef<{ id: number; x0: number; y0: number; locked: 'h' | 'v' | null } | null>(null)
  const swipedRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEscape(true, onClose)
  useLockScroll(true)

  useLayoutEffect(() => {
    setScale(1)
    setFailed(false)
    setDragX(0)
    swipedRef.current = false
  }, [src])

  // Left/right touch swipe to switch images (only when not zoomed in)
  useEffect(() => {
    const el = rootRef.current
    if (!el)
      return
    const SWIPE_THRESHOLD = 60
    const onDown = (e: TouchEvent) => {
      if (scale !== 1 || images.length < 2)
        return
      const t = e.touches[0]
      if (!t)
        return
      swipeRef.current = { id: t.identifier, x0: t.clientX, y0: t.clientY, locked: null }
    }
    const onMove = (e: TouchEvent) => {
      const s = swipeRef.current
      if (!s)
        return
      const t = e.changedTouches[0]
      if (!t || t.identifier !== s.id)
        return
      const dx = t.clientX - s.x0
      const dy = t.clientY - s.y0
      if (s.locked === null) {
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10)
          s.locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
      }
      if (s.locked !== 'h') {
        setDragX(0)
        setDragging(false)
        return
      }
      e.preventDefault()
      setDragging(true)
      // Damp horizontal drag at the ends so it feels "resistant"
      const damped = (index === 0 && dx > 0) || (index === images.length - 1 && dx < 0)
        ? dx / 3
        : dx
      setDragX(damped)
    }
    const onUp = (e: TouchEvent) => {
      const s = swipeRef.current
      if (!s)
        return
      const t = e.changedTouches[0]
      swipeRef.current = null
      setDragging(false)
      if (!t || t.identifier !== s.id || s.locked !== 'h') {
        setDragX(0)
        return
      }
      const dx = t.clientX - s.x0
      if (dx < -SWIPE_THRESHOLD && index < images.length - 1) {
        swipedRef.current = true
        onNavigate(index + 1)
      } else if (dx > SWIPE_THRESHOLD && index > 0) {
        swipedRef.current = true
        onNavigate(index - 1)
      }
      setDragX(0)
    }
    el.addEventListener('touchstart', onDown, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onUp)
    el.addEventListener('touchcancel', onUp)
    return () => {
      el.removeEventListener('touchstart', onDown)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onUp)
      el.removeEventListener('touchcancel', onUp)
    }
  }, [scale, images.length, index, onNavigate])

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
      ref={rootRef}
      onClick={() => {
        if (swipedRef.current) {
          swipedRef.current = false
          return
        }
        onClose()
      }}
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
          draggable={false}
          style={{ transform: `translateX(${dragX}px) scale(${scale})` }}
          className={`blog-lightbox-img${dragging ? ' blog-lightbox-img--dragging' : ''}`}
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
