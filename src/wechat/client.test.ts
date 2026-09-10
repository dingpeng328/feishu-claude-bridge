import { describe, expect, it } from "vitest";
import { _splitText } from "./client.js";

describe("WeChat outbound text", () => {
  it("splits by Unicode code points", () => {
    expect(_splitText("甲乙丙丁", 3)).toEqual(["甲乙丙", "丁"]);
    expect(_splitText("😀😀", 1)).toEqual(["😀", "😀"]);
  });
});
