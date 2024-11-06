const typeByteCounts = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
export default function* splitTiff(input, options) {
    const littleEndian = input[0] === 73; // I
    const inputDataView = new DataView(input.buffer);
    const u16At = (byteOffset) => inputDataView.getUint16(byteOffset, littleEndian);
    const u32At = (byteOffset) => inputDataView.getUint32(byteOffset, littleEndian);
    const firstInputIfdOffset = u32At(4);
    // single image
    if (!u32At(firstInputIfdOffset + 2 + u16At(firstInputIfdOffset) * 12)) {
        yield input;
        return;
    }
    const inputSpan = (offset, length) => input.subarray(offset, offset + length);
    const to2Bytes = littleEndian ? (n) => [n & 255, (n >> 8) & 255] : (n) => [(n >> 8) & 255, n & 255];
    const to4Bytes = littleEndian
        ? (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]
        : (n) => [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    const getIfdUintValues = (ifdEntryOffset) => {
        const typeByteCount = typeByteCounts[u16At(ifdEntryOffset + 2)];
        const valueCount = u32At(ifdEntryOffset + 4);
        const valueOffset = typeByteCount * valueCount > 4 ? u32At(ifdEntryOffset + 8) : ifdEntryOffset + 8;
        const uintAt = typeByteCount === 2 ? u16At : u32At;
        return Array.from({ length: valueCount }, (_, i) => uintAt(valueOffset + i * typeByteCount));
    };
    const remainingInputIfdOffsets = [firstInputIfdOffset];
    const processedInputIfdOffsets = new Set(); // check for circular ifd offsets to avoid infinite loop.
    for (let inputIfdOffset; (inputIfdOffset = remainingInputIfdOffsets.shift());) {
        if (processedInputIfdOffsets.has(inputIfdOffset)) {
            console.warn("split-tiff: circular ifd offset.");
            continue;
        }
        processedInputIfdOffsets.add(inputIfdOffset);
        const ifdEntryCount = u16At(inputIfdOffset);
        const ifdByteCount = /* entry count */ 2 + /* entries */ ifdEntryCount * 12 + /* next ifd offset */ 4;
        const inputNextIfdOffsetOffset = inputIfdOffset + ifdByteCount - 4;
        // collect SubIFDs (330), (StripOffsets (273) and StripByteCounts (279)) or (TileOffsets (324) and TileByteCounts(325))
        // count bytes of values over 4 bytes
        const inputTags = {};
        let ifdValuesOver4BytesTotalByteCount = 0;
        for (let inputOffset = inputIfdOffset + 2; inputOffset < inputNextIfdOffsetOffset; inputOffset += 12) {
            const tagId = u16At(inputOffset);
            const valuesByteCount = (tagId === 273 ? 4 : typeByteCounts[u16At(inputOffset + 2)]) * u32At(inputOffset + 4);
            if (tagId === 254 || tagId === 255) {
                // ignore NewSubfileType or SubfileType
            }
            else if (tagId === 330) {
                options?.subIfds && remainingInputIfdOffsets.push(...getIfdUintValues(inputOffset));
            }
            else {
                if (valuesByteCount > 4) {
                    ifdValuesOver4BytesTotalByteCount += valuesByteCount;
                }
                if (tagId === 273 || tagId === 279 || tagId === 324 || tagId === 325) {
                    inputTags[tagId] = getIfdUintValues(inputOffset);
                }
            }
        }
        const { 273: stripOffsets, 279: stripByteCounts, 324: tileOffsets, 325: tileByteCounts } = inputTags;
        if (stripOffsets?.length !== stripByteCounts?.length) {
            console.warn("split-tiff: StripOffsets and StripByteCounts are different lengths.");
            continue;
        }
        if (tileOffsets?.length !== tileByteCounts?.length) {
            console.warn("split-tiff: TileOffsets and TileByteCounts are different lengths.");
            continue;
        }
        if (stripByteCounts?.length || tileByteCounts?.length) {
            const totalStripByteCount = stripByteCounts?.reduce((x, y) => x + y, 0) ?? 0;
            const totalTileByteCount = tileByteCounts?.reduce((x, y) => x + y, 0) ?? 0;
            const output = new Uint8Array(8 + ifdByteCount + ifdValuesOver4BytesTotalByteCount + totalStripByteCount + totalTileByteCount);
            let outputCursor = 0;
            let outputValuesOver4BytesCursor = 8 + ifdByteCount;
            const append = (uint8Array) => {
                output.set(uint8Array, outputCursor);
                outputCursor += uint8Array.length;
            };
            const appendValuesOver4Bytes = (uint8Array) => {
                append(to4Bytes(outputValuesOver4BytesCursor));
                output.set(uint8Array, outputValuesOver4BytesCursor);
                outputValuesOver4BytesCursor += uint8Array.length;
            };
            append(inputSpan(0, 4)); // byte order + magic number
            append(to4Bytes(8)); // first ifd offset
            append(inputSpan(inputIfdOffset, 2)); // ifd entry count
            // ifd
            for (let inputOffset = inputIfdOffset + 2; inputOffset < inputNextIfdOffsetOffset; inputOffset += 12) {
                const tagId = u16At(inputOffset);
                const typeByteCount = typeByteCounts[u16At(inputOffset + 2)];
                const valuesByteCount = typeByteCount * u32At(inputOffset + 4);
                if (tagId === 254 || tagId === 255 || tagId === 330) {
                    // NewSubfileType, SubfileType or SubIFDs
                }
                else if (tagId === 273 || tagId === 324) {
                    const imageByteCounts = inputTags[tagId === 273 ? 279 : 325] ?? [];
                    const outputImageOffsets = [];
                    let outputImageOffset = 8 + ifdByteCount + ifdValuesOver4BytesTotalByteCount + (tagId === 324 ? totalStripByteCount : 0);
                    for (const imageDataCount of imageByteCounts) {
                        outputImageOffsets.push(...to4Bytes(outputImageOffset));
                        outputImageOffset += imageDataCount;
                    }
                    append(to2Bytes(tagId));
                    append(to2Bytes(4));
                    append(to4Bytes(imageByteCounts.length));
                    outputImageOffsets.length > 4 ? appendValuesOver4Bytes(outputImageOffsets) : append(outputImageOffsets);
                }
                else if (valuesByteCount > 4) {
                    append(inputSpan(inputOffset, 8));
                    appendValuesOver4Bytes(inputSpan(u32At(inputOffset + 8), valuesByteCount));
                }
                else {
                    append(inputSpan(inputOffset, 12));
                }
            }
            // image data
            outputCursor = 8 + ifdByteCount + ifdValuesOver4BytesTotalByteCount;
            if (stripOffsets && stripByteCounts) {
                for (let i = 0; i < stripByteCounts.length; i++) {
                    append(inputSpan(stripOffsets[i], stripByteCounts[i]));
                }
            }
            if (tileOffsets && tileByteCounts) {
                for (let i = 0; i < tileByteCounts.length; i++) {
                    append(inputSpan(tileOffsets[i], tileByteCounts[i]));
                }
            }
            yield output;
        }
        const inputNextIfdOffset = u32At(inputNextIfdOffsetOffset);
        inputNextIfdOffset && remainingInputIfdOffsets.push(inputNextIfdOffset);
    }
}
