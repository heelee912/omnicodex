import { describe, expect, it } from "vitest";
import { omitBlankOptionalNativeSettingOverrides } from "../src/application/native-tool-argument-normalizer.js";

describe("omitBlankOptionalNativeSettingOverrides", () => {
  it("omits blank optional native setting overrides without changing other arguments", () => {
    const argumentsValue = {
      prompt: "continue",
      model: "  ",
      modelProvider: "\t",
      thinking: "",
      title: "",
    };

    expect(
      omitBlankOptionalNativeSettingOverrides(
        {
          type: "object",
          properties: {
            prompt: { type: "string" },
            model: { type: "string" },
            modelProvider: { type: "string" },
            thinking: { type: "string" },
            title: { type: "string" },
          },
          required: ["prompt"],
        },
        argumentsValue,
      ),
    ).toEqual({ prompt: "continue", title: "" });
    expect(argumentsValue).toHaveProperty("model", "  ");
  });

  it("preserves blank required fields and unknown future fields", () => {
    const argumentsValue = { model: "", futureSetting: "" };

    expect(
      omitBlankOptionalNativeSettingOverrides(
        {
          type: "object",
          properties: {
            model: { type: "string" },
            futureSetting: { type: "string" },
          },
          required: ["model"],
        },
        argumentsValue,
      ),
    ).toBe(argumentsValue);
  });

  it("resolves local refs and union variants before deciding optionality", () => {
    const schema = {
      $ref: "#/$defs/Input",
      $defs: {
        Input: {
          oneOf: [
            {
              type: "object",
              properties: { model: { type: "string" }, prompt: { type: "string" } },
              required: ["prompt"],
            },
            {
              type: "object",
              properties: { model: { type: "string" }, target: { type: "string" } },
              required: ["target"],
            },
          ],
        },
      },
    };

    expect(omitBlankOptionalNativeSettingOverrides(schema, { model: " ", prompt: "x" })).toEqual({
      prompt: "x",
    });
  });

  it("merges root properties with required-only union branches", () => {
    const optionalAcrossBranches = {
      type: "object",
      properties: {
        model: { type: "string" },
        prompt: { type: "string" },
        target: { type: "string" },
      },
      oneOf: [{ required: ["prompt"] }, { required: ["target"] }],
    };
    expect(
      omitBlankOptionalNativeSettingOverrides(optionalAcrossBranches, {
        model: " ",
        prompt: "continue",
      }),
    ).toEqual({ prompt: "continue" });

    const requiredInOneBranch = {
      ...optionalAcrossBranches,
      anyOf: [{ required: ["model"] }, { required: ["target"] }],
    };
    const requiredArguments = { model: "", prompt: "continue" };
    expect(omitBlankOptionalNativeSettingOverrides(requiredInOneBranch, requiredArguments)).toBe(
      requiredArguments,
    );
  });

  it("combines referenced, sibling, and allOf object contracts", () => {
    const schema = {
      $ref: "#/$defs/Settings",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      allOf: [{ properties: { reasoningEffort: { type: "string" } } }],
      $defs: {
        Settings: {
          type: "object",
          properties: { model: { type: "string" } },
        },
      },
    };

    expect(
      omitBlankOptionalNativeSettingOverrides(schema, {
        prompt: "continue",
        model: " ",
        reasoningEffort: "\t",
      }),
    ).toEqual({ prompt: "continue" });
  });
});
