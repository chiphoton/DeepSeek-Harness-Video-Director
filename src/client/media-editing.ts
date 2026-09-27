import { createContext } from 'react'
import type { AssetRef } from './types'

export interface MediaCrop { x: number; y: number; width: number; height: number }
export interface MediaEdit { start: number; end: number; crop?: MediaCrop; time?: number }
export type MediaEditAction = 'export' | 'save' | 'copy' | 'frame'
export type MediaEditResult = { asset: AssetRef } | { name: string; mimeType: string; dataBase64: string }
export type EditMedia = (source: AssetRef, edit: MediaEdit, action: MediaEditAction, signal: AbortSignal) => Promise<MediaEditResult>
export const MediaEditingContext = createContext<EditMedia | null>(null)
