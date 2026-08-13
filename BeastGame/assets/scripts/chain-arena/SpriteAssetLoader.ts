import {
  ImageAsset, Rect, Size, SpriteFrame, Texture2D,
} from 'cc';

export interface ArenaSpriteFrames {
  arena: SpriteFrame;
  unit: SpriteFrame;
  ironBall: SpriteFrame;
  barrel: SpriteFrame;
  chainLink: SpriteFrame;
}

/**
 * Lazily builds one shared 512x512 RGBA atlas.
 *
 * Cocos 3.8.8 imports SVG ImageAssets with a zero native size in this project,
 * which reaches the GPU as the magenta missing-texture placeholder. A memory
 * image uses the same Sprite render path without relying on platform SVG
 * decoding and costs 1 MiB once per run.
 */
export class SpriteAssetLoader {
  private static frames: ArenaSpriteFrames | null = null;

  static getFrames(): ArenaSpriteFrames {
    if (this.frames) return this.frames;
    const width = 512;
    const height = 512;
    const pixels = new Uint8Array(width * height * 4);
    this.drawArena(pixels, width, 0, 0, 480, 300);
    this.drawUnit(pixels, width, 0, 320, 64);
    this.drawIronBall(pixels, width, 72, 320, 72);
    this.drawBarrel(pixels, width, 152, 320, 48, 64);
    this.drawChainLink(pixels, width, 208, 320, 64);

    const image = new ImageAsset({
      _data: pixels,
      _compressed: false,
      width,
      height,
      format: Texture2D.PixelFormat.RGBA8888,
    });
    const texture = new Texture2D();
    texture.image = image;
    this.frames = {
      arena: this.createFrame(texture, 0, 0, 480, 300),
      unit: this.createFrame(texture, 0, 320, 64, 64),
      ironBall: this.createFrame(texture, 72, 320, 72, 72),
      barrel: this.createFrame(texture, 152, 320, 48, 64),
      chainLink: this.createFrame(texture, 208, 320, 64, 64),
    };
    return this.frames;
  }

  private static createFrame(
    texture: Texture2D,
    x: number,
    y: number,
    width: number,
    height: number,
  ): SpriteFrame {
    const frame = new SpriteFrame();
    frame.texture = texture;
    frame.rect = new Rect(x, y, width, height);
    frame.originalSize = new Size(width, height);
    frame.packable = false;
    return frame;
  }

  private static drawArena(
    data: Uint8Array,
    stride: number,
    originX: number,
    originY: number,
    width: number,
    height: number,
  ): void {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let color: readonly number[] = [218, 205, 177, 255];
        const border = x < 17 || x >= width - 17 || y < 18 || y >= height - 18;
        if (border) color = [93, 71, 49, 255];
        else if ((x - 17) % 36 === 0 || (y - 18) % 32 === 0) color = [193, 178, 148, 255];
        this.setPixel(data, stride, originX + x, originY + y, color);
      }
    }
  }

  private static drawUnit(data: Uint8Array, stride: number, originX: number, originY: number, size: number): void {
    const center = size * 0.5;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
        if (distance > 27) continue;
        const color = distance >= 22 ? [24, 27, 30, 255]
          : y < 20 && x > 18 && x < 43 ? [255, 255, 255, 215]
            : [255, 255, 255, 255];
        this.setPixel(data, stride, originX + x, originY + y, color);
      }
    }
  }

  private static drawIronBall(data: Uint8Array, stride: number, originX: number, originY: number, size: number): void {
    const center = size * 0.5;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = x + 0.5 - center;
        const dy = y + 0.5 - center;
        const distance = Math.hypot(dx, dy);
        if (distance > 32) continue;
        let value = distance > 27 ? 17 : Math.round(74 - distance * 0.9);
        if (dx < -7 && dy < -8 && distance < 19) value += 35;
        this.setPixel(data, stride, originX + x, originY + y, [value, value + 1, value + 5, 255]);
      }
    }
  }

  private static drawBarrel(
    data: Uint8Array,
    stride: number,
    originX: number,
    originY: number,
    width: number,
    height: number,
  ): void {
    for (let y = 4; y < height - 4; y += 1) {
      for (let x = 7; x < width - 7; x += 1) {
        const edge = x < 11 || x >= width - 11 || y < 8 || y >= height - 8;
        const band = (y >= 18 && y <= 22) || (y >= 42 && y <= 46);
        const color = edge ? [62, 36, 25, 255]
          : band ? [208, 155, 74, 255]
            : [141, 58, 39, 255];
        this.setPixel(data, stride, originX + x, originY + y, color);
      }
    }
  }

  private static drawChainLink(data: Uint8Array, stride: number, originX: number, originY: number, size: number): void {
    const center = size * 0.5;
    const cosine = Math.cos(-0.66);
    const sine = Math.sin(-0.66);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = x + 0.5 - center;
        const dy = y + 0.5 - center;
        const localX = dx * cosine - dy * sine;
        const localY = dx * sine + dy * cosine;
        const segmentY = Math.max(-11, Math.min(11, localY));
        const capsuleDistance = Math.hypot(localX, localY - segmentY);
        if (capsuleDistance > 14 || capsuleDistance < 7) continue;
        const edge = capsuleDistance > 11.5 || capsuleDistance < 8.5;
        const color = edge ? [36, 34, 32, 255] : [196, 185, 165, 255];
        this.setPixel(data, stride, originX + x, originY + y, color);
      }
    }
  }

  private static setPixel(
    data: Uint8Array,
    width: number,
    x: number,
    y: number,
    color: readonly number[],
  ): void {
    const offset = (y * width + x) * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = color[3];
  }
}
