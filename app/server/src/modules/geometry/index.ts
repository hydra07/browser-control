/**
 * Server-side mathematical geometry and trajectory calculation engine for drag actions.
 * Supports lines, circles, arcs, ellipses, Bezier curves, spirals, waves, and math equations.
 */
import type { EasingType, Point, TrajectoryConfig } from "./types.js";

export type { EasingType, Point, TrajectoryConfig, TrajectoryShape } from "./types.js";

function normalizeAngle(angle: number | undefined, defaultVal: number): number {
  if (angle === undefined) return defaultVal;
  if (Math.abs(angle) > Math.PI * 2) {
    return (angle * Math.PI) / 180;
  }
  return angle;
}

function parsePoint(p: Point | [number, number] | undefined, defaultPoint: Point): Point {
  if (!p) return defaultPoint;
  if (Array.isArray(p)) return { x: p[0], y: p[1] };
  return { x: p.x, y: p.y };
}

/** Easing functions mapping t in [0, 1] to eased value in [0, 1]. */
export function applyEasing(t: number, easing: EasingType = "linear"): number {
  const clamped = Math.max(0, Math.min(1, t));
  switch (easing) {
    case "easeIn":
      return clamped * clamped;
    case "easeOut":
      return clamped * (2 - clamped);
    case "easeInOut":
      return clamped < 0.5 ? 2 * clamped * clamped : -1 + (4 - 2 * clamped) * clamped;
    default:
      return clamped;
  }
}

/** Distance between two 2D points. */
export function distance(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Estimate adaptive steps based on total path length. */
export function estimateAdaptiveSteps(approxLength: number, minSteps = 8, maxSteps = 120): number {
  const calculated = Math.round(approxLength / 20);
  return Math.max(minSteps, Math.min(maxSteps, calculated));
}

/** Generate straight line points from P0 to P1 */
export function generateStraightPath(from: Point, to: Point, steps?: number, easing: EasingType = "linear"): Point[] {
  const len = distance(from, to);
  const n = steps ?? estimateAdaptiveSteps(len, 6, 40);
  const points: Point[] = [];

  for (let i = 0; i <= n; i++) {
    const rawT = i / n;
    const t = applyEasing(rawT, easing);
    points.push({
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
    });
  }
  return points;
}

/** Generate circular, elliptical, or arc trajectory */
export function generateCirclePath(cfg: TrajectoryConfig): Point[] {
  const cx = cfg.cx ?? cfg.fromX ?? 400;
  const cy = cfg.cy ?? cfg.fromY ?? 300;
  const rx = cfg.radiusX ?? cfg.radius ?? 100;
  const ry = cfg.radiusY ?? cfg.radius ?? rx;

  const clockwise = cfg.clockwise !== false;
  const startAng = normalizeAngle(cfg.startAngle, 0);
  let endAng = normalizeAngle(cfg.endAngle, clockwise ? startAng + Math.PI * 2 : startAng - Math.PI * 2);

  if (clockwise && endAng <= startAng) {
    endAng += Math.PI * 2;
  } else if (!clockwise && endAng >= startAng) {
    endAng -= Math.PI * 2;
  }

  const arcAngle = Math.abs(endAng - startAng);
  const approxLength = ((rx + ry) / 2) * arcAngle;
  const n = cfg.steps ?? estimateAdaptiveSteps(approxLength, 12, 90);
  const points: Point[] = [];

  for (let i = 0; i <= n; i++) {
    const rawT = i / n;
    const t = applyEasing(rawT, cfg.easing ?? "linear");
    const angle = startAng + (endAng - startAng) * t;
    points.push({
      x: Math.round(cx + rx * Math.cos(angle)),
      y: Math.round(cy + ry * Math.sin(angle)),
    });
  }
  return points;
}

/** Generate Quadratic or Cubic Bezier curve trajectory */
export function generateBezierPath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
  const rawFrom = cfg.start ?? (cfg.fromX != null && cfg.fromY != null ? { x: cfg.fromX, y: cfg.fromY } : undefined);
  const p0 = parsePoint(rawFrom, fallbackCenter ?? { x: 200, y: 200 });

  const rawTo = cfg.end ?? (cfg.toX != null && cfg.toY != null ? { x: cfg.toX, y: cfg.toY } : undefined);
  const p3 = parsePoint(rawTo, { x: p0.x + 300, y: p0.y + 150 });

  let p1: Point;
  if (cfg.control1 && typeof cfg.control1 === "object" && "dx" in cfg.control1) {
    p1 = {
      x: p0.x + (cfg.control1 as { dx: number; dy: number }).dx,
      y: p0.y + (cfg.control1 as { dx: number; dy: number }).dy,
    };
  } else {
    p1 = parsePoint(cfg.control1 as Point | [number, number] | undefined, {
      x: p0.x + (p3.x - p0.x) * 0.35,
      y: p0.y - 120,
    });
  }

  const isCubic = cfg.control2 !== undefined;
  let p2: Point;
  if (cfg.control2 && typeof cfg.control2 === "object" && "dx" in cfg.control2) {
    p2 = {
      x: p3.x + (cfg.control2 as { dx: number; dy: number }).dx,
      y: p3.y + (cfg.control2 as { dx: number; dy: number }).dy,
    };
  } else if (isCubic) {
    p2 = parsePoint(cfg.control2 as Point | [number, number] | undefined, {
      x: p0.x + (p3.x - p0.x) * 0.65,
      y: p3.y + 120,
    });
  } else {
    p2 = p1;
  }

  const approxLength = distance(p0, p1) + distance(p1, p2) + distance(p2, p3);
  const n = cfg.steps ?? estimateAdaptiveSteps(approxLength, 12, 60);
  const points: Point[] = [];

  for (let i = 0; i <= n; i++) {
    const rawT = i / n;
    const t = applyEasing(rawT, cfg.easing ?? "linear");
    const u = 1 - t;

    let x: number;
    let y: number;

    if (isCubic) {
      x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x;
      y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y;
    } else {
      x = u * u * p0.x + 2 * u * t * p1.x + t * t * p3.x;
      y = u * u * p0.y + 2 * u * t * p1.y + t * t * p3.y;
    }

    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}

/** Generate Star trajectory */
export function generateStarPath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
  const cx = cfg.cx ?? cfg.fromX ?? fallbackCenter?.x ?? 400;
  const cy = cfg.cy ?? cfg.fromY ?? fallbackCenter?.y ?? 300;
  const rOuter = cfg.outerRadius ?? cfg.radius ?? 100;
  const rInner = cfg.innerRadius ?? rOuter * 0.45;
  const numPoints = cfg.numPoints ?? 5;
  const totalVertices = numPoints * 2;

  const waypoints: Point[] = [];
  const startAng = normalizeAngle(cfg.startAngle, -Math.PI / 2);

  for (let i = 0; i <= totalVertices; i++) {
    const angle = startAng + (i * Math.PI) / numPoints;
    const r = i % 2 === 0 ? rOuter : rInner;
    waypoints.push({
      x: Math.round(cx + r * Math.cos(angle)),
      y: Math.round(cy + r * Math.sin(angle)),
    });
  }

  return generateWaypointsPath({
    ...cfg,
    points: waypoints,
    closed: true,
    smoothing: false,
  });
}

/** Generate Heart trajectory */
export function generateHeartPath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
  const cx = cfg.cx ?? cfg.fromX ?? fallbackCenter?.x ?? 400;
  const cy = cfg.cy ?? cfg.fromY ?? fallbackCenter?.y ?? 300;
  const size = cfg.size ?? cfg.radius ?? 80;
  const n = cfg.steps ?? 60;
  const points: Point[] = [];

  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const sinT = Math.sin(t);
    const xVal = 16 * sinT * sinT * sinT;
    const yVal = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));

    points.push({
      x: Math.round(cx + (xVal * size) / 16),
      y: Math.round(cy + (yVal * size) / 16),
    });
  }

  return points;
}

/** Generate Flower / Lotus trajectory */
export function generateFlowerPath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
  const cx = cfg.cx ?? cfg.fromX ?? fallbackCenter?.x ?? 400;
  const cy = cfg.cy ?? cfg.fromY ?? fallbackCenter?.y ?? 300;
  const maxR = cfg.radius ?? 100;
  const petals = cfg.petals ?? 6;
  const n = cfg.steps ?? Math.max(40, petals * 12);
  const points: Point[] = [];

  for (let i = 0; i <= n; i++) {
    const theta = (i / n) * Math.PI * 2;
    const r = maxR * (0.35 + 0.65 * Math.abs(Math.sin((petals / 2) * theta)));

    points.push({
      x: Math.round(cx + r * Math.cos(theta)),
      y: Math.round(cy + r * Math.sin(theta)),
    });
  }

  return points;
}

/** Generate Rectangle / Box trajectory */
export function generateRectanglePath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
  let p1: Point;
  let p3: Point;

  if (cfg.fromX != null && cfg.fromY != null && cfg.toX != null && cfg.toY != null) {
    p1 = { x: cfg.fromX, y: cfg.fromY };
    p3 = { x: cfg.toX, y: cfg.toY };
  } else {
    const cx = cfg.cx ?? cfg.fromX ?? fallbackCenter?.x ?? 400;
    const cy = cfg.cy ?? cfg.fromY ?? fallbackCenter?.y ?? 300;
    const w = cfg.width ?? 200;
    const h = cfg.height ?? 150;
    p1 = { x: cx - w / 2, y: cy - h / 2 };
    p3 = { x: cx + w / 2, y: cy + h / 2 };
  }

  const p2 = { x: p3.x, y: p1.y };
  const p4 = { x: p1.x, y: p3.y };

  return generateWaypointsPath({
    ...cfg,
    points: [p1, p2, p3, p4, p1],
    closed: true,
    smoothing: false,
  });
}

/** Generate Sine Wave or Zigzag trajectory along a directed vector */
export function generateWavePath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
  const from = { x: cfg.fromX ?? fallbackCenter?.x ?? 100, y: cfg.fromY ?? fallbackCenter?.y ?? 300 };
  const to = { x: cfg.toX ?? from.x + 500, y: cfg.toY ?? from.y };
  const amp = cfg.amplitude ?? 40;
  const freq = cfg.frequency ?? 3;
  const isZigzag = cfg.shape === "zigzag";

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;

  const nx = -dy / length;
  const ny = dx / length;

  const n = cfg.steps ?? estimateAdaptiveSteps(length, 24, 100);
  const points: Point[] = [];

  for (let i = 0; i <= n; i++) {
    const rawT = i / n;
    const t = applyEasing(rawT, cfg.easing ?? "linear");

    const baseX = from.x + dx * t;
    const baseY = from.y + dy * t;

    let waveOffset: number;
    if (isZigzag) {
      const phase = (t * freq) % 1;
      waveOffset = (phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase) * amp;
    } else {
      waveOffset = Math.sin(t * freq * Math.PI * 2) * amp;
    }

    points.push({
      x: Math.round(baseX + nx * waveOffset),
      y: Math.round(baseY + ny * waveOffset),
    });
  }
  return points;
}

/** Generate Archimedean Spiral trajectory */
export function generateSpiralPath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
  const cx = cfg.cx ?? cfg.fromX ?? fallbackCenter?.x ?? 400;
  const cy = cfg.cy ?? cfg.fromY ?? fallbackCenter?.y ?? 300;
  const rStart = cfg.startRadius ?? 10;
  const rEnd = cfg.endRadius ?? cfg.radius ?? 150;
  const rotations = cfg.rotations ?? 2.5;
  const clockwise = cfg.clockwise !== false;
  const startAng = normalizeAngle(cfg.startAngle, 0);

  const totalAngle = rotations * Math.PI * 2 * (clockwise ? 1 : -1);
  const approxLength = ((rStart + rEnd) / 2) * Math.abs(totalAngle);
  const n = cfg.steps ?? estimateAdaptiveSteps(approxLength, 30, 120);
  const points: Point[] = [];

  for (let i = 0; i <= n; i++) {
    const rawT = i / n;
    const t = applyEasing(rawT, cfg.easing ?? "linear");

    const r = rStart + (rEnd - rStart) * t;
    const angle = startAng + totalAngle * t;

    points.push({
      x: Math.round(cx + r * Math.cos(angle)),
      y: Math.round(cy + r * Math.sin(angle)),
    });
  }
  return points;
}

function catmullRom(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const t2 = t * t;
  const t3 = t2 * t;

  const x =
    0.5 *
    (2 * p1.x +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);

  const y =
    0.5 *
    (2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

  return { x: Math.round(x), y: Math.round(y) };
}

/** Generate path from arbitrary waypoints (with optional Catmull-Rom smoothing) */
export function generateWaypointsPath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
  const rawPoints = (cfg.points ?? []).map((p: Point | [number, number]) => parsePoint(p, { x: 0, y: 0 }));
  if (rawPoints.length === 0) {
    if (cfg.fromX !== undefined || cfg.toX !== undefined) {
      return generateStraightPath(
        { x: cfg.fromX ?? fallbackCenter?.x ?? 100, y: cfg.fromY ?? fallbackCenter?.y ?? 100 },
        { x: cfg.toX ?? 500, y: cfg.toY ?? 500 },
        cfg.steps,
        cfg.easing,
      );
    }
    return [];
  }
  const firstPoint = rawPoints[0];
  if (!firstPoint) return [];
  if (rawPoints.length === 1) return [firstPoint];

  const pts: Point[] = [...rawPoints];
  const lastPoint = pts[pts.length - 1];
  if (cfg.closed && lastPoint && (firstPoint.x !== lastPoint.x || firstPoint.y !== lastPoint.y)) {
    pts.push({ x: firstPoint.x, y: firstPoint.y });
  }

  if (!cfg.smoothing) {
    const result: Point[] = [firstPoint];
    for (let i = 0; i < pts.length - 1; i++) {
      const curr = pts[i];
      const next = pts[i + 1];
      if (!curr || !next) continue;
      const seg = generateStraightPath(curr, next, Math.max(3, Math.round((cfg.steps ?? 30) / (pts.length - 1))));
      result.push(...seg.slice(1));
    }
    return result;
  }

  const result: Point[] = [];
  const endPoint = pts[pts.length - 1] ?? firstPoint;
  const extended: Point[] = [firstPoint, ...pts, endPoint];
  const stepsPerSegment = Math.max(4, Math.round((cfg.steps ?? 40) / (pts.length - 1)));

  for (let i = 1; i < extended.length - 2; i++) {
    const p0 = extended[i - 1];
    const p1 = extended[i];
    const p2 = extended[i + 1];
    const p3 = extended[i + 2];
    if (!p0 || !p1 || !p2 || !p3) continue;

    for (let s = i === 1 ? 0 : 1; s <= stepsPerSegment; s++) {
      const t = s / stepsPerSegment;
      result.push(catmullRom(p0, p1, p2, p3, t));
    }
  }

  return result;
}

export function compileMathExpr(expr: string): (vars: Record<string, number>) => number {
  if (!expr || typeof expr !== "string") return () => 0;

  const sanitized = expr
    .replace(/\bPI\b/gi, "Math.PI")
    .replace(/\bE\b/g, "Math.E")
    .replace(
      /\b(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|sqrt|cbrt|pow|abs|exp|log|log2|log10|min|max|round|floor|ceil|sign)\b/gi,
      "Math.$1",
    )
    .replace(/\^/g, "**");

  if (!/^[\d\s+\-*/%(),.Matha-zA-Z_]+$/.test(sanitized)) {
    throw new Error(`Invalid characters in mathematical expression: "${expr}"`);
  }

  try {
    const fn = new Function(
      "vars",
      `
      with (Math) {
        const { t = 0, theta = 0, cx = 0, cy = 0, x = 0, y = 0, r = 0, a = 0, b = 0, k = 0, w = 0, h = 0, size = 0 } = vars || {};
        return ${sanitized};
      }
      `,
    ) as (vars: Record<string, number>) => number;

    return (vars) => {
      try {
        const val = Number(fn(vars));
        return Number.isFinite(val) ? val : 0;
      } catch {
        return 0;
      }
    };
  } catch {
    return () => 0;
  }
}

export function generateParametricPath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
  const cx = cfg.cx ?? cfg.fromX ?? fallbackCenter?.x ?? 400;
  const cy = cfg.cy ?? cfg.fromY ?? fallbackCenter?.y ?? 300;
  const tMin = cfg.tMin ?? cfg.tRange?.[0] ?? 0;
  const tMax = cfg.tMax ?? cfg.tRange?.[1] ?? Math.PI * 2;
  const n = cfg.steps ?? 60;

  const fnX = typeof cfg.fnX === "string" ? compileMathExpr(cfg.fnX) : undefined;
  const fnY = typeof cfg.fnY === "string" ? compileMathExpr(cfg.fnY) : undefined;

  if (!fnX && !fnY) return [];

  const points: Point[] = [];
  const contextVars: Record<string, number> = {
    cx,
    cy,
    r: cfg.radius ?? 100,
    a: cfg.radiusX ?? cfg.width ?? 100,
    b: cfg.radiusY ?? cfg.height ?? 100,
    k: cfg.frequency ?? cfg.petals ?? 1,
    size: cfg.size ?? 100,
  };

  for (let i = 0; i <= n; i++) {
    const rawT = i / n;
    const easedT = applyEasing(rawT, cfg.easing ?? "linear");
    const t = tMin + (tMax - tMin) * easedT;

    const xVal = fnX ? fnX({ ...contextVars, t }) : cx;
    const yVal = fnY ? fnY({ ...contextVars, t }) : cy;

    points.push({
      x: Math.round(xVal),
      y: Math.round(yVal),
    });
  }

  return points;
}

export function generatePolarPath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
  const cx = cfg.cx ?? cfg.fromX ?? fallbackCenter?.x ?? 400;
  const cy = cfg.cy ?? cfg.fromY ?? fallbackCenter?.y ?? 300;
  const clockwise = cfg.clockwise !== false;
  const startAng = normalizeAngle(cfg.startAngle ?? cfg.tMin, 0);
  const endAng = normalizeAngle(cfg.endAngle ?? cfg.tMax, clockwise ? startAng + Math.PI * 2 : startAng - Math.PI * 2);

  const fnR = typeof cfg.fnR === "string" ? compileMathExpr(cfg.fnR) : undefined;
  if (!fnR) return [];

  const n = cfg.steps ?? 60;
  const points: Point[] = [];
  const contextVars: Record<string, number> = {
    cx,
    cy,
    r: cfg.radius ?? 100,
    k: cfg.frequency ?? cfg.petals ?? 1,
  };

  for (let i = 0; i <= n; i++) {
    const rawT = i / n;
    const easedT = applyEasing(rawT, cfg.easing ?? "linear");
    const theta = startAng + (endAng - startAng) * easedT;

    const rVal = fnR({ ...contextVars, theta, t: rawT });

    points.push({
      x: Math.round(cx + rVal * Math.cos(theta)),
      y: Math.round(cy + rVal * Math.sin(theta)),
    });
  }

  return points;
}

/** Master Trajectory Compiler on Server: Generates Point[] coordinates */
export function compileTrajectory(cfg: TrajectoryConfig, currentCursor?: Point): Point[] {
  if (cfg.fnX !== undefined || cfg.fnY !== undefined) {
    return generateParametricPath(cfg, currentCursor);
  }
  if (cfg.fnR !== undefined) {
    return generatePolarPath(cfg, currentCursor);
  }

  const shape = cfg.shape ?? (cfg.points ? "waypoints" : "straight");

  switch (shape) {
    case "parametric":
    case "function":
      return generateParametricPath(cfg, currentCursor);

    case "polar":
      return generatePolarPath(cfg, currentCursor);

    case "circle":
    case "arc":
    case "ellipse":
      return generateCirclePath(cfg);

    case "bezier":
      return generateBezierPath(cfg, currentCursor);

    case "star":
      return generateStarPath(cfg, currentCursor);

    case "heart":
      return generateHeartPath(cfg, currentCursor);

    case "flower":
      return generateFlowerPath(cfg, currentCursor);

    case "rectangle":
    case "box":
      return generateRectanglePath(cfg, currentCursor);

    case "sine":
    case "zigzag":
      return generateWavePath(cfg, currentCursor);

    case "spiral":
      return generateSpiralPath(cfg, currentCursor);

    case "waypoints":
    case "polygon":
      return generateWaypointsPath(cfg, currentCursor);
    default: {
      const from = { x: cfg.fromX ?? currentCursor?.x ?? 0, y: cfg.fromY ?? currentCursor?.y ?? 0 };
      const to = { x: cfg.toX ?? from.x, y: cfg.toY ?? from.y };
      return generateStraightPath(from, to, cfg.steps, cfg.easing);
    }
  }
}
