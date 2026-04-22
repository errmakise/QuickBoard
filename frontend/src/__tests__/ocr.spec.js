import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recognizeMathFromImageDataUrl } from '../services/ocr'

describe('ocr service', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', hostname: 'localhost' },
      writable: true
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns ok data when server responds ok', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, latex: '$x$' })
    })
    const r = await recognizeMathFromImageDataUrl({ imageDataUrl: 'data:image/png;base64,AA' })
    expect(r.ok).toBe(true)
    expect(r.latex).toBe('$x$')
  })

  it('maps non-2xx http into error payload', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: 'BAD_IMAGE' })
    })
    const r = await recognizeMathFromImageDataUrl({ imageDataUrl: 'data:image/png;base64,AA' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('BAD_IMAGE')
    expect(r.status).toBe(400)
  })

  it('returns TIMEOUT when request exceeds timeoutMs', async () => {
    globalThis.fetch.mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        const signal = opts && opts.signal
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener(
            'abort',
            () => {
              const e = new Error('Aborted')
              e.name = 'AbortError'
              reject(e)
            },
            { once: true }
          )
        }
      })
    })
    const p = recognizeMathFromImageDataUrl({ imageDataUrl: 'data:image/png;base64,AA', timeoutMs: 10 })
    await new Promise((r) => setTimeout(r, 15))
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.error).toBe('TIMEOUT')
  })
})
