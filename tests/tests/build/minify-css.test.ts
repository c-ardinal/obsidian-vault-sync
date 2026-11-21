import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
// @ts-expect-error plain ESM build helper without type declarations
import { minifyCss } from "../../../minify-css.mjs";

const min = (css: string): string => minifyCss(css);

describe("release CSS minifier", () => {
    it("drops comments and needless whitespace", () => {
        expect(min("/* c */\n.a  {\n  color : red ;\n  margin: 0 ;\n}\n")).toBe(".a{color :red;margin:0}");
    });

    it("keeps the spaces calc() needs around + and -", () => {
        expect(min(".a { width: calc(100% - 2 * var(--x)); top: calc(var(--a) + env(safe-area-inset-top)); }")).toBe(
            ".a{width:calc(100% - 2 * var(--x));top:calc(var(--a) + env(safe-area-inset-top))}",
        );
    });

    it("keeps a descendant pseudo-class apart from its parent selector", () => {
        // ".a :hover" = any hovered element inside .a; ".a:hover" = .a itself
        expect(min(".a :hover { color: red; }")).toBe(".a :hover{color:red}");
        expect(min(".a :is(.b, .c) > .d { x: y; }")).toBe(".a :is(.b,.c)>.d{x:y}");
    });

    it("copies quoted strings unchanged", () => {
        expect(min('.a::after { content: "  ·  { ; } "; }')).toBe('.a::after{content:"  ·  { ; } "}');
        expect(min(".b { background: url('a  b.png'); }")).toBe(".b{background:url('a  b.png')}");
    });

    it("keeps media query conditions intact", () => {
        expect(min("@media (max-width: 600px) and (hover: none) {\n .a { b: c; }\n}")).toBe(
            "@media (max-width:600px) and (hover:none){.a{b:c}}",
        );
    });

    it("leaves the plugin stylesheet's calc() expressions and rule count intact", () => {
        const raw = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        const out = min(raw);
        const calcs = (css: string) => (css.match(/calc\((?:[^()]|\([^()]*\))*\)/g) ?? []).map((c) => c.replace(/\s+/g, " ").replace(/\s*,\s*/g, ","));
        expect(calcs(out)).toEqual(calcs(raw));
        expect(out.split("{").length).toBe(raw.split("{").length);
        expect(out.split("}").length).toBe(raw.split("}").length);
    });
});
