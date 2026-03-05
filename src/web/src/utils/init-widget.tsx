import "../index.css";
import React, { useEffect } from "react";
import { UiDependencyProvider } from "@apify/ui-library";
import { cssColorsVariablesLight, cssColorsVariablesDark } from "@apify/ui-library";
import { ThemeProvider } from "styled-components";
import { createRoot } from "react-dom/client";
import { McpAppProvider, useMcpApp } from "../context/mcp-app-context";

function applyTheme(theme: "light" | "dark") {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
}

function resolveSystemTheme(): "light" | "dark" {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Syncs the document theme from MCP host context, falling back to system preference.
 */
const ThemeSync: React.FC = () => {
    const { hostContext } = useMcpApp();

    useEffect(() => {
        const hostTheme = hostContext?.theme;
        if (hostTheme === "dark" || hostTheme === "light") {
            applyTheme(hostTheme);
        } else {
            applyTheme(resolveSystemTheme());
        }
    }, [hostContext?.theme]);

    // Also listen for system theme changes when host doesn't specify a theme
    useEffect(() => {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const handler = (e: MediaQueryListEvent) => {
            const hostTheme = hostContext?.theme;
            if (hostTheme !== "dark" && hostTheme !== "light") {
                applyTheme(e.matches ? "dark" : "light");
            }
        };
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener("change", handler);
    }, [hostContext?.theme]);

    return null;
};

/**
 * Helper to create and inject a link or style element if it doesn't already exist.
 */
function injectElement<K extends "link" | "style">(
    id: string,
    tagName: K,
    attributes: Partial<HTMLElementTagNameMap[K]>
): void {
    if (document.getElementById(id)) {
        return;
    }

    const element = document.createElement(tagName);
    element.id = id;

    Object.entries(attributes).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
            element[key as keyof HTMLElementTagNameMap[K]] = value;
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

    // Inject base font size so 1rem = 10px in the iframe
    injectElement("apify-base-font-size", "style", {
        textContent: `html, :root { font-size: 10px !important; }`,
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

        applyTheme(resolveSystemTheme());

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
            generateProxyImageUrl: (url: string) => url,
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
                        <McpAppProvider>
                            <ThemeSync />
                            <Component />
                        </McpAppProvider>
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
