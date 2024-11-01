const typeByteCounts = [, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
export default function* splitTiff(input) {
    const [u16At, u32At, to2Bytes, to4Bytes] = input[0] === 73 // I: little endian
        ? [
            (offset) => input[offset + 1] << 8 | input[offset],
            (offset) => (input[offset + 3] << 24) + (input[offset + 2] << 16 | input[offset + 1] << 8 | input[offset]),
            (n) => [n & 255, n >> 8 & 255],
            (n) => [n & 255, n >> 8 & 255, n >> 16 & 255, n >> 24 & 255],
        ]
        : [
            (offset) => input[offset] << 8 | input[offset + 1],
            (offset) => (input[offset] << 24) + (input[offset + 1] << 16 | input[offset + 2] << 8 | input[offset + 3]),
            (n) => [n >> 8 & 255, n & 255],
            (n) => [n >> 24 & 255, n >> 16 & 255, n >> 8 & 255, n & 255],
        ];
    let inputIfdOffset = u32At(4);
    // single image
    if (!u32At(inputIfdOffset + 2 + u16At(inputIfdOffset) * 12)) {
        yield input;
        return;
    }
    const view = (offset, length) => input.subarray(offset, offset + length);
    const getIfdUintValues = (ifdEntryOffset) => {
        const typeByteCount = typeByteCounts[u16At(ifdEntryOffset + 2)];
        const valueCount = u32At(ifdEntryOffset + 4);
        const valueOffset = typeByteCount * valueCount > 4 ? u32At(ifdEntryOffset + 8) : ifdEntryOffset + 8;
        const uintAt = typeByteCount === 2 ? u16At : u32At;
        return Array.from({ length: valueCount }, (_, i) => uintAt(valueOffset + i * typeByteCount));
    };
    while (inputIfdOffset) {
        const ifdEntryCount = u16At(inputIfdOffset);
        const ifdByteCount = /* entry count */ 2 + /* entries */ ifdEntryCount * 12 + /* next ifd offset */ 4;
        const inputNextIfdOffsetOffset = inputIfdOffset + ifdByteCount - 4;
        // seek image areas, totalize value size
        let inputStripOffsets;
        let stripByteCounts;
        let ifdValuesOver4BytesTotalByteCount = 0;
        for (let inputOffset = inputIfdOffset + 2; inputOffset < inputNextIfdOffsetOffset; inputOffset += 12) {
            const tagId = u16At(inputOffset);
            const valuesByteCount = typeByteCounts[u16At(inputOffset + 2)] * u32At(inputOffset + 4);
            if (valuesByteCount > 4) {
                ifdValuesOver4BytesTotalByteCount += valuesByteCount;
            }
            if (tagId === 273) {
                inputStripOffsets = getIfdUintValues(inputOffset);
            }
            else if (tagId === 279) {
                stripByteCounts = getIfdUintValues(inputOffset);
            }
        }
        if (inputStripOffsets?.length && stripByteCounts?.length) {
            const outputIfdOffset = /* header */ 8 + /* image data */ stripByteCounts.reduce((x, y) => x + y, 0);
            const output = new Uint8Array(outputIfdOffset + ifdByteCount + ifdValuesOver4BytesTotalByteCount);
            let outputCursor = 0;
            let outputValuesOver4BytesCursor = outputIfdOffset + ifdByteCount;
            const append = (uint8Array) => {
                output.set(uint8Array, outputCursor);
                outputCursor += uint8Array.length;
            };
            const appendValuesOver4Bytes = (uint8Array) => {
                append(to4Bytes(outputValuesOver4BytesCursor));
                output.set(uint8Array, outputValuesOver4BytesCursor);
                outputValuesOver4BytesCursor += uint8Array.length;
            };
            append(view(0, 4)); // byte order + magic number
            append(to4Bytes(outputIfdOffset)); // first ifd offset
            for (let i = 0; i < inputStripOffsets.length; i++) {
                append(view(inputStripOffsets[i], stripByteCounts[i])); // image data
            }
            append(view(inputIfdOffset, 2)); // ifd entry count
            // ifd
            for (let inputOffset = inputIfdOffset + 2; inputOffset < inputNextIfdOffsetOffset; inputOffset += 12) {
                const tagId = u16At(inputOffset);
                const typeByteCount = typeByteCounts[u16At(inputOffset + 2)];
                const valuesByteCount = typeByteCount * u32At(inputOffset + 4);
                append(view(inputOffset, 8));
                if (tagId === 273) {
                    const toBytes = typeByteCount === 2 ? to2Bytes : to4Bytes;
                    const outputStripByteCounts = [];
                    for (let i = 0, outputStripOffset = 8; i < stripByteCounts.length; outputStripOffset += stripByteCounts[i++]) {
                        outputStripByteCounts.push(...toBytes(outputStripOffset));
                    }
                    valuesByteCount > 4 ? appendValuesOver4Bytes(outputStripByteCounts) : append(outputStripByteCounts);
                }
                else {
                    valuesByteCount > 4 ? appendValuesOver4Bytes(view(u32At(inputOffset + 8), valuesByteCount)) : append(view(inputOffset + 8, 4));
                }
            }
            yield output;
        }
        inputIfdOffset = u32At(inputNextIfdOffsetOffset);
    }
}
