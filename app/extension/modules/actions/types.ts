import type { Point, TrajectoryConfig } from "@browsercontrol/shared";

export type AxInfo = { role?: string; name?: string };
export type ActionResult =
    | {
          success: true;
          message: string;
          role?: string;
          name?: string;
          _riskWarning?: string;
      }
    | { error: string; hint?: string };

export interface DragOptions {
    fast: boolean;
    points?: Point[];
    shape?: TrajectoryConfig["shape"];
    shapeParams?: Record<string, unknown>;
    path?: Array<Point | [number, number]>;
    stepsCount?: number;
    easing?: TrajectoryConfig["easing"];
    button?: "left" | "right" | "middle";
    currentCursor?: Point;
}
