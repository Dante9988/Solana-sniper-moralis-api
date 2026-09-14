import { describe, expect, it } from "vitest";

import { isForbiddenAddress, planImageFetch, sniffImage } from "../imageSafety";
import { ImageFetchError, fetchImageBytes } from "../safeImageFetch";

const CID_V0 = "QmQERNaZyRoUuFLPXQmSz3zwhkdqWcQTp44oRNdVUugnRc";
const CID_V1 = "bafybeidi2k64tdu7i6l72bzp6dfc2prqnris7krg2hmvgyuyihxzjfsyda";

describe("planImageFetch — logo URLs as actually recorded by Pons launches", () => {
  it.each([
    [`ipfs://${CID_V0}`, { kind: "ipfs", path: CID_V0 }],
    [`ipfs://${CID_V1}`, { kind: "ipfs", path: CID_V1 }],
    [`ipfs://ipfs/${CID_V1}/logo.png`, { kind: "ipfs", path: `${CID_V1}/logo.png` }],
    [CID_V1, { kind: "ipfs", path: CID_V1 }],
    // Launchers paste whichever gateway they used; the CID is fetched through OUR gateways.
    [`https://silver-passive-tortoise-619.mypinata.cloud/ipfs/${CID_V1}`, { kind: "ipfs", path: CID_V1 }],
    [`https://${CID_V1}.ipfs.dweb.link/`, { kind: "ipfs", path: CID_V1 }],
    ["https://example.com/logo.png", { kind: "https", url: "https://example.com/logo.png" }],
  ])("%s", (input, expected) => {
    expect(planImageFetch(input)).toEqual(expected);
  });

  it.each([
    ["http://example.com/logo.png", /protocol http:/],
    ["javascript:alert(1)", /protocol javascript:/],
    ["data:image/svg+xml;base64,PHN2Zz4=", /protocol data:/],
    ["file:///etc/passwd", /protocol file:/],
    ["https://127.0.0.1/logo.png", /IP-literal/],
    ["https://[::1]/logo.png", /IP-literal/],
    ["https://user:pass@example.com/x.png", /credentials/],
    ["https://example.com:8443/x.png", /port/],
    [`ipfs://${CID_V1}/../../etc`, /malformed/],
    ["ipfs://not-a-cid", /malformed/],
    ["", /no logo/],
  ])("rejects %s", (input, reason) => {
    const plan = planImageFetch(input);
    expect(plan.kind).toBe("rejected");
    expect((plan as { reason: string }).reason).toMatch(reason);
  });
});

describe("isForbiddenAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not-an-ip",
  ])("refuses %s", (address) => expect(isForbiddenAddress(address)).toBe(true));

  it.each(["8.8.8.8", "104.16.0.1", "2606:4700::6810:1"])("allows public %s", (address) => expect(isForbiddenAddress(address)).toBe(false));
});

describe("sniffImage trusts bytes, not labels", () => {
  it("recognises the four allowed formats", () => {
    expect(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(new TextEncoder().encode("GIF89a...."))).toBe("image/gif");
    expect(sniffImage(new TextEncoder().encode("RIFF    WEBPVP8 "))).toBe("image/webp");
  });

  it("refuses SVG and HTML whatever the server claims", () => {
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<!doctype html><html></html>"))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe("fetchImageBytes checks the address the socket will actually use", () => {
  it("refuses a public-looking host that resolves to an internal address", async () => {
    const err = await fetchImageBytes("https://images.example.test/logo.png", {
      lookup: (_host, cb) => cb(null, [{ address: "169.254.169.254", family: 4 }]),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageFetchError);
    expect(err.message).toMatch(/forbidden address/);
    expect(err.permanent).toBe(true);
  });

  it("refuses a mixed public/internal DNS answer, the classic rebinding setup", async () => {
    const err = await fetchImageBytes("https://images.example.test/logo.png", {
      lookup: (_host, cb) =>
        cb(null, [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ]),
    }).catch((e) => e);
    expect(err.message).toMatch(/forbidden address/);
  });
});
