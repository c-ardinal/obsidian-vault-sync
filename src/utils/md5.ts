/**
 * MD5 implementation for ArrayBuffer.
 * Adapted from standard algorithms.
 */

export function md5(data: ArrayBuffer): string {
    const input = new Uint8Array(data);
    let length = input.length;

    // Constants
    const k = new Uint32Array([
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
        0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
        0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ]);

    const r = new Uint32Array([
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ]);

    // Padding
    const paddingLength = length % 64 < 56 ? 56 - (length % 64) : 120 - (length % 64);
    const totalLength = length + paddingLength + 8;
    const buffer = new Uint8Array(totalLength);
    buffer.set(input);
    buffer[length] = 0x80;

    // Length in bits
    // Length in bits
    const lengthBits = length * 8;
    // Split into two 32-bit words (little-endian: low word first, then high word)
    const lowDocs = lengthBits >>> 0;
    const highDocs = Math.floor(lengthBits / 4294967296);

    const view = new DataView(buffer.buffer);
    view.setUint32(totalLength - 8, lowDocs, true); // Low 32 bits
    view.setUint32(totalLength - 4, highDocs, true); // High 32 bits

    // Initial hash
    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;

    // Process chunks
    for (let i = 0; i < totalLength; i += 64) {
        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;

        const chunk = new Uint32Array(buffer.buffer, i, 16); // Little-endian by default on most systems?
        // Need to ensure little-endian interpretation of words
        // Uint32Array uses system endianness. WebAssembly/modern JS usually run on LE.
        // But to be safe, let's manual load or use DataView if we were pedantic.
        // For simplicity assuming LE (standard for most client devices).

        for (let j = 0; j < 64; j++) {
            let f, g;
            if (j < 16) {
                f = (b & c) | (~b & d);
                g = j;
            } else if (j < 32) {
                f = (d & b) | (~d & c);
                g = (5 * j + 1) % 16;
            } else if (j < 48) {
                f = b ^ c ^ d;
                g = (3 * j + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * j) % 16;
            }

            f = (f + a + k[j] + chunk[g]) >>> 0;
            const temp = d;
            d = c;
            c = b;
            b = (b + ((f << r[j]) | (f >>> (32 - r[j])))) >>> 0;
            a = temp;
        }

        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
    }

    // Output hex
    return [h0, h1, h2, h3]
        .map((h) => {
            // Swap endianness for output string? MD5 output is usually byte-order.
            // The standard MD5 "string" is hex of the bytes in order.
            // Our h0..h3 are 32-bit integers.
            // h0 is A, h1 is B...
            // We need to output bytes of A, then B.. in memory order (Little Endian).
            let hex = "";
            for (let b = 0; b < 4; b++) {
                hex += ((h >>> (b * 8)) & 0xff).toString(16).padStart(2, "0");
            }
            return hex;
        })
        .join("");
}
