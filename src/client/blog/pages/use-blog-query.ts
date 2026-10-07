import { useEffect, useState } from 'react'
import { BlogAuthError } from '../api'

export type BlogQueryStatus = 'loading' | 'error' | 'auth' | 'ready'

export function useBlogQuery<T>(load: () => Promise<T>, deps: readonly unknown[]): {
  status: BlogQueryStatus
  data: T | null
} {
  const [status, setStatus] = useState<BlogQueryStatus>('loading')
  const [data, setData] = useState<T | null>(null)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setData(null)
    load()
      .then((result) => {
        if (cancelled)
          return
        setData(result)
        setStatus('ready')
      })
      .catch((error) => {
        if (cancelled)
          return
        if (error instanceof BlogAuthError) {
          setStatus('auth')
          return
        }
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { status, data }
}
