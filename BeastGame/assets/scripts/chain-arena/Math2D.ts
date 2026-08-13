export interface Point2D {
  x: number;
  y: number;
}

export const Math2D = {
  clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  },

  normalize(x: number, y: number, output: Point2D = { x: 0, y: 0 }): Point2D {
    const length = Math.hypot(x, y);
    output.x = length > 0.0001 ? x / length : 0;
    output.y = length > 0.0001 ? y / length : 0;
    return output;
  },

  dot(ax: number, ay: number, bx: number, by: number): number {
    return ax * bx + ay * by;
  },

  overlaps(a: { x: number; y: number; radius: number }, b: { x: number; y: number; radius: number }): boolean {
    return Math.hypot(a.x - b.x, a.y - b.y) <= a.radius + b.radius;
  },
};
