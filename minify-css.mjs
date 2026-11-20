/**
 * Release-build CSS minifier (used by rollup.config.js). Kept in its own module so
 * tests/tests/unit/minify-css.test.ts can check it: a minifier bug only shows in
 * release builds (0.18.1/0.18.2 shipped "calc(a+b)", which browsers reject).
 *
 * Rules:
 * - Quoted strings (content: " · ", url("a b")) are copied as they are.
 * - Comments go, runs of whitespace become one space.
 * - Spaces around { } ; , > ~ and after ":" go.
 * - A space BEFORE ":" stays: in a selector ".a :hover" (any hovered descendant)
 *   is not ".a:hover" (the element itself). In a declaration it is harmless.
 * - Spaces around "+" and "-" stay: calc() needs them.
 */
export function minifyCss(css) {
    const strings = [];
    const masked = css
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (s) => {
            strings.push(s);
            return `\u0000${strings.length - 1}\u0000`;
        });
    const out = masked
        .replace(/\s+/g, " ")
        .replace(/\s*([{};,>~])\s*/g, "$1")
        // ":" loses only the space after it (" :hover" in a selector must keep its space)
        .replace(/:\s+/g, ":")
        .replace(/;}/g, "}")
        .trim();
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => strings[Number(i)]);
}
