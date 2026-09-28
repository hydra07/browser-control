import { describe, expect, test } from "bun:test";
import type { FlowStep } from "./protocol.js";
import {
    BINARY_HEADER_SIZE,
    BinaryOpcode,
    decodeBinaryPacket,
    encodeBinaryPacket,
    migrateFlowDocument,
    migrateFlowStep,
    normalizeFlowStep,
} from "./protocol.js";

describe("binary protocol", () => {
    test("round-trips a framed payload", () => {
        const payload = new Uint8Array([1, 2, 3, 255]);
        const packet = encodeBinaryPacket(BinaryOpcode.VIDEO_CHUNK, payload, 4);
        const decoded = decodeBinaryPacket(packet);

        expect(decoded).toEqual({
            opcode: BinaryOpcode.VIDEO_CHUNK,
            flags: 4,
            length: payload.byteLength,
            payload,
        });
    });

    test("rejects unknown opcodes and inconsistent declared lengths", () => {
        const unknown = new Uint8Array(BINARY_HEADER_SIZE);
        unknown.set([0xbc, 0x01, 0xff]);
        expect(decodeBinaryPacket(unknown)).toBeNull();

        const truncated = encodeBinaryPacket(BinaryOpcode.VIDEO_CHUNK, new Uint8Array([1, 2]));
        new DataView(truncated.buffer).setUint32(4, 100, true);
        expect(decodeBinaryPacket(truncated)).toBeNull();
    });

    test("rejects packets shorter than the header", () => {
        expect(decodeBinaryPacket(new Uint8Array(BINARY_HEADER_SIZE - 1))).toBeNull();
    });

    test("migrates legacy flow locators into bounded descriptors", () => {
        const legacy: FlowStep = {
            action: "click",
            role: "button",
            name: "Save",
            selector: "#save",
            confirmRisky: true,
        };

        const migrated = migrateFlowStep(legacy);
        expect(migrated.target).toEqual({
            role: "button",
            name: "Save",
            selectorHints: ["#save"],
        });
        expect(migrated.target?.recordedRuntimeRef).toBeUndefined();

        const runtimeStep = normalizeFlowStep({
            action: "click",
            target: { role: "button", name: "Save", selectorHints: ["#save"] },
        });
        expect(runtimeStep.role).toBe("button");
        expect(runtimeStep.name).toBe("Save");
        expect(runtimeStep.selector).toBe("#save");
    });

    test("normalizes descriptor text before applying its bound", () => {
        const migrated = migrateFlowStep({
            action: "click",
            role: "button\n  primary",
            name: "  Save\t changes  ",
        });

        expect(migrated.target).toEqual({ role: "button primary", name: "Save changes" });
    });

    test("wraps v1 flow documents without rewriting them implicitly", () => {
        const document = migrateFlowDocument({
            schemaVersion: 1,
            name: "Checkout",
            steps: [{ action: "click", role: "button", name: "Continue" }],
        });

        expect(document.schemaVersion).toBe(2);
        expect(document.steps[0]?.target).toEqual({ role: "button", name: "Continue" });
    });
});
