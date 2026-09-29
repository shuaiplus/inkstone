import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface BlogLightboxState {
  src: string
  alt: string
}

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

export function BlogLightbox({ image, onClose }: {
  image: BlogLightboxState
  onClose: () => void
}) {
  const [scale, setScale] = useState(1)
  const [failed, setFailed] = useState(false)

  useEscape(true, onClose)
  useLockScroll(true)

  useLayoutEffect(() => {
    setScale(1)
    setFailed(false)
  }, [image.src])

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setScale((s) => Math.min(6, Math.max(0.3, s - e.deltaY * 0.002)))
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

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
          {image.alt && <p>{image.alt}</p>}
        </div>
      ) : (
        <img
          src={image.src}
          alt={image.alt}
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
          href={image.src}
          download
          target="_blank"
          rel="noreferrer"
          className="blog-lightbox-btn"
          aria-label="Download"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
        </a>
      </div>
      {image.alt && (
        <div className="blog-lightbox-alt">{image.alt}</div>
      )}
    </div>,
    document.body,
  )
}
