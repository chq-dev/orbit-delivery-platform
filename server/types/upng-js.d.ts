declare module 'upng-js' {
  export interface UpngFrame {
    delay?: number
  }

  export interface UpngImage {
    width: number
    height: number
    depth: number
    ctype: number
    frames: UpngFrame[]
    tabs: Record<string, unknown>
  }

  const UPNG: {
    decode(buffer: ArrayBuffer): UpngImage
    toRGBA8(image: UpngImage): ArrayBuffer[]
    encode(
      frames: ArrayBuffer[],
      width: number,
      height: number,
      colors?: number,
      delays?: number[],
      forbidPlte?: boolean,
    ): ArrayBuffer
  }

  export default UPNG
}
