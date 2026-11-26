/* Vault Syncer -shared page behaviour.
 * Loaded in <head> without defer so the `pagereveal` listener is in place
 * before the first render of a cross-document view transition. */
(function () {
    // --- Page transitions -------------------------------------------------
    // Top page -> legal page: the new page slides in from the right.
    // Legal page -> top page: the legal page slides out to the right.
    // The CSS only enables this in browsers that support cross-document
    // view transitions and when the visitor has not asked for reduced motion.
    function isLegal(url) {
        return /\/(tos|privacy)(\/|\/index\.html)?$/.test(new URL(url, location.href).pathname);
    }

    function fromUrl() {
        try {
            var a = window.navigation && navigation.activation;
            if (a && a.from && a.from.url) return a.from.url;
        } catch (e) {}
        return document.referrer || "";
    }

    window.addEventListener("pagereveal", function (e) {
        if (!e.viewTransition) return;
        var from = fromUrl();
        var sameOrigin = from && new URL(from).origin === location.origin;
        var here = isLegal(location.href);
        var there = sameOrigin && isLegal(from);
        var type =
            sameOrigin && here && !there ? "forward" : sameOrigin && !here && there ? "back" : "";
        if (!type) {
            e.viewTransition.skipTransition();
            return;
        }
        e.viewTransition.types.add(type);
        // The slide is the entrance, so skip the page's own fade-in this time.
        document.documentElement.classList.add("vt-arrived");
    });

    // --- Back to top button ----------------------------------------------
    function addBackToTop() {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "to-top";
        btn.innerHTML =
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="m18 15-6-6-6 6"/></svg>';

        function label() {
            var isJa = (document.documentElement.lang || "").indexOf("ja") === 0;
            var t = isJa ? "ページトップへ移動" : "Back to top";
            btn.setAttribute("aria-label", t);
            btn.title = t;
        }
        label();
        // switchLang() updates <html lang>; keep the label in sync.
        new MutationObserver(label).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["lang"],
        });

        btn.addEventListener("click", function () {
            var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
        });
        document.body.appendChild(btn);

        var ticking = false;
        function update() {
            ticking = false;
            var show = window.scrollY > Math.min(480, window.innerHeight * 0.6);
            btn.classList.toggle("is-shown", show);
        }
        window.addEventListener(
            "scroll",
            function () {
                if (!ticking) {
                    ticking = true;
                    requestAnimationFrame(update);
                }
            },
            { passive: true },
        );
        update();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", addBackToTop);
    } else {
        addBackToTop();
    }
})();
