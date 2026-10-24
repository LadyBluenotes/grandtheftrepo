import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  deviceStreamBaseUrl,
  deviceStreamDocument,
  deviceStreamMessage,
} from "./device-stream-document";

describe("native device stream document", () => {
  it.each([
    ["android", "ios", "http://192.168.1.10:3773/api/device-hub", "http://192.168.1.10:3773/"],
    ["android", "ios", "https://env.example/t3/api/device-hub", "https://env.example/"],
    ["android", "android", "http://192.168.1.10:3773/api/device-hub", "https://localhost/"],
    ["ios", "ios", "http://192.168.1.10:3773/api/device-hub", "file:///"],
  ] as const)(
    "uses a %s viewer base URL for %s targets on %s",
    (viewer, target, httpBase, expected) => {
      expect(deviceStreamBaseUrl(viewer, target, httpBase)).toBe(expected);
    },
  );

  it("keeps ticket and device values from terminating the embedded script", () => {
    const deviceId = '</script><script>alert("device")</script>';
    const configuration = JSON.stringify({ deviceId, ticket: "<ticket>" });
    const html = deviceStreamDocument(
      configuration,
      "var T3DeviceStream={start(input){return input}};",
    );
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(html.match(/<script>/g)).toHaveLength(1);
    const input: unknown = NodeVM.runInNewContext(script!, { window: { addEventListener() {} } });
    expect(input).toEqual({ deviceId, ticket: "<ticket>" });
  });

  it("reports a bootstrap exception to the native recovery UI", () => {
    const postMessage = vi.fn();
    const html = deviceStreamDocument(
      "{}",
      'var T3DeviceStream={start(){throw new Error("startup")}};',
    );
    NodeVM.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)![1]!, {
      window: { addEventListener() {}, ReactNativeWebView: { postMessage } },
    });
    expect(JSON.parse(postMessage.mock.calls[0]![0] as string)).toEqual({
      type: "status",
      status: "error",
      detail: "Device viewer stopped unexpectedly.",
    });
  });
});

describe("native device stream messages", () => {
  it.each([
    "invalid JSON",
    "null",
    '"input"',
    "{}",
    '{"type":"input","connected":"yes"}',
    '{"type":"unknown"}',
    '{"type":"status","status":"unknown"}',
    '{"type":"status","status":"error","detail":42}',
    '{"type":"status"}',
  ])("ignores invalid bridge messages: %s", (data) => expect(deviceStreamMessage(data)).toBeNull());
});
