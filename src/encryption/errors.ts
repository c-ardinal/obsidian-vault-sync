export class DecryptionError extends Error {
    constructor(
        message: string,
        public readonly cause: "authentication" | "format",
        public readonly chunkIndex?: number,
    ) {
        super(message);
        this.name = "DecryptionError";
    }
}
