/** Types for the parts of signalsmith-stretch (which ships none) that the engine uses. See its README. */
declare module "signalsmith-stretch" {
  export type StretchChange = {
    /** Audio context time the change applies at; the node compensates for its own latency. */
    output?: number
    active?: boolean
    /** Position in the loaded buffers, in seconds. */
    input?: number
    rate?: number
    semitones?: number
    tonalityHz?: number
    formantSemitones?: number
    formantCompensation?: boolean
    formantBaseHz?: number
    /** Loop section of the loaded buffers; disabled when both are equal. */
    loopStart?: number
    loopEnd?: number
  }

  export interface StretchNode extends AudioWorkletNode {
    schedule(change: StretchChange): Promise<unknown>
    stop(when?: number): Promise<unknown>
    /** Appends one equal-length array per channel; the optional list is transferred instead of copied. */
    addBuffers(channels: Float32Array[], transfer?: Transferable[]): Promise<number>
    /** Seconds to schedule ahead so a change is fully compensated. */
    latency(): Promise<number>
  }

  export default function SignalsmithStretch(context: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>
}
