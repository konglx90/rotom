import { useCallback, useState } from 'react'
import { api } from '../../api/client'

/**
 * Image upload hook with browser-side Canvas compression.
 *
 * Pipeline: File → decode → resize (max edge 2000px) → re-encode WebP q=0.85
 * (or JPEG fallback) → base64 → POST /api/uploads.
 *
 * GIFs skip the canvas path entirely — re-encoding would flatten animation.
 * Files that aren't `image/*` are rejected up front.
 *
 * Server enforces a 15MB hard ceiling on the decoded payload, so post-resize
 * we're always well under. We don't pre-check size client-side beyond what
 * the server does; let the server be the source of truth.
 */

const MAX_EDGE = 2000
const WEBP_QUALITY = 0.85

export interface UploadResult {
  url: string
  name: string
  size: number
  mimeType: string
}

export function useImageUpload(groupId: string | undefined) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = useCallback(async (file: File): Promise<UploadResult | null> => {
    if (!groupId) {
      setError('No group selected')
      return null
    }
    if (!file.type.startsWith('image/')) {
      setError(`${file.name} is not an image`)
      return null
    }

    setUploading(true)
    setError(null)
    try {
      // GIF passes through to preserve animation; everything else goes
      // through the canvas resize/re-encode path.
      const payload =
        file.type === 'image/gif'
          ? await passthroughGif(file)
          : await compressViaCanvas(file)

      if (!payload) {
        setError(`Failed to process ${file.name}`)
        return null
      }

      const result = await api.post<UploadResult>('/uploads', {
        groupId,
        fileName: file.name,
        mimeType: payload.mimeType,
        dataBase64: payload.dataBase64,
      })
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      return null
    } finally {
      setUploading(false)
    }
  }, [groupId])

  return { upload, uploading, error, clearError: () => setError(null) }
}

async function passthroughGif(file: File): Promise<{ mimeType: string; dataBase64: string }> {
  const buf = await file.arrayBuffer()
  return {
    mimeType: 'image/gif',
    dataBase64: arrayBufferToBase64(buf),
  }
}

async function compressViaCanvas(
  file: File,
): Promise<{ mimeType: string; dataBase64: string }> {
  // Prefer createImageBitmap — it's faster and off-main-thread. Fall back to
  // the classic HTMLImageElement + dataURL path on older browsers (Safari
  // <15 etc.); if even that fails, give up and let the caller surface an error.
  let bitmap: ImageBitmap | null = null
  if (typeof createImageBitmap === 'function') {
    try {
      bitmap = await createImageBitmap(file)
    } catch {
      bitmap = null
    }
  }
  if (!bitmap) {
    bitmap = await loadViaImageElement(file)
  }

  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2d context unavailable')
  ctx.drawImage(bitmap, 0, 0, width, height)

  // WebP has wide support as of 2024; fall back to JPEG for the rare legacy
  // browser. Both branches re-encode at q=0.85 which is visually lossless for
  // screenshots and beats PNG/JPEG source by 5-10×.
  const supportsWebp = canvas.toDataURL('image/webp').startsWith('data:image/webp')
  const targetMime = supportsWebp ? 'image/webp' : 'image/jpeg'
  const blob = await new Promise<Blob | null>(resolve =>
    canvas.toBlob(resolve, targetMime, WEBP_QUALITY),
  )
  if (!blob) throw new Error('Canvas encoding failed')

  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close()

  const buf = await blob.arrayBuffer()
  return {
    mimeType: targetMime,
    dataBase64: arrayBufferToBase64(buf),
  }
}

function loadViaImageElement(file: File): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      // Cast through createImageBitmap's actual result type. If createImageBitmap
      // is missing entirely this branch will throw and the caller surfaces the
      // error — which is correct, since we can't reliably get pixel data without
      // either API.
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(img).then(resolve, reject)
      } else {
        reject(new Error('Browser lacks both createImageBitmap and Image decode'))
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Image decode failed'))
    }
    img.src = url
  })
}

function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  if (w <= maxEdge && h <= maxEdge) return { width: w, height: h }
  const scale = maxEdge / Math.max(w, h)
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // Chunk in 32KB slices to avoid call stack limits on String.fromCharCode
  // for large buffers (V8 hardcodes ~64K arg limit).
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000
  let out = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(out)
}
