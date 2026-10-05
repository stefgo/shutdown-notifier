import { describe, expect, it } from "vitest";
import { parseShutdownState, readShutdownState, sameSchedule } from "./shutdownState.js";

const FILE = "USEC=1759696200000000\nWARN_WALL=1\nMODE=poweroff\nWALL_MESSAGE=Back at 9 = sharp\n";

describe("parseShutdownState", () => {
    it("reads the time, the mode and the wall message", () => {
        expect(parseShutdownState(FILE)).toEqual({
            scheduledAt: new Date(1759696200000),
            mode: "poweroff",
            // Cut at the first "=" only.
            wallMessage: "Back at 9 = sharp",
        });
    });

    it("is no schedule for an empty file", () => {
        expect(parseShutdownState("")).toEqual({ scheduledAt: null, mode: null, wallMessage: null });
    });

    it("has no time where USEC is none", () => {
        expect(parseShutdownState("USEC=soon\nMODE=reboot").scheduledAt).toBeNull();
        expect(parseShutdownState("USEC=\nMODE=reboot").scheduledAt).toBeNull();
    });

    it("takes the keys in any case", () => {
        expect(parseShutdownState("mode=halt").mode).toBe("halt");
    });
});

describe("readShutdownState", () => {
    it("is no schedule for a file that is not there", () => {
        expect(readShutdownState("/nonexistent/scheduled")).toEqual({
            scheduledAt: null,
            mode: null,
            wallMessage: null,
        });
    });
});

describe("sameSchedule", () => {
    const at = (ms: number, mode: string | null = "poweroff") => ({
        scheduledAt: new Date(ms),
        mode,
        wallMessage: null,
    });

    it("compares the time and the mode", () => {
        expect(sameSchedule(at(1000), at(1000))).toBe(true);
        expect(sameSchedule(at(1000), at(2000))).toBe(false);
        expect(sameSchedule(at(1000), at(1000, "reboot"))).toBe(false);
    });

    it("does not mind the wall message", () => {
        expect(sameSchedule(at(1000), { ...at(1000), wallMessage: "x" })).toBe(true);
    });
});
