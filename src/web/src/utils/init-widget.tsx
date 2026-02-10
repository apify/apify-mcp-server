import "../index.css";
import React from "react";
import { UiDependencyProvider } from "@apify/ui-library";
import { tokens as lightCssVariables } from "@apify/ui-library/dist/src/design_system/colors/generated/css_variables.light.js";
import { tokens as darkCssVariables } from "@apify/ui-library/dist/src/design_system/colors/generated/css_variables.dark.js";
import { ThemeProvider } from "styled-components";
import { createRoot } from "react-dom/client";

function resolveTheme(): "light" | "dark" {
    const t = window.openai?.theme;
    if (t === "dark") return "dark";
    if (t === "light") return "light";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: "light" | "dark") {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
}

export const renderWidget = (Component: React.FC) => {
    const initWidget = () => {
        const rootElement = document.getElementById("root");
        if (!rootElement) return;

        applyTheme(resolveTheme());

        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onSystemThemeChange = (e: MediaQueryListEvent) => {
            const t = window.openai?.theme;
            if (t !== "dark" && t !== "light") {
                applyTheme(e.matches ? "dark" : "light");
            }
        };
        mq.addEventListener("change", onSystemThemeChange);

        let lastTheme = resolveTheme();
        const checkTheme = () => {
            const current = resolveTheme();
            if (current !== lastTheme) {
                lastTheme = current;
                applyTheme(current);
            }
        };

        window.setInterval(checkTheme, 1000);

        const root = createRoot(rootElement);

        // Inject fonts and CSS variables for proper styling
        const head = document.head || document.getElementsByTagName("head")[0];
        if (head) {
            // Fonts preconnect + stylesheet
            if (!document.getElementById("apify-fonts-preconnect-1")) {
                const link1 = document.createElement("link");
                link1.id = "apify-fonts-preconnect-1";
                link1.rel = "preconnect";
                link1.href = "https://fonts.googleapis.com";
                head.appendChild(link1);
            }
            if (!document.getElementById("apify-fonts-preconnect-2")) {
                const link2 = document.createElement("link");
                link2.id = "apify-fonts-preconnect-2";
                link2.rel = "preconnect";
                link2.href = "https://fonts.gstatic.com";
                link2.crossOrigin = "anonymous";
                head.appendChild(link2);
            }
            if (!document.getElementById("apify-fonts-stylesheet")) {
                const linkFonts = document.createElement("link");
                linkFonts.id = "apify-fonts-stylesheet";
                linkFonts.rel = "stylesheet";
                linkFonts.href = "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap";
                head.appendChild(linkFonts);
            }

            // CSS variables for light/dark themes
            if (!document.getElementById("apify-css-variables")) {
                const styleLight = document.createElement("style");
                styleLight.id = "apify-css-variables";
                styleLight.textContent = `:root {${lightCssVariables}}`;
                head.appendChild(styleLight);
            }
            if (!document.getElementById("apify-dark-css-variables")) {
                const styleDark = document.createElement("style");
                styleDark.id = "apify-dark-css-variables";
                styleDark.textContent = `:root[data-theme="dark"] { ${darkCssVariables} }`;
                head.appendChild(styleDark);
            }
        }

        const dependencies = {
            InternalLink: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; replace?: boolean }>(
                ({ href, replace, ...rest }, ref) => (
                    // Basic anchor implementation; consumers can enhance as needed
                    <a ref={ref} href={href} {...rest} />
                )
            ),
            InternalImage: React.forwardRef<HTMLImageElement, React.ImgHTMLAttributes<HTMLImageElement>>((props, ref) => (
                <img ref={ref} {...props} />
            )),
            trackClick: (_id: string, _data?: object) => {
                // No-op tracking in widget environment
            },
            windowLocationHost: window.location.host,
            isHrefTrusted: (href: string) => {
                try {
                    const url = new URL(href, window.location.origin);
                    return url.origin === window.location.origin;
                } catch {
                    return href.startsWith("/");
                }
            },
            tooltipSafeHtml: (content: React.ReactNode) => content,
        } as const;

        root.render(
            <React.StrictMode>
                <ThemeProvider theme={{}}>
                    <UiDependencyProvider dependencies={dependencies as any}>
                        <Component />
                    </UiDependencyProvider>
                </ThemeProvider>
            </React.StrictMode>
        );
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initWidget, { once: true });
    } else {
        initWidget();
    }
};
