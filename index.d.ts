export interface SplitTiffOptions {
    readonly subIfds?: boolean;
}
export default function splitTiff(input: Uint8Array, options?: SplitTiffOptions): Generator<Uint8Array>;
