/**
 * Custom 3-way line encoding to ensure ALL unique lines from Base, Local, and Remote
 * represent correctly in the character-based diff.
 */
export function linesToChars3(
    text1: string,
    text2: string,
    text3: string,
): {
    chars1: string;
    chars2: string;
    chars3: string;
    lineArray: string[];
} {
    const lineArray: string[] = [];
    const lineHash: { [key: string]: number } = {};

    const encode = (text: string) => {
        let chars = "";
        let lineStart = 0;
        let lineEnd = -1;
        while (lineEnd < text.length - 1) {
            lineEnd = text.indexOf("\n", lineStart);
            if (lineEnd == -1) {
                lineEnd = text.length - 1;
            }
            const line = text.substring(lineStart, lineEnd + 1);

            if (Object.prototype.hasOwnProperty.call(lineHash, line)) {
                chars += String.fromCharCode(lineHash[line]);
            } else {
                const i = lineArray.length;
                lineHash[line] = i;
                lineArray.push(line);
                chars += String.fromCharCode(i);
            }
            lineStart = lineEnd + 1;
        }
        return chars;
    };

    const chars1 = encode(text1);
    const chars2 = encode(text2);
    const chars3 = encode(text3);

    return { chars1, chars2, chars3, lineArray };
}
