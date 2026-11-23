declare module 'wasm-webp/dist/esm/index.js' {
  export interface DecodedWebPAnimationFrame {
    width: number
    height: number
    duration: number
    data: Uint8Array
  }

  export interface WebPAnimationFrameInput {
    data: Uint8Array
    duration: number
  }

  export function encodeAnimation(
    width: number,
    height: number,
    hasAlpha: boolean,
    frames: WebPAnimationFrameInput[],
  ): Promise<Uint8Array | null>

  export function decodeAnimation(
    data: Uint8Array,
    hasAlpha: boolean,
  ): Promise<DecodedWebPAnimationFrame[] | null>
}
