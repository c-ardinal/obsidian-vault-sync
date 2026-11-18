/** Name rules for the cloud root folder: no leading "/", no "\\" and no reserved characters. */
export function isValidCloudRootFolder(name: string): boolean {
    return (
        name.length > 0 &&
        name.length <= 255 &&
        !name.startsWith("/") &&
        !name.includes("\\") &&
        !/[<>:"|?*]/.test(name)
    );
}
