import { describe, expect, it } from "vitest";
import { ClmCompactionEngine, resolveClmConfig } from "../src/index.js";

describe("resolveClmConfig", () => {
  it("applies the Stage-1 defaults", () => {
    expect(resolveClmConfig({})).toEqual({
      maxWaitSteps: 3,
      overflowMaxWaitSteps: 1,
      targetReductionRatio: 0.5,
      fallback: "basic",
      manual: "basic",
    });
  });

  it("accepts a full explicit config", () => {
    expect(resolveClmConfig({
      maxWaitSteps: 5,
      overflowMaxWaitSteps: 2,
      targetReductionRatio: 0.4,
      fallback: "off",
      manual: "reject",
    })).toEqual({
      maxWaitSteps: 5,
      overflowMaxWaitSteps: 2,
      targetReductionRatio: 0.4,
      fallback: "off",
      manual: "reject",
    });
  });

  it("rejects non-positive step budgets", () => {
    expect(() => resolveClmConfig({ maxWaitSteps: 0 })).toThrow(/maxWaitSteps/);
    expect(() => resolveClmConfig({ maxWaitSteps: 1.5 })).toThrow(/maxWaitSteps/);
    expect(() => resolveClmConfig({ overflowMaxWaitSteps: -1 })).toThrow(/overflowMaxWaitSteps/);
  });

  it("rejects out-of-range reduction ratios", () => {
    expect(() => resolveClmConfig({ targetReductionRatio: 0 })).toThrow(/targetReductionRatio/);
    expect(() => resolveClmConfig({ targetReductionRatio: 1 })).toThrow(/targetReductionRatio/);
    expect(() => resolveClmConfig({ targetReductionRatio: Number.NaN })).toThrow(/targetReductionRatio/);
  });

  it("rejects unknown enum values", () => {
    expect(() => resolveClmConfig({ fallback: "sometimes" as never })).toThrow(/fallback/);
    expect(() => resolveClmConfig({ manual: "maybe" as never })).toThrow(/manual/);
  });

  it("freezes the resolved config", () => {
    expect(Object.isFrozen(resolveClmConfig({}))).toBe(true);
  });
});

describe("ClmCompactionEngine statics", () => {
  it("reuses basic's Config schema and inject list", () => {
    expect(typeof ClmCompactionEngine.Config).toBe("function");
    expect(ClmCompactionEngine.inject).toEqual(["llm", "tokenMeter", "sessions"]);
  });

  it("lets CLM keys through the schema while validating basic fields", () => {
    const validate = ClmCompactionEngine.Config as unknown as (value: unknown) => unknown;
    const out = validate({ maxWaitSteps: 5, fallback: "off", thresholdRatio: 0.7 }) as Record<string, unknown>;
    expect(out.maxWaitSteps).toBe(5);
    expect(out.fallback).toBe("off");
    expect(out.thresholdRatio).toBe(0.7);
    // The schema validates field shapes; semantic cross-checks (ratio vs
    // retention) live in basic's resolveConfig, exercised via the constructor.
    expect(() => validate({ thresholdRatio: "high" })).toThrow();
  });
});
