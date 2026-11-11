import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION } from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";

describe("settings control snapshot URL text", () => {
  it("finishes layout reads before replacing click references", () => {
    const events: string[] = [];
    class Button {
      tagName = "BUTTON";
      innerText = "Allow all";
      getBoundingClientRect() {
        events.push("read");
        return { width: 100, height: 20 };
      }
      getAttribute() {
        return null;
      }
      removeAttribute() {
        events.push("remove");
      }
      setAttribute() {
        events.push("write");
      }
    }
    const buttons = [new Button(), new Button()];
    const root = {
      querySelectorAll: (selector: string) => (selector.includes("modal-settings") ? [] : buttons),
      createTreeWalker: () => ({ nextNode: () => null }),
    };
    const capture = runInNewContext(`(${CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION})`, {
      URL,
      HTMLButtonElement: Button,
      HTMLAnchorElement: class {},
      HTMLInputElement: class {},
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    });
    expect(capture.call(root)).toEqual([
      { ref: "oc-0", role: "button", name: "Allow all" },
      { ref: "oc-1", role: "button", name: "Allow all" },
    ]);
    expect(events).toEqual(["read", "read", "remove", "remove", "write", "write"]);
  });

  it("retains visible plain URLs without copying the page or trusting link labels", () => {
    const node = (text: string, hidden = false, excluded = false) => ({
      nodeValue: text,
      parentElement: {
        closest: () => (excluded ? {} : null),
        getBoundingClientRect: () => ({ width: hidden ? 0 : 200, height: 20 }),
      },
    });
    const nodes = [
      node("Server URL: https://mcp.example/mcp/full\nhttps://second.example/mcp"),
      node("https://mcp.example/mcp/full"),
      node("https://hidden.example/mcp", true),
      node("https://link-label.example/mcp", false, true),
      node("Actions and conversation text must not be copied"),
      node("https://"),
    ];
    let index = 0;
    const root = {
      querySelectorAll: () => [],
      createTreeWalker: () => ({ nextNode: () => nodes[index++] ?? null }),
    };
    const capture = runInNewContext(`(${CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION})`, {
      URL,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    });
    expect(capture.call(root)).toEqual([
      { ref: "oc-0", role: "StaticText", name: "https://mcp.example/mcp/full" },
      { ref: "oc-1", role: "StaticText", name: "https://second.example/mcp" },
    ]);
  });
});
