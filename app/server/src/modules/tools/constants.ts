/** Spread into every tab-scoped action's property bag. */
export const TAB_ID_PROPERTY = {
  tabId: {
    type: "number",
    description:
      "Target this specific tab (real tabId from session.navigate's response or session.list_tabs). Omit to use the currently active tab (recommended). Do not guess dummy IDs like 1.",
  },
} as const;

/** Shared by browser_act's run_flow and browser_knowledge's save_flow — a saved flow is the exact FlowStep[] shape run_flow runs. Each step's own `action` enum is nested inside the array, unrelated to (and not colliding with) a gateway's top-level `action`. */
export const FLOW_STEP_ITEM_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["click", "type", "press_key", "wait_for", "assert_text", "scroll", "drag"] },
    role: {
      type: "string",
      description: "Accessibility role of the target, from a prior inspect.snapshot (e.g. 'button', 'textbox').",
    },
    name: { type: "string", description: "Accessible name of the target, paired with role." },
    selector: { type: "string", description: "CSS selector, as an alternative to role+name." },
    text: { type: "string", description: "Text to type (action: 'type')." },
    key: {
      type: "string",
      description: "Key to press (action: 'press_key') — a named key or a single character, see act.press_key.",
    },
    contains: {
      type: "string",
      description: "Substring the target's accessible name must contain (action: 'assert_text').",
    },
    deltaX: { type: "number", description: "Scroll delta (action: 'scroll')." },
    deltaY: { type: "number", description: "Scroll delta (action: 'scroll')." },
    fromX: { type: "number", description: "Drag start x, viewport pixels (action: 'drag')." },
    fromY: { type: "number", description: "Drag start y, viewport pixels (action: 'drag')." },
    toX: { type: "number", description: "Drag end x, viewport pixels (action: 'drag')." },
    shape: {
      type: "string",
      enum: [
        "straight",
        "circle",
        "arc",
        "ellipse",
        "bezier",
        "sine",
        "zigzag",
        "spiral",
        "waypoints",
        "polygon",
        "star",
        "heart",
        "flower",
        "rectangle",
        "box",
        "parametric",
        "polar",
        "function",
      ],
      description: "Geometric or mathematical function trajectory shape (action: 'drag').",
    },
    shapeParams: {
      type: "object",
      description:
        "Parameters for shape drag: math formulas {fnX, fnY, fnR, tMin, tMax}, center {cx, cy}, radius {radius, radiusX, radiusY}, angles {startAngle, endAngle}, or presets {petals, numPoints, outerRadius, innerRadius, size, width, height}.",
    },
    path: {
      type: "array",
      description: "Array of [x, y] or {x, y} coordinate waypoints for path dragging (action: 'drag').",
    },
    stepsCount: { type: "number", description: "Number of intermediate interpolation steps for drag." },
    easing: {
      type: "string",
      enum: ["linear", "easeIn", "easeOut", "easeInOut"],
      description: "Easing function for drag movement.",
    },
    button: {
      type: "string",
      enum: ["left", "right", "middle"],
      description: "Mouse button for drag (default 'left').",
    },
    timeoutMs: {
      type: "number",
      description: "Max time in ms to poll for the target to appear (action: 'wait_for'), default 3000.",
    },
    confirmRisky: {
      type: "boolean",
      description:
        "Set true to proceed past a step whose target looks destructive/irreversible (delete, cancel, sign out, pay, confirm, ...) — only after confirming with your user that this step is intended.",
    },
    target: {
      type: "object",
      description: "Bounded durable target fingerprint; runtime eN refs are provenance only, never replay identity.",
      properties: {
        role: { type: "string", maxLength: 200 },
        name: { type: "string", maxLength: 200 },
        testId: { type: "string", maxLength: 200 },
        id: { type: "string", maxLength: 200 },
        href: { type: "string", maxLength: 200 },
        inputType: { type: "string", maxLength: 40 },
        inputName: { type: "string", maxLength: 200 },
        ancestors: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              role: { type: "string", maxLength: 80 },
              name: { type: "string", maxLength: 200 },
            },
          },
        },
        nearby: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              relation: { type: "string", enum: ["before", "after", "inside", "label"] },
              role: { type: "string", maxLength: 80 },
              name: { type: "string", maxLength: 200 },
            },
          },
        },
        selectorHints: { type: "array", maxItems: 3, items: { type: "string", maxLength: 200 } },
      },
    },
    expected: {
      type: "object",
      description: "Optional bounded postcondition checked after the step.",
      properties: {
        kind: { type: "string", enum: ["none", "navigation", "text", "state"] },
        urlPattern: { type: "string", maxLength: 500 },
        selector: { type: "string", maxLength: 300 },
        contains: { type: "string", maxLength: 200 },
        attribute: { type: "string", maxLength: 80 },
        value: { type: "string", maxLength: 200 },
      },
    },
    policy: {
      type: "object",
      properties: {
        timeoutMs: { type: "number", minimum: 100, maximum: 120000 },
        confirmRisky: { type: "boolean" },
        onDrift: { type: "string", enum: ["stop", "repair", "report"] },
      },
    },
  },
  required: ["action"],
} as const;
