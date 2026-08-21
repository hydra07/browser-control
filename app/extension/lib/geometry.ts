// Mathematical Geometry & Trajectory Engine for complex mouse dragging and gestures.
// Supports straight lines, circles, arcs, ellipses, quadratic/cubic Bezier curves,
// sine waves, zigzags, Archimedean spirals, and smoothed multi-point waypoints.

export interface Point {
    x: number;
    y: number;
}

export type TrajectoryShape =
    | "straight"
    | "circle"
    | "arc"
    | "ellipse"
    | "bezier"
    | "sine"
    | "zigzag"
    | "spiral"
    | "waypoints"
    | "polygon"
    | "star"
    | "heart"
    | "flower"
    | "rectangle"
    | "box"
    | "parametric"
    | "polar"
    | "function";

export type EasingType = "linear" | "easeIn" | "easeOut" | "easeInOut";

export interface TrajectoryConfig {
    shape?: TrajectoryShape;
    fromX?: number;
    fromY?: number;
    toX?: number;
    toY?: number;
    start?: Point | [number, number];
    end?: Point | [number, number];
    // Mathematical Parametric & Polar Function formulas:
    // fnX: expression of 't', 'cx', 'cy', 'r', 'a', 'b', 'k' e.g. "cx + 120 * cos(t) * sin(3*t)"
    // fnY: expression of 't', 'cx', 'cy', 'r', 'a', 'b', 'k' e.g. "cy + 120 * sin(t) * sin(3*t)"
    // fnR: polar radius expression of 'theta' / 't' e.g. "100 * (1 + 0.5 * cos(5*theta))"
    fnX?: string;
    fnY?: string;
    fnR?: string;
    tMin?: number;
    tMax?: number;
    tRange?: [number, number];
    // Circle / Arc / Ellipse / Center-based parameters
    cx?: number;
    cy?: number;
    radius?: number;
    radiusX?: number;
    radiusY?: number;
    startAngle?: number; // radians or degrees (detected/supported)
    endAngle?: number;   // radians or degrees
    clockwise?: boolean;
    // Bezier control points (absolute or relative)
    control1?: Point | [number, number] | { dx: number; dy: number };
    control2?: Point | [number, number] | { dx: number; dy: number };
    // Wave / Sine / Zigzag parameters
    amplitude?: number;
    frequency?: number; // number of full wave cycles along the path
    // Spiral parameters
    startRadius?: number;
    endRadius?: number;
    rotations?: number;
    // Preset shape parameters
    petals?: number;     // for flower / rose (e.g. 5, 6, 8)
    numPoints?: number;  // for star / polygon (e.g. 5 for 5-pointed star)
    outerRadius?: number;// for star
    innerRadius?: number;// for star
    size?: number;       // for heart / symbol
    width?: number;      // for rectangle / box
    height?: number;     // for rectangle / box
    // Waypoints / Multi-point paths
    points?: Array<Point | [number, number]>;
    closed?: boolean;
    // General path execution options
    steps?: number;
    easing?: EasingType;
    smoothing?: boolean;
}

// Convert degrees to radians if angle is given in degrees (> 2 * PI)
function normalizeAngle(angle: number | undefined, defaultVal: number): number {
    if (angle === undefined) return defaultVal;
    // If angle magnitude is > 2*PI (~6.28), assume user passed degrees
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

// Easing functions mapping t in [0, 1] to eased value in [0, 1]
export function applyEasing(t: number, easing: EasingType = "linear"): number {
    const clamped = Math.max(0, Math.min(1, t));
    switch (easing) {
        case "easeIn":
            return clamped * clamped;
        case "easeOut":
            return clamped * (2 - clamped);
        case "easeInOut":
            return clamped < 0.5
                ? 2 * clamped * clamped
                : -1 + (4 - 2 * clamped) * clamped;
        case "linear":
        default:
            return clamped;
    }
}

/** Distance between two 2D points */
export function distance(p1: Point, p2: Point): number {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/** Estimate adaptive steps based on total path length (approx 1 step per 15-25px) */
export function estimateAdaptiveSteps(approxLength: number, minSteps = 8, maxSteps = 120): number {
    const calculated = Math.round(approxLength / 20);
    return Math.max(minSteps, Math.min(maxSteps, calculated));
}

// ============================================================================
// Shape Generators
// ============================================================================

/** Generate straight line points from P0 to P1 */
export function generateStraightPath(
    from: Point,
    to: Point,
    steps?: number,
    easing: EasingType = "linear",
): Point[] {
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
    let startAng = normalizeAngle(cfg.startAngle, 0);
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

    // Support relative control point offsets { dx, dy } or absolute points
    let p1: Point;
    if (cfg.control1 && typeof cfg.control1 === "object" && "dx" in cfg.control1) {
        p1 = { x: p0.x + (cfg.control1 as { dx: number; dy: number }).dx, y: p0.y + (cfg.control1 as { dx: number; dy: number }).dy };
    } else {
        p1 = parsePoint(cfg.control1 as Point | [number, number] | undefined, { x: p0.x + (p3.x - p0.x) * 0.35, y: p0.y - 120 });
    }

    const isCubic = cfg.control2 !== undefined;
    let p2: Point;
    if (cfg.control2 && typeof cfg.control2 === "object" && "dx" in cfg.control2) {
        p2 = { x: p3.x + (cfg.control2 as { dx: number; dy: number }).dx, y: p3.y + (cfg.control2 as { dx: number; dy: number }).dy };
    } else if (isCubic) {
        p2 = parsePoint(cfg.control2 as Point | [number, number] | undefined, { x: p0.x + (p3.x - p0.x) * 0.65, y: p3.y + 120 });
    } else {
        p2 = p1;
    }

    // Approximate length by chord + control polygon
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
            // Cubic: B(t) = (1-t)^3 * P0 + 3(1-t)^2*t * P1 + 3(1-t)*t^2 * P2 + t^3 * P3
            x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x;
            y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y;
        } else {
            // Quadratic: B(t) = (1-t)^2 * P0 + 2(1-t)t * P1 + t^2 * P3
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
    const startAng = normalizeAngle(cfg.startAngle, -Math.PI / 2); // Start at top by default

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
        smoothing: false, // sharp star points
    });
}

/** Generate Heart (cardioid) trajectory */
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

/** Generate Flower / Lotus (Rhodonea rose curve) trajectory */
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
    const to = { x: cfg.toX ?? (from.x + 500), y: cfg.toY ?? from.y };
    const amp = cfg.amplitude ?? 40;
    const freq = cfg.frequency ?? 3; // 3 full cycles by default
    const isZigzag = cfg.shape === "zigzag";

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;

    // Normal unit vector (perpendicular to direction)
    const nx = -dy / length;
    const ny = dx / length;

    const n = cfg.steps ?? estimateAdaptiveSteps(length, 24, 100);
    const points: Point[] = [];

    for (let i = 0; i <= n; i++) {
        const rawT = i / n;
        const t = applyEasing(rawT, cfg.easing ?? "linear");

        // Base linear position along main axis
        const baseX = from.x + dx * t;
        const baseY = from.y + dy * t;

        // Wave displacement offset
        let waveOffset: number;
        if (isZigzag) {
            // Triangle wave in [-1, 1]
            const phase = (t * freq) % 1;
            waveOffset = (phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase) * amp;
        } else {
            // Smooth sine wave
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

/** Catmull-Rom Spline interpolation for smoothed multi-waypoint paths */
function catmullRom(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
    const t2 = t * t;
    const t3 = t2 * t;

    const x = 0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
    );

    const y = 0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
    );

    return { x: Math.round(x), y: Math.round(y) };
}

/** Generate path from arbitrary waypoints (with optional Catmull-Rom smoothing) */
export function generateWaypointsPath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
    const rawPoints = (cfg.points ?? []).map((p) => parsePoint(p, { x: 0, y: 0 }));
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
    if (rawPoints.length === 1) return [rawPoints[0]];

    const pts = [...rawPoints];
    if (cfg.closed && (pts[0].x !== pts[pts.length - 1].x || pts[0].y !== pts[pts.length - 1].y)) {
        pts.push({ ...pts[0] });
    }

    if (!cfg.smoothing) {
        // Multi-segment linear path
        const result: Point[] = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
            const seg = generateStraightPath(pts[i], pts[i + 1], Math.max(3, Math.round((cfg.steps ?? 30) / (pts.length - 1))));
            result.push(...seg.slice(1));
        }
        return result;
    }

    // Smooth with Catmull-Rom Spline
    const result: Point[] = [];
    const extended = [pts[0], ...pts, pts[pts.length - 1]];
    const stepsPerSegment = Math.max(4, Math.round((cfg.steps ?? 40) / (pts.length - 1)));

    for (let i = 1; i < extended.length - 2; i++) {
        const p0 = extended[i - 1];
        const p1 = extended[i];
        const p2 = extended[i + 1];
        const p3 = extended[i + 2];

        for (let s = (i === 1 ? 0 : 1); s <= stepsPerSegment; s++) {
            const t = s / stepsPerSegment;
            result.push(catmullRom(p0, p1, p2, p3, t));
        }
    }

    return result;
}

// ============================================================================
// Mathematical Function & Parametric Trajectory Compiler
// ============================================================================

/** Safely compile a mathematical expression string into a callable function */
export function compileMathExpr(expr: string): (vars: Record<string, number>) => number {
    if (!expr || typeof expr !== "string") return () => 0;

    // Sanitize: replace math constants and functions with Math.* equivalents
    let sanitized = expr
        .replace(/\bPI\b/gi, "Math.PI")
        .replace(/\bE\b/g, "Math.E")
        .replace(/\b(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|sqrt|cbrt|pow|abs|exp|log|log2|log10|min|max|round|floor|ceil|sign)\b/gi, "Math.$1")
        .replace(/\^/g, "**");

    // Whitelist allowed characters: digits, identifiers, math symbols, whitespace
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

/** Generate arbitrary Parametric trajectory x(t), y(t) from math equations */
export function generateParametricPath(cfg: TrajectoryConfig, fallbackCenter?: Point): Point[] {
    const cx = cfg.cx ?? cfg.fromX ?? fallbackCenter?.x ?? 400;
    const cy = cfg.cy ?? cfg.fromY ?? fallbackCenter?.y ?? 300;
    const tMin = cfg.tMin ?? cfg.tRange?.[0] ?? 0;
    const tMax = cfg.tMax ?? cfg.tRange?.[1] ?? (Math.PI * 2);
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

/** Generate arbitrary Polar trajectory r(theta) from math equation */
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

/** Master Trajectory Compiler: Takes any TrajectoryConfig and generates sequence of points */
export function compileTrajectory(cfg: TrajectoryConfig, currentCursor?: Point): Point[] {
    // 1. If explicit mathematical equations (fnX/fnY or fnR) are passed, compile function path directly
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

        case "straight":
        default: {
            const from = { x: cfg.fromX ?? currentCursor?.x ?? 0, y: cfg.fromY ?? currentCursor?.y ?? 0 };
            const to = { x: cfg.toX ?? from.x, y: cfg.toY ?? from.y };
            return generateStraightPath(from, to, cfg.steps, cfg.easing);
        }
    }
}
