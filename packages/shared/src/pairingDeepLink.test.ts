import { describe, expect, it } from "vite-plus/test";

import {
  buildMobilePairingDeepLink,
  isMobilePairingDeepLink,
  unwrapMobilePairingDeepLink,
} from "./pairingDeepLink.js";

describe("buildMobilePairingDeepLink", () => {
  it("wraps a web pairing url in the default t3code scheme", () => {
    expect(buildMobilePairingDeepLink("https://remote.example.com/pair#token=pairing-token")).toBe(
      "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
    );
  });

  it("encodes the embedded hash fragment correctly", () => {
    expect(buildMobilePairingDeepLink("https://h:1/pair#token=ABC/+DEF=")).toBe(
      "t3code://pair?pairingUrl=https%3A%2F%2Fh%3A1%2Fpair%23token%3DABC%2F%2BDEF%3D",
    );
  });

  it("honors a custom scheme", () => {
    expect(buildMobilePairingDeepLink("https://h/pair#token=x", "t3code-dev")).toBe(
      "t3code-dev://pair?pairingUrl=https%3A%2F%2Fh%2Fpair%23token%3Dx",
    );
  });

  it("returns empty string for empty input", () => {
    expect(buildMobilePairingDeepLink("")).toBe("");
    expect(buildMobilePairingDeepLink("   ")).toBe("");
  });
});

describe("isMobilePairingDeepLink", () => {
  it("matches the t3code family schemes", () => {
    expect(isMobilePairingDeepLink("t3code://pair?pairingUrl=x")).toBe(true);
    expect(isMobilePairingDeepLink("t3code-dev://pair?pairingUrl=x")).toBe(true);
    expect(isMobilePairingDeepLink("t3code-preview://pair?pairingUrl=x")).toBe(true);
  });

  it("rejects web urls and garbage", () => {
    expect(isMobilePairingDeepLink("https://remote/pair#token=x")).toBe(false);
    expect(isMobilePairingDeepLink("not a url")).toBe(false);
    expect(isMobilePairingDeepLink("")).toBe(false);
  });
});

describe("unwrapMobilePairingDeepLink", () => {
  it("extracts the inner pairing url from a t3code deep link", () => {
    expect(
      unwrapMobilePairingDeepLink(
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3DABC",
      ),
    ).toBe("https://remote.example.com/pair#token=ABC");
  });

  it("passes a raw web url through unchanged", () => {
    expect(unwrapMobilePairingDeepLink("https://remote/pair#token=x")).toBe(
      "https://remote/pair#token=x",
    );
  });

  it("passes empty string through unchanged", () => {
    expect(unwrapMobilePairingDeepLink("")).toBe("");
  });
});
