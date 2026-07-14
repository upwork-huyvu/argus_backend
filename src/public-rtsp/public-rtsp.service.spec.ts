import { BadRequestException } from "@nestjs/common";
import { PublicRtspService } from "./public-rtsp.service";

/**
 * Drone cam is a system feature surfaced through the DJI bridge / deployment
 * fixture, never through the user-mutable public-rtsp table. This spec pins
 * the BE guard so a malicious or buggy client cannot register a camera under
 * a reserved id (drone, system, drone:*, etc.) and side-step the FE
 * "cannot edit or delete" affordance.
 */
describe("PublicRtspService.parseByDeployment — reserved drone cam ids", () => {
  // The parser is private; reach it via the prototype to avoid wiring up the
  // SupabaseService dependency for a pure validation test.
  const parse = (
    PublicRtspService.prototype as unknown as {
      parseByDeployment: (raw: Record<string, unknown>) => unknown;
    }
  ).parseByDeployment.bind({});

  const okEntry = (over: Partial<{ id: string; name: string; url: string }> = {}) => ({
    id: over.id ?? "cam-123",
    name: over.name ?? "Public Cam",
    url: over.url ?? "rtsp://10.0.0.1:8554/live",
  });

  it("accepts a valid public camera entry under a known deployment", () => {
    expect(() =>
      parse({ construction: [okEntry({ id: "abc-1" })] }),
    ).not.toThrow();
  });

  it.each([
    "drone",
    "DRONE",
    "Drone",
    "drone-cam",
    "DroneCam",
    "system",
    "system-drone",
    "drone:primary",
    "system:fpv",
  ])("rejects reserved camera id %s", (id) => {
    expect(() =>
      parse({ construction: [okEntry({ id })] }),
    ).toThrow(BadRequestException);
  });

  it("rejects entries without a recognised URL scheme", () => {
    expect(() =>
      parse({ construction: [okEntry({ url: "ftp://10.0.0.1/live" })] }),
    ).toThrow(BadRequestException);
  });

  it("rejects entries missing required fields", () => {
    expect(() =>
      parse({ construction: [okEntry({ id: "" })] }),
    ).toThrow(BadRequestException);
    expect(() =>
      parse({ construction: [okEntry({ name: "" })] }),
    ).toThrow(BadRequestException);
    expect(() =>
      parse({ construction: [okEntry({ url: "" })] }),
    ).toThrow(BadRequestException);
  });

  it("rejects unknown deployment ids", () => {
    expect(() => parse({ atlantis: [okEntry()] })).toThrow(BadRequestException);
  });
});
