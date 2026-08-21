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
    endAngle?: number; // radians or degrees
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
    petals?: number; // for flower / rose (e.g. 5, 6, 8)
    numPoints?: number; // for star / polygon (e.g. 5 for 5-pointed star)
    outerRadius?: number; // for star
    innerRadius?: number; // for star
    size?: number; // for heart / symbol
    width?: number; // for rectangle / box
    height?: number; // for rectangle / box
    // Waypoints / Multi-point paths
    points?: Array<Point | [number, number]>;
    closed?: boolean;
    // General path execution options
    steps?: number;
    easing?: EasingType;
    smoothing?: boolean;
}
