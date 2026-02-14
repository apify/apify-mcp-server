import "../index.css";
import React from "react";
import { UiDependencyProvider } from "@apify/ui-library";
import { cssColorsVariablesLight, cssColorsVariablesDark } from "@apify/ui-library";
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

/**
 * Helper to create and inject a link or style element if it doesn't already exist.
 */
function injectElement<K extends "link" | "style">(
    id: string,
    tagName: K,
    attributes: Partial<HTMLLinkElement | HTMLStyleElement>
): void {
    if (document.getElementById(id)) {
        return;
    }

    const element = document.createElement(tagName);
    element.id = id;

    // Apply all attributes to the element
    Object.entries(attributes).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
            (element as any)[key] = value;
        }
    });

    // Insert at the beginning of head to allow user styles to override
    if (document.head.firstChild) {
        document.head.insertBefore(element, document.head.firstChild);
    } else {
        document.head.appendChild(element);
    }
}

/**
 * Injects all required stylesheets, fonts, and CSS variables into the document head.
 */
function injectStylesheets(): void {
    // Preconnect to Google Fonts for better performance
    injectElement("apify-fonts-preconnect-1", "link", {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
    });

    injectElement("apify-fonts-preconnect-2", "link", {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
    });

    // Load Google Fonts stylesheet
    injectElement("apify-fonts-stylesheet", "link", {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap",
    });

    // Inject CSS variables
    injectElement("apify-css-variables", "style", {
        textContent: `:root {${cssColorsVariablesLight}}`,
    });
    
    injectElement("apify-dark-css-variables", "style", {
        textContent: `:root[data-theme="dark"] { ${cssColorsVariablesDark} }`,
    });
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

        injectStylesheets();

        const root = createRoot(rootElement);

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
