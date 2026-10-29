import { describe, expect, it } from "vitest"
import { HQ_MODEL, isHighQuality, retryModel } from "@/lib/api"

describe("models", () => {
  it("retries songs from the retired htdemucs_ft with the current high quality model", () => {
    expect(retryModel("htdemucs_ft")).toBe(HQ_MODEL)
    expect(retryModel("htdemucs")).toBe("htdemucs")
    expect(retryModel("scnet_xl_ihf")).toBe("scnet_xl_ihf")
  })

  it("counts both high quality models as high quality", () => {
    expect(isHighQuality("htdemucs_ft")).toBe(true)
    expect(isHighQuality(HQ_MODEL)).toBe(true)
    expect(isHighQuality("htdemucs")).toBe(false)
  })
})
